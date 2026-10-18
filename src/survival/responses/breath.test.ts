import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import prismarineBlock from "prismarine-block";
import { Vec3 } from "vec3";
import { waterFixture } from "../../test-support/water.js";
import { Budgets } from "../state/budgets.js";
import { surface } from "./breath.js";

type Cell = "water" | "air" | "stone";
const registry = minecraftData("1.21.4");
const Block = prismarineBlock("1.21.4");
const SPEED = 0.1;

/**
 * A swimmer in a hand-made world. `seen` is what the bot reads; `physical` is what stops the body (they differ when a
 * block the bot cannot see blocks the way). Controls move the body 0.1 per tick; air refills when the head is in air.
 */
function swimWorld(t: Parameters<typeof waterFixture>[0], seen: (x: number, y: number, z: number) => Cell, start: Vec3, physical = seen) {
  const fixture = waterFixture(t);
  const held = new Set<string>();
  const digs: string[] = [];
  const bot = fixture.bot as unknown as Bot & { oxygenLevel: number };
  const at = (read: typeof seen, p: Vec3) => read(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
  Object.assign(fixture.entity, { position: start.clone(), isInWater: true, width: 0.6, height: 1.8 });
  Object.assign(bot, {
    oxygenLevel: 8,
    health: 20,
    username: "Diver",
    heldItem: null,
    targetDigBlock: null,
    game: { gameMode: "survival" },
    inventory: { items: () => [] },
    equip: async () => {},
    dig: async () => {
      digs.push("roof");
      bot.oxygenLevel = 20;
    },
    blockAt: (p: Vec3) => Block.fromStateId(registry.blocksByName[at(seen, p)]!.defaultState, 0),
    setControlState: (control: string, state: boolean) => (state ? held.add(control) : held.delete(control)),
  });
  const step = () => {
    const p = fixture.entity.position;
    const dy = held.has("jump") ? SPEED : held.has("sneak") ? -SPEED : 0;
    const free = (q: Vec3) => at(physical, q) !== "stone" && at(physical, q.offset(0, 1.79, 0)) !== "stone";
    const sideways = p.offset(((held.has("right") ? 1 : 0) - (held.has("left") ? 1 : 0)) * SPEED, 0, ((held.has("back") ? 1 : 0) - (held.has("forward") ? 1 : 0)) * SPEED);
    if (free(sideways)) fixture.entity.position = sideways;
    const vertical = fixture.entity.position.offset(0, dy, 0);
    if (free(vertical)) fixture.entity.position = vertical;
    const now = fixture.entity.position;
    fixture.entity.isInWater = at(physical, now) === "water";
    if (at(physical, now.offset(0, 1.62, 0)) === "air") bot.oxygenLevel = 20;
  };
  const run = async (ticks: number, maximumTicks = 600) => {
    const done = surface(bot, new AbortController().signal, new Budgets(), maximumTicks);
    let finished = false;
    void done.then(() => { finished = true; }, () => { finished = true; });
    for (let tick = 0; tick < ticks && !finished; tick++) {
      step();
      bot.emit("physicsTick");
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { outcome: await done, position: fixture.entity.position, digs };
  };
  return { run, bot, fixture, digs, held, step };
}

/**
 * Runs `surface` for `ticks` physics ticks with the air held short (a bot that keeps breathing leaves the loop), calls
 * `onTick(tick)` before each, then stops it; returns where the body is.
 */
async function surfaceWithShortAir(world: ReturnType<typeof swimWorld>, ticks: number, onTick: (tick: number) => void) {
  const stop = new AbortController();
  const done = surface(world.bot, stop.signal, new Budgets(), 600).catch(() => undefined);
  for (let tick = 0; tick < ticks; tick++) {
    onTick(tick);
    world.step();
    if (world.digs.length === 0) (world.bot as unknown as { oxygenLevel: number }).oxygenLevel = 8;
    world.bot.emit("physicsTick");
    await new Promise((resolve) => setImmediate(resolve));
  }
  stop.abort();
  await done;
  return world.fixture.entity.position;
}

/** A roofed stream along x (y 0-1), floor below, stone roof at y 2. */
const tunnel = (x: number, y: number, z: number): Cell => (z === 0 && y >= 0 && y <= 1 && x >= -20 && x <= 20 ? "water" : "stone");

test("a roofed stream with an air pocket five cells back: the reflex swims to the pocket and breathes", async (t) => {
  const pocket = (x: number, y: number, z: number): Cell => (x <= -5 && x >= -6 && y === 1 && z === 0 ? "air" : tunnel(x, y, z));
  const world = swimWorld(t, pocket, new Vec3(0.5, 0.2, 0.5));
  const { outcome, position } = await world.run(300);
  assert.equal(outcome.kind, "air_full");
  assert.ok(position.x < -4, `swam west to the pocket, ended at x ${position.x}`);
  assert.deepEqual(world.digs, [], "did not dig when a pocket was in reach");
});

test("a one-wide shaft two cells west going up three reaches air: the way up is followed cell by cell", async (t) => {
  const shaft = (x: number, y: number, z: number): Cell => {
    if (z === 0 && x === -2 && y >= 0 && y <= 3) return "water";
    if (z === 0 && x === -2 && y === 4) return "air";
    return z === 0 && y >= 0 && y <= 1 && x >= -2 && x <= 20 ? "water" : "stone";
  };
  const world = swimWorld(t, shaft, new Vec3(0.5, 0.2, 0.5));
  const { outcome, position } = await world.run(400);
  assert.equal(outcome.kind, "air_full");
  assert.ok(position.y > 2.3, `rose in the shaft, ended at y ${position.y}`);
  assert.deepEqual(world.digs, []);
});

test("a path that stalls on a block the bot cannot see is given up for the next air pocket", async (t) => {
  const seen = (x: number, y: number, z: number): Cell =>
    z === 0 && y === 1 && (x === -4 || x === 6) ? "air" : tunnel(x, y, z);
  // The western way is walled in the physics only: the near pocket cannot be reached.
  const physical = (x: number, y: number, z: number): Cell => (x === -2 && z === 0 && y <= 1 ? "stone" : seen(x, y, z));
  const world = swimWorld(t, seen, new Vec3(0.5, 0.2, 0.5), physical);
  const { outcome, position } = await world.run(900);
  assert.equal(outcome.kind, "air_full");
  assert.ok(position.x > 5, `went to the eastern pocket, ended at x ${position.x}`);
  assert.deepEqual(world.digs, []);
});

test("two stalled paths and no third way: the reflex digs up through the roof", async (t) => {
  const seen = (x: number, y: number, z: number): Cell =>
    z === 0 && y === 1 && (x === -4 || x === 6) ? "air" : tunnel(x, y, z);
  const physical = (x: number, y: number, z: number): Cell =>
    (x === -2 || x === 2) && z === 0 && y <= 1 ? "stone" : seen(x, y, z);
  const world = swimWorld(t, seen, new Vec3(0.5, 0.2, 0.5), physical);
  const { outcome } = await world.run(900);
  assert.equal(outcome.kind, "air_full");
  assert.deepEqual(world.digs, ["roof"]);
});

test("cells that were never loaded are no way to air", async (t) => {
  const world = swimWorld(t, tunnel, new Vec3(0.5, 0.2, 0.5));
  const unloaded = world.bot.blockAt;
  Object.assign(world.bot, { blockAt: (p: Vec3) => (Math.floor(p.x) < -1 ? null : unloaded(p)) });
  const { outcome, digs } = await world.run(300);
  assert.equal(outcome.kind, "air_full");
  assert.deepEqual(digs, ["roof"], "an unknown cell is not passable, so the only way left is up through the roof");
});

test("with the clock stopped the surfacing still ends on the wall clock", async (t) => {
  const world = swimWorld(t, tunnel, new Vec3(0.5, 0.2, 0.5));
  Object.assign(world.bot, { dig: async () => { throw new Error("no dig"); } });
  const started = performance.now();
  const outcome = await surface(world.bot, new AbortController().signal, new Budgets(), 2);
  assert.equal(outcome.kind, "stuck");
  assert.ok(performance.now() - started < 2000);
});

test("a death during the surfacing ends it with the controls released", async (t) => {
  const world = swimWorld(t, tunnel, new Vec3(0.5, 0.2, 0.5));
  const done = surface(world.bot, new AbortController().signal, new Budgets(), 600);
  world.bot.emit("physicsTick");
  Object.assign(world.bot, { health: 0 });
  world.bot.emit("death");
  assert.equal((await done).kind, "bot_died");
  assert.equal(world.held.size, 0);
});

// Review 2026-10-18 (run 15 fixes), blocking 2: a route that is empty (the head was in air) or fully walked was never
// asked for again, so a bot that bobbed back under the roof with air still short only jumped.
test("the head in air, then under water again with the air short and no pocket left: the reflex digs within a second", async (t) => {
  let flooded = false;
  const seen = (x: number, y: number, z: number): Cell => (!flooded && x >= -6 && x <= -5 && y === 1 && z === 0 ? "air" : tunnel(x, y, z));
  const world = swimWorld(t, seen, new Vec3(-4.5, 0.2, 0.5));
  await surfaceWithShortAir(world, 25, (tick) => {
    if (tick === 5) flooded = true;
  });
  assert.deepEqual(world.digs, ["roof"], "the empty route of the breathing head was dropped when it went under again");
});

test("the head in air, then under water again with another pocket in reach: a new route swims to it within a second", async (t) => {
  let flooded = false;
  const seen = (x: number, y: number, z: number): Cell =>
    y === 1 && z === 0 && ((!flooded && x >= -6 && x <= -5) || x === 6) ? "air" : tunnel(x, y, z);
  const world = swimWorld(t, seen, new Vec3(-4.5, 0.2, 0.5));
  const position = await surfaceWithShortAir(world, 25, (tick) => {
    if (tick === 5) flooded = true;
  });
  assert.ok(position.x > -3.5, `swam east toward the other pocket, ended at x ${position.x}`);
  assert.deepEqual(world.digs, []);
});

test("a route walked to its last cell, then the pocket floods: a new route is asked for within a second", async (t) => {
  let flooded = false;
  const seen = (x: number, y: number, z: number): Cell =>
    y === 1 && z === 0 && ((!flooded && x >= -5 && x <= -4) || x === 6) ? "air" : tunnel(x, y, z);
  const world = swimWorld(t, seen, new Vec3(0.5, 0.2, 0.5));
  const position = await surfaceWithShortAir(world, 100, (tick) => {
    if (tick === 80) flooded = true;
  });
  assert.ok(position.x > -3, `walked to the pocket (x -4), then swam east after it flooded, ended at x ${position.x}`);
  assert.deepEqual(world.digs, []);
});

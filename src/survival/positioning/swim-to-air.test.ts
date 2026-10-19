import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import prismarineBlock from "prismarine-block";
import { Vec3 } from "vec3";
import { swimToBreathableCell } from "./swim-to-air.js";

type Cell = "water" | "air" | "stone";
const registry = minecraftData("1.21.4");
const Block = prismarineBlock("1.21.4");
const SPEED = 0.1;

/** A swimmer in a hand-made world: controls move the body 0.1 per tick, stone stops it. */
function swimmer(read: (x: number, y: number, z: number) => Cell, start: Vec3) {
  const held = new Set<string>();
  const entity = { position: start.clone(), isInWater: true, yaw: 0, onGround: false, width: 0.6, height: 1.8, velocity: new Vec3(0, 0, 0) };
  const at = (p: Vec3) => read(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
  const bot = Object.assign(new EventEmitter(), {
    entity,
    blockAt: (p: Vec3) => Block.fromStateId(registry.blocksByName[at(p)]!.defaultState, 0),
    setControlState: (control: string, state: boolean) => (state ? held.add(control) : held.delete(control)),
  }) as unknown as Bot;
  const free = (p: Vec3) => at(p) !== "stone" && at(p.offset(0, 1.79, 0)) !== "stone";
  const tick = () => {
    const dy = held.has("jump") ? SPEED : held.has("sneak") ? -SPEED : 0;
    const sideways = entity.position.offset(((held.has("right") ? 1 : 0) - (held.has("left") ? 1 : 0)) * SPEED, 0,
      ((held.has("back") ? 1 : 0) - (held.has("forward") ? 1 : 0)) * SPEED);
    if (free(sideways)) entity.position = sideways;
    if (free(entity.position.offset(0, dy, 0))) entity.position = entity.position.offset(0, dy, 0);
    entity.isInWater = at(entity.position) === "water";
    bot.emit("physicsTick");
  };
  const headInAir = () => at(entity.position.offset(0, 1.62, 0)) === "air";
  /** Runs the swim while the test supplies a physics tick per turn of the event loop. */
  const swim = async (signal = new AbortController().signal, wallMs?: number, ticking = true) => {
    const done = swimToBreathableCell(bot, signal, wallMs);
    let finished = false;
    void done.then(() => { finished = true; }, () => { finished = true; });
    for (let n = 0; n < 1_000 && ticking && !finished; n++) {
      tick();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await done;
  };
  return { swim, held, entity, headInAir, bot };
}

/** A roofed stream along x (y 0-1), stone around it. */
const tunnel = (x: number, y: number, z: number): Cell => (z === 0 && y >= 0 && y <= 1 && x >= -20 && x <= 20 ? "water" : "stone");

test("a pinned swimmer under a roof swims to the air pocket five cells away and stops with its head in air", async () => {
  const pocket = (x: number, y: number, z: number): Cell => (x <= -5 && x >= -6 && y === 1 && z === 0 ? "air" : tunnel(x, y, z));
  const world = swimmer(pocket, new Vec3(0.5, 0.2, 0.5));
  await world.swim();
  assert.equal(world.headInAir(), true);
  assert.ok(world.entity.position.x < -4, `ended at x ${world.entity.position.x}`);
  assert.equal(world.held.size, 0, "controls released");
});

test("a swimmer whose head is already in air does nothing", async () => {
  const open = (x: number, y: number, z: number): Cell => (y >= 1 ? "air" : "water");
  const world = swimmer(open, new Vec3(0.5, 0.2, 0.5));
  await world.swim();
  assert.deepEqual([...world.held], []);
  assert.ok(Math.abs(world.entity.position.x - 0.5) < 0.01);
});

test("with no physics tick the swim still ends on the wall clock, controls released", async () => {
  const world = swimmer(tunnel, new Vec3(0.5, 0.2, 0.5));
  const started = performance.now();
  await world.swim(undefined, 100, false);
  assert.ok(performance.now() - started < 2_000);
  assert.equal(world.held.size, 0);
});

test("a swim cancelled mid-way releases the controls and rethrows the cancel", async () => {
  const pocket = (x: number, y: number, z: number): Cell => (x <= -5 && x >= -6 && y === 1 && z === 0 ? "air" : tunnel(x, y, z));
  const world = swimmer(pocket, new Vec3(0.5, 0.2, 0.5));
  const stop = new AbortController();
  let ticks = 0;
  world.bot.on("physicsTick", () => { if (++ticks === 5) stop.abort(new Error("cancelled")); });
  await assert.rejects(world.swim(stop.signal), /cancelled/u);
  assert.equal(world.held.size, 0);
});

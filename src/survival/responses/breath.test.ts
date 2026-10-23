import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeClock } from "../../test-support/fake-bot/index.js";
import { watch } from "../../test-support/pending.js";
import { waterFixture } from "../../test-support/water.js";
import { Budgets } from "../state/budgets.js";
import { surface } from "./breath.js";

/** What a test cell holds; leaves are a roof dug by hand within a breath, stone is not (owner 2026-10-19: Q2). */
type Cell = "water" | "air" | "stone" | "oak_leaves";
const SPEED = 0.1;
/** The box of cells the swims below can reach or look at; stone outside it (the fake's ground reaches far above). */
const BOX = { x: [-25, 25], y: [-3, 6], z: [-3, 3] } as const;

/**
 * A swimmer in a hand-made world. `seen` is what the bot reads; `physical` is what stops the body (they differ when a
 * block the bot cannot see blocks the way). Controls move the body 0.1 per tick; air refills when the head is in air.
 */
function swimWorld(t: Parameters<typeof waterFixture>[0], seen: (x: number, y: number, z: number) => Cell, start: Vec3, physical = seen, speed = SPEED) {
  const fixture = waterFixture(t, {}, {}, { onHarness: true });
  const { bot, harness } = fixture;
  if (harness === undefined) throw new Error("waterFixture was asked for the shared fake");
  const digs: string[] = [];
  const at = (read: typeof seen, p: Vec3) => read(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
  /** The fake world's cells over {@link BOX} made `read`'s (a cell already so is left alone); `stone` is the ground's own. */
  const paint = (read: typeof seen) => {
    for (let x = BOX.x[0]; x <= BOX.x[1]; x++)
      for (let y = BOX.y[0]; y <= BOX.y[1]; y++)
        for (let z = BOX.z[0]; z <= BOX.z[1]; z++) {
          const cell = new Vec3(x, y, z);
          if (harness.world.blockAt(cell)?.name !== read(x, y, z)) harness.world.setCell(cell, read(x, y, z));
        }
  };
  paint(seen);
  Object.assign(fixture.entity, { position: start.clone(), isInWater: true });
  bot.oxygenLevel = 8;
  // Scripted, as the old test's: a roof dig that ends at once with the breath that follows it.
  bot.dig = async () => {
    digs.push("roof");
    bot.oxygenLevel = 20;
  };
  const held = () => Object.entries(bot.controlState).filter(([, state]) => state).map(([control]) => control);
  const step = () => {
    const controls = bot.controlState;
    const p = fixture.entity.position;
    const dy = controls.jump ? speed : controls.sneak ? -speed : 0;
    const open = (cell: Cell) => cell === "water" || cell === "air";
    const free = (q: Vec3) => open(at(physical, q)) && open(at(physical, q.offset(0, 1.79, 0)));
    const sideways = p.offset(((controls.right ? 1 : 0) - (controls.left ? 1 : 0)) * speed, 0, ((controls.back ? 1 : 0) - (controls.forward ? 1 : 0)) * speed);
    if (free(sideways)) fixture.entity.position = sideways;
    const vertical = fixture.entity.position.offset(0, dy, 0);
    if (free(vertical)) fixture.entity.position = vertical;
    const now = fixture.entity.position;
    fixture.entity.isInWater = at(physical, now) === "water";
    if (at(physical, now.offset(0, 1.62, 0)) === "air") bot.oxygenLevel = 20;
  };
  /** What a test runs on each client tick: before the body moves, and after. */
  const onTick: { before?: (tick: number) => void; after?: () => void } = {};
  let tick = 0;
  // The body's move on each client tick, before the surfacing hears the tick.
  bot.on("physicsTick", () => {
    onTick.before?.(tick++);
    step();
    onTick.after?.();
  });
  const run = async (ticks: number, maximumTicks = 600) => {
    const done = surface(bot, new AbortController().signal, new Budgets(), maximumTicks);
    const finished = watch(done);
    for (let n = 0; n < ticks && !finished.over; n++) await harness.clock.advance(50);
    return { outcome: await done, position: fixture.entity.position, digs };
  };
  return { run, bot, fixture, clock: harness.clock, world: harness.world, paint, digs, held, onTick };
}

/**
 * Runs `surface` for `ticks` physics ticks with the air held short (a bot that keeps breathing leaves the loop), calls
 * `onTick(tick)` before each, then stops it; returns where the body is.
 */
async function surfaceWithShortAir(world: ReturnType<typeof swimWorld>, ticks: number, onTick: (tick: number) => void) {
  const stop = new AbortController();
  const done = surface(world.bot, stop.signal, new Budgets(), 600).catch(() => undefined);
  world.onTick.before = onTick;
  world.onTick.after = () => {
    if (world.digs.length === 0) world.bot.oxygenLevel = 8;
  };
  for (let tick = 0; tick < ticks; tick++) await world.clock.advance(50);
  stop.abort();
  await done;
  return world.fixture.entity.position;
}

/** A roofed stream along x (y 0-1), floor below, stone roof at y 2. */
const tunnel = (x: number, y: number, z: number): Cell => (z === 0 && y >= 0 && y <= 1 && x >= -20 && x <= 20 ? "water" : "stone");

/** `cells` with the tunnel's roof (y 2) of leaves, which a bare hand digs within a breath (owner 2026-10-19: Q2). */
const leavesRoofed = (cells: (x: number, y: number, z: number) => Cell) => (x: number, y: number, z: number): Cell =>
  y === 2 && z === 0 && cells(x, y, z) === "stone" ? "oak_leaves" : cells(x, y, z);

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
  const seen = leavesRoofed((x: number, y: number, z: number): Cell =>
    z === 0 && y === 1 && (x === -4 || x === 6) ? "air" : tunnel(x, y, z));
  const physical = (x: number, y: number, z: number): Cell =>
    (x === -2 || x === 2) && z === 0 && y <= 1 ? "stone" : seen(x, y, z);
  const world = swimWorld(t, seen, new Vec3(0.5, 0.2, 0.5), physical);
  const { outcome } = await world.run(900);
  assert.equal(outcome.kind, "air_full");
  assert.deepEqual(world.digs, ["roof"]);
});

test("cells that were never loaded are no way to air", async (t) => {
  const world = swimWorld(t, leavesRoofed(tunnel), new Vec3(0.5, 0.2, 0.5));
  // Every cell west of x -1 is in a chunk the bot has not loaded.
  for (let x = BOX.x[0]; x < -1; x++)
    for (let y = BOX.y[0]; y <= BOX.y[1]; y++) for (let z = BOX.z[0]; z <= BOX.z[1]; z++) world.world.setCell(new Vec3(x, y, z), "void");
  const { outcome, digs } = await world.run(300);
  assert.equal(outcome.kind, "air_full");
  assert.deepEqual(digs, ["roof"], "an unknown cell is not passable, so the only way left is up through the roof");
});

test("with the clock stopped the surfacing still ends on the wall clock", async (t) => {
  const world = swimWorld(t, tunnel, new Vec3(0.5, 0.2, 0.5));
  world.bot.dig = async () => { throw new Error("no dig"); };
  // Not on the shared fake until M2 merges: the builder's clock (waterFixture's is manual, and the surfacing's wall
  // clock reads the global timers), so a second, mocked clock stands for the wall clock; the builder's never advances.
  const wall = createFakeClock({ mode: "mocked" });
  using _installed = wall.install();
  const started = performance.now();
  const done = surface(world.bot, new AbortController().signal, new Budgets(), 2);
  await wall.advance(200);
  const outcome = await done;
  assert.equal(outcome.kind, "stuck");
  assert.ok(performance.now() - started < 2000);
});

test("a death during the surfacing ends it with the controls released", async (t) => {
  const world = swimWorld(t, tunnel, new Vec3(0.5, 0.2, 0.5));
  const done = surface(world.bot, new AbortController().signal, new Budgets(), 600);
  await world.clock.advance(50);
  world.bot.health = 0;
  world.bot.emit("death");
  assert.equal((await done).kind, "bot_died");
  assert.deepEqual(world.held(), []);
});

// Review 2026-10-18 (run 15 fixes), blocking 2: a route that is empty (the head was in air) or fully walked was never
// asked for again, so a bot that bobbed back under the roof with air still short only jumped.
test("the head in air, then under water again with the air short and no pocket left: the reflex digs within a second", async (t) => {
  let flooded = false;
  const seen = leavesRoofed((x: number, y: number, z: number): Cell => (!flooded && x >= -6 && x <= -5 && y === 1 && z === 0 ? "air" : tunnel(x, y, z)));
  const world = swimWorld(t, seen, new Vec3(-4.5, 0.2, 0.5));
  await surfaceWithShortAir(world, 25, (tick) => {
    if (tick === 5) {
      flooded = true;
      world.paint(seen);
    }
  });
  assert.deepEqual(world.digs, ["roof"], "the empty route of the breathing head was dropped when it went under again");
});

test("the head in air, then under water again with another pocket in reach: a new route swims to it within a second", async (t) => {
  let flooded = false;
  const seen = (x: number, y: number, z: number): Cell =>
    y === 1 && z === 0 && ((!flooded && x >= -6 && x <= -5) || x === 6) ? "air" : tunnel(x, y, z);
  const world = swimWorld(t, seen, new Vec3(-4.5, 0.2, 0.5));
  const position = await surfaceWithShortAir(world, 25, (tick) => {
    if (tick === 5) {
      flooded = true;
      world.paint(seen);
    }
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
    if (tick === 80) {
      flooded = true;
      world.paint(seen);
    }
  });
  assert.ok(position.x > -3, `walked to the pocket (x -4), then swam east after it flooded, ended at x ${position.x}`);
  assert.deepEqual(world.digs, []);
});

/** A sealed one-cell water pocket at x 0, z 0 (feet y 0, head y 1); everything round it `wall`, the roof included. */
const sealedPocket = (wall: Cell) => (x: number, y: number, z: number): Cell => (x === 0 && z === 0 && y >= 0 && y <= 1 ? "water" : wall);

// Run 16, Yuki: a stone roof dug by hand under water and off the ground takes about 190 s; the dig ran to her death.
test("a roof dig that would outlast the air and half the health is not started: the attempt ends stuck, controls released", async (t) => {
  const world = swimWorld(t, sealedPocket("stone"), new Vec3(0.5, 0.2, 0.5));
  const { outcome, digs } = await world.run(700, 600);
  assert.deepEqual(digs, []);
  assert.equal(outcome.kind, "stuck");
  assert.equal(outcome.roofDig, "too_slow");
  assert.deepEqual(world.held(), []);
});

/** The pocket under a leaves roof whose dig hangs until it is stopped; counts the stops. */
function hangingDig(t: Parameters<typeof waterFixture>[0]) {
  const world = swimWorld(t, leavesRoofed(sealedPocket("stone")), new Vec3(0.5, 0.2, 0.5));
  let stops = 0;
  let stop: ((cause: Error) => void) | undefined;
  // Scripted, as the old test's: a dig that never ends by itself, and a stop that aborts it. Like Mineflayer's own
  // `stopDigging`, a stop with no dig under way does nothing (its death handler, `digging.js`, stops a dig too).
  Object.assign(world.bot, {
    dig: () => new Promise<void>((_resolve, reject) => {
      stop = reject;
      world.digs.push("roof");
    }),
    stopDigging: () => {
      if (stop === undefined) return;
      stops += 1;
      stop(new Error("Digging aborted"));
      stop = undefined;
    },
  });
  return { world, stops: () => stops };
}

test("the attempt's wall clock stops a dig in progress when physics ticks have stopped", async (t) => {
  const { world, stops } = hangingDig(t);
  // Not on the shared fake until M2 merges: the builder's clock (see the clock-stopped test above): a second, mocked
  // clock stands for the wall clock; the builder's never advances, so no physics tick comes.
  const wall = createFakeClock({ mode: "mocked" });
  using _installed = wall.install();
  const done = surface(world.bot, new AbortController().signal, new Budgets(), 2);
  await wall.advance(200);
  const outcome = await done;
  assert.deepEqual(world.digs, ["roof"]);
  assert.equal(outcome.kind, "stuck");
  assert.equal(stops(), 1);
});

test("the tick budget running out stops a dig in progress", async (t) => {
  const { world, stops } = hangingDig(t);
  const { outcome } = await world.run(80, 20);
  assert.equal(outcome.kind, "stuck");
  assert.equal(stops(), 1);
});

test("a death during a dig stops it and the attempt ends bot_died", async (t) => {
  const { world, stops } = hangingDig(t);
  const done = surface(world.bot, new AbortController().signal, new Budgets(), 600);
  await world.clock.advance(0);
  world.bot.health = 0;
  world.bot.emit("death");
  assert.equal((await done).kind, "bot_died");
  assert.equal(stops(), 1);
});

// Run 16, Yuki: she moved half a block in two seconds toward air and both ways were closed as stalled.
test("a way the body swims toward slowly is not given up: the slow swimmer reaches the pocket instead of digging", async (t) => {
  const seen = (x: number, y: number, z: number): Cell => (z === 0 && y === 1 && x === -3 ? "air" : tunnel(x, y, z));
  const world = swimWorld(t, seen, new Vec3(0.5, 0.2, 0.5), seen, 0.03);
  const { outcome, digs } = await world.run(900, 600);
  assert.equal(outcome.kind, "air_full");
  assert.deepEqual(digs, []);
});

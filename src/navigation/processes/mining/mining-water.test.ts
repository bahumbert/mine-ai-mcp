import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../test-support/fake-bot/index.js";
import { cellKey } from "../../../utils/index.js";
import type { PlaceIntoCell } from "../../../world/placement.js";
import { clearMiningWater } from "./mining-water.js";
import { waterStancesHeld } from "../../steering/hold-water-position.js";

test("dry mining seals source water, including below the target, while an existing surface swim needs no plug", async () => {
  for (const wetMiner of [false, true]) for (const offset of [new Vec3(1, 0, 0), new Vec3(0, -1, 0)]) {
    const target = new Vec3(1, 64, 0);
    const face = target.plus(offset);
    const { bot, world } = createFakeBot({
      cells: { [cellKey(target)]: "stone", [cellKey(face)]: "water", ...(wetMiner && { "0,64,0": "water" }) },
    });
    let sealed = false;
    const result = await clearMiningWater(bot, target, async (_bot, position) => {
      assert.deepEqual(position, face);
      sealed = true;
      world.setCell(position, "cobblestone");
      return { kind: "placed", block: bot.blockAt(face)! };
    }, null);
    assert.equal(result, null);
    assert.equal(sealed, !wetMiner);
  }
});

test("a dry mining site with no sealing material is refused without waiting for water that cannot drain", async () => {
  const { bot } = createFakeBot({ groundY: null, cells: { "2,64,0": "water" } });
  const result = await clearMiningWater(bot, new Vec3(1, 64, 0), async () => ({ kind: "failed", error: "No building material" }), null);
  assert.match(result!, /could not be isolated.*No building material/);
});

test("a target touched by a kelp cell is sealed like one touched by water", async () => {
  const target = new Vec3(1, 64, 0);
  const face = target.plus(new Vec3(1, 0, 0));
  const { bot, world } = createFakeBot({ cells: { [cellKey(target)]: "stone", [cellKey(face)]: "kelp" } });
  let sealed = false;
  const result = await clearMiningWater(bot, target, async (_bot, position) => {
    assert.deepEqual(position, face);
    sealed = true;
    world.setCell(position, "cobblestone");
    return { kind: "placed", block: bot.blockAt(face)! };
  }, null);
  assert.equal(result, null);
  assert.equal(sealed, true);
});

/**
 * A miner at 0 64 0 beside a target at 1 64 0 in a world of `water` cells (block names by "x,y,z", "water@3" for the
 * flowing level 3), stone below. Its clock drives the global timers, which the drain wait reads.
 */
function wetSite(water: Record<string, string>, ticksPerSecond = 20) {
  const wet = Object.entries(water).map(([key, name]) => {
    const [base, level] = name.split("@");
    return [key, level === undefined ? base! : { name: base!, properties: { level: Number(level) } }] as const;
  });
  return createFakeBot({ clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond }, cells: { "1,64,0": "stone", ...Object.fromEntries(wet) } });
}

test("water over the target and beside the cell over it is isolated with one block over the target", async () => {
  const { bot, world } = wetSite(Object.fromEntries(["1,65,0", "2,65,0", "0,65,0", "1,65,1", "1,65,-1"].map((key) => [key, "water"])));
  const placed: string[] = [];
  const result = await clearMiningWater(bot, new Vec3(1, 64, 0), async (_bot, position) => {
    const cell = new Vec3(position.x, position.y, position.z);
    placed.push(cellKey(cell));
    world.setCell(cell, "cobblestone");
    return { kind: "placed", block: bot.blockAt(cell)! };
  }, null);
  assert.equal(result, null);
  assert.deepEqual(placed, ["1,65,0"]);
});

for (const { rate, stopped, endMs } of [
  { rate: 20, stopped: false, endMs: 2_000 },
  { rate: 10, stopped: false, endMs: 4_000 },
  { rate: 5, stopped: false, endMs: 8_000 },
  { rate: 5, stopped: true, endMs: 20_000 },
]) test(`removed water waits for 40 server ticks at ${rate} tps or 20 s of a stopped clock (${stopped})`, async () => {
  const { bot, world, clock, server } = wetSite({ "2,64,0": "water", "1,64,1": "water@3" }, rate);
  using _timers = clock.install();
  if (stopped) server.stop();
  const placedAt = bot.time.age;
  bot.physicsEnabled = false; // no client tick comes: only the server's time packets move on
  let result: string | null | undefined;
  const clearing = clearMiningWater(bot, new Vec3(1, 64, 0), async (_bot, position) => {
    const cell = new Vec3(position.x, position.y, position.z);
    world.setCell(cell, "cobblestone");
    return { kind: "placed", block: bot.blockAt(cell)! };
  }, null).then((answer) => (result = answer));

  // The source is plugged at once, the flowing cell stays: the wait is 40 ticks of world age, two time packets.
  await clock.advance(endMs - 50);
  assert.equal(result, undefined, "still waiting for the second time packet");
  assert.equal(bot.blockAt(new Vec3(1, 64, 1))?.name, "water", "flow is given time to drain before plugging it");
  await clock.advance(50);
  assert.equal(result, null, "the drain completes at its tick bound");
  await clearing;
  assert.equal(bot.time.age, placedAt + (stopped ? 0 : 40));
  assert.equal(result, null);
  assert.equal(bot.blockAt(new Vec3(1, 64, 1))?.name, "cobblestone");
  assert.equal(bot.blockAt(new Vec3(2, 64, 0))?.name, "cobblestone");
});

test("aborting a drain releases its water stance and lets the next clearing finish", async () => {
  const { bot, world, clock, server } = wetSite({ "2,64,0": "water", "1,64,1": "water@3" }, 5);
  using _timers = clock.install();
  server.stop();
  const abort = new AbortController();
  const place: PlaceIntoCell = async (_bot, position) => {
    const cell = new Vec3(position.x, position.y, position.z);
    world.setCell(cell, "cobblestone");
    return { kind: "placed", block: bot.blockAt(cell)! };
  };
  const clearing = clearMiningWater(bot, new Vec3(1, 64, 0), place, null, abort.signal);
  await clock.advance(100);
  abort.abort(new Error("reflex took the body"));
  await assert.rejects(clearing, /reflex took the body/);
  assert.equal(waterStancesHeld(bot), 0);
  assert.equal(bot.controlState.jump, false);
  // The source was plugged before the abort and its flow is unfed now: the next clearing waits its 40 ticks (8 000 ms at 5 tps) on a running clock.
  server.resume();
  assert.equal(await clock.settle(clearMiningWater(bot, new Vec3(1, 64, 0), place, null), 8_100), null);
});

for (const { rate, stopped, endMs } of [
  { rate: 20, stopped: false, endMs: 2_000 },
  { rate: 10, stopped: false, endMs: 4_000 },
  { rate: 20, stopped: true, endMs: 20_000 },
]) for (const decays of [true, false]) test(`wading drain ${decays ? "decays" : "stays wet"} at ${rate} tps (stopped ${stopped})`, async () => {
  const { bot, world, clock, server } = wetSite({ "0,64,0": "water@1", "1,64,0": "water@1", "2,64,0": "water" }, rate);
  using _timers = clock.install();
  if (stopped) server.stop();
  Object.assign(bot.entity, { isInWater: true, onGround: true });
  bot.physicsEnabled = false;
  const source = new Vec3(2, 64, 0);
  const start = bot.time.age;
  const added = listenersAddedSince(bot);
  const timers = clock.pendingGlobalTimers();
  const clearing = clearMiningWater(bot, new Vec3(1, 63, 0), async (_bot, position) => {
    const cell = new Vec3(position.x, position.y, position.z);
    world.setCell(cell, "cobblestone");
    return { kind: "placed", block: bot.blockAt(cell)! };
  }, null);
  await clock.advance(endMs - 50);
  assert.equal(bot.blockAt(source)?.name, "cobblestone");
  if (decays) {
    // Server flow decay is supplied by the scenario, not simulated by the fake.
    world.setCell(new Vec3(0, 64, 0), "air");
    world.setCell(new Vec3(1, 64, 0), "air");
    Reflect.set(bot.entity, "isInWater", false);
  }
  await clock.advance(50);
  assert.equal(await clearing, decays ? null : "the mining stance is still in water after isolating the target");
  assert.equal(bot.time.age, start + (stopped ? 0 : 40));
  assert.equal(bot.blockAt(new Vec3(0, 64, 0))?.name, decays ? "air" : "water");
  assert.equal(waterStancesHeld(bot), 0);
  assert.equal(added("physicsTick"), 0);
  assert.equal(clock.pendingGlobalTimers(), timers);
  await clock.advance(20_050);
  assert.equal(added("physicsTick"), 0);
  assert.equal(clock.pendingGlobalTimers(), timers);
});

/** The placement callback of the orphan-flow cases: it records each cell and fills it, as the real placement does. */
function recordingPlace(bot: ReturnType<typeof wetSite>["bot"], world: ReturnType<typeof wetSite>["world"]) {
  const placed: string[] = [];
  const place: PlaceIntoCell = async (_bot, position) => {
    const cell = new Vec3(position.x, position.y, position.z);
    placed.push(cellKey(cell));
    world.setCell(cell, "cobblestone");
    return { kind: "placed", block: bot.blockAt(cell)! };
  };
  return { placed, place };
}

const TARGET = new Vec3(1, 64, 0);
const FACE = new Vec3(1, 65, 0);
const STILL_CLOCK = "the server clock stood still while flow over the target decayed";

/** Flow from the cell over the target along a bent path (kept within the bucket's 4.5-block reach of the eye), ending in a source `distance` steps from that cell. */
const FLOW_PATH = ["1,65,0", "2,65,0", "3,65,0", "3,66,0", "3,66,1", "3,66,2"];
function tracedFlow(distance: number): Record<string, string> {
  return Object.fromEntries(FLOW_PATH.slice(0, distance + 1).map((key, step) => [key, step === distance ? "water" : "water@3"]));
}

// Flow with no source in reach (D38): the face is left to decay for 40 ticks of world age before any plug is placed.
for (const { rate, halfMs, endMs } of [{ rate: 20, halfMs: 1_000, endMs: 2_000 }, { rate: 10, halfMs: 2_000, endMs: 4_000 }]) {
  test(`unfed flow over the target that decays at +20 ticks is never plugged, at ${rate} tps`, async () => {
    const { bot, world, clock } = wetSite({ "1,65,0": "water@3" }, rate);
    using _timers = clock.install();
    bot.physicsEnabled = false;
    const { placed, place } = recordingPlace(bot, world);
    const start = bot.time.age;
    let result: string | null | undefined;
    const clearing = clearMiningWater(bot, TARGET, place, null).then((answer) => (result = answer));
    await clock.advance(halfMs + 50);
    assert.equal(result, undefined, "the flow is given its decay time");
    assert.deepEqual(placed, [], "nothing is plugged while the flow may still decay");
    world.setCell(FACE, "air"); // an injected observation at +20: fluid decay itself is measured in the scenario (T3e)
    await clock.advance(50);
    assert.equal(await clearing, null);
    assert.deepEqual(placed, [], "a face that decayed needs no plug over the dig ray");
    assert.equal(bot.time.age, start + 20, "the wait ended at the first look past the decay");
    assert.equal(waterStancesHeld(bot), 0);
  });

  test(`unfed flow over the target that stays is plugged once, after the first look at +40 ticks, at ${rate} tps`, async () => {
    const { bot, world, clock } = wetSite({ "1,65,0": "water@3" }, rate);
    using _timers = clock.install();
    bot.physicsEnabled = false;
    const { placed, place } = recordingPlace(bot, world);
    const start = bot.time.age;
    let result: string | null | undefined;
    const clearing = clearMiningWater(bot, TARGET, place, null).then((answer) => (result = answer));
    await clock.advance(endMs - 50);
    assert.equal(result, undefined);
    assert.deepEqual(placed, []);
    await clock.advance(50);
    assert.equal(await clearing, null);
    assert.deepEqual(placed, [cellKey(FACE)]);
    assert.equal(bot.time.age, start + 40);
  });
}

test("a stopped server clock ends an unfed-flow drain unplugged, and the next drain after it resumes finishes", async () => {
  const { bot, world, clock, server } = wetSite({ "1,65,0": "water@3" }, 20);
  using _timers = clock.install();
  server.stop();
  bot.physicsEnabled = false;
  const { placed, place } = recordingPlace(bot, world);
  const added = listenersAddedSince(bot);
  const timers = clock.pendingGlobalTimers();
  const start = bot.time.age;
  let result: string | null | undefined;
  const clearing = clearMiningWater(bot, TARGET, place, null).then((answer) => (result = answer));
  await clock.advance(19_950);
  assert.equal(result, undefined, "the age has stood still for less than 20 s");
  await clock.advance(50);
  assert.equal(await clearing, STILL_CLOCK);
  assert.deepEqual(placed, [], "no block is placed over flow while the clock cannot show its decay");
  assert.equal(bot.time.age, start);
  assert.equal(waterStancesHeld(bot), 0);
  assert.equal(added("physicsTick"), 0);
  assert.equal(clock.pendingGlobalTimers(), timers);
  await clock.advance(20_050);
  assert.equal(added("physicsTick"), 0);
  assert.equal(clock.pendingGlobalTimers(), timers);
  // The end state "a drain that ended on a still clock": the next drain, once the clock runs and the face is still wet, waits its 40 ticks and plugs it.
  server.resume();
  assert.equal(await clock.settle(clearMiningWater(bot, TARGET, place, null), 2_100), null);
  assert.deepEqual(placed, [cellKey(FACE)]);
  assert.equal(bot.time.age, start + 40, "the second drain waited on the running clock");
});

test("aborting a drain over unfed flow rejects, places nothing and leaves no hold, listener or timer", async () => {
  const { bot, world, clock } = wetSite({ "1,65,0": "water@3" }, 20);
  using _timers = clock.install();
  bot.physicsEnabled = false;
  const { placed, place } = recordingPlace(bot, world);
  const added = listenersAddedSince(bot);
  const timers = clock.pendingGlobalTimers();
  const abort = new AbortController();
  const clearing = clearMiningWater(bot, TARGET, place, null, abort.signal);
  await clock.advance(100);
  abort.abort(new Error("reflex took the body"));
  await assert.rejects(clearing, /reflex took the body/);
  assert.deepEqual(placed, []);
  assert.equal(waterStancesHeld(bot), 0);
  assert.equal(bot.controlState.jump, false);
  assert.equal(added("physicsTick"), 0);
  assert.equal(clock.pendingGlobalTimers(), timers);
});

// What D38 leaves as it was: each case ends at once with no wait on world age (the fake's age stays where it was).
for (const { name, water, placedCells, target = TARGET } of [
  { name: "a source face is plugged at once", water: { "1,65,0": "water" }, placedCells: ["1,65,0"] },
  { name: "a kelp face is plugged at once", water: { "1,65,0": "kelp" }, placedCells: ["1,65,0"] },
  // Every wet face must be plain flow for D38 (`every`, not `some`): the kelp face keeps the whole set on the plug-at-once path.
  { name: "a kelp face beside an unfed flow face plugs both at once", water: { "1,65,0": "kelp", "2,64,0": "water@3" }, placedCells: ["1,65,0", "2,64,0"] },
  // The target at 2 64 0 has no wet face: the flow at the feet is no face of it, so there is nothing to wait for.
  { name: "flow at the feet with no wet target face needs no wait", water: { "0,64,0": "water@3" }, placedCells: [], target: new Vec3(2, 64, 0) },
]) test(name, async () => {
  const { bot, world, clock } = wetSite(water);
  using _timers = clock.install();
  bot.physicsEnabled = false;
  const { placed, place } = recordingPlace(bot, world);
  const start = bot.time.age;
  assert.equal(await clock.settle(clearMiningWater(bot, target, place, null), 100), null);
  assert.equal(bot.time.age, start, "no world-age wait");
  assert.deepEqual(placed, placedCells);
});

// The trace bound (`FLOW_TRACE_CELLS`, 4): a source within it is the removed-source path, one cell past it the flow is unfed (D38).
for (const { name, water, beforeWait, afterWait } of [
  { name: "a source face beside a flow face: the source is plugged at once, the flow after 40 ticks", water: { "1,65,0": "water", "2,64,0": "water@3" }, beforeWait: ["1,65,0"], afterWait: ["1,65,0", "2,64,0"] },
  { name: "a flow whose source is at the trace bound: the traced source is plugged at once, the flow after 40 ticks", water: tracedFlow(4), beforeWait: ["3,66,1"], afterWait: ["3,66,1", "1,65,0"] },
  { name: "a flow whose source is just past the trace bound is unfed: nothing is plugged before the first look at +40 ticks", water: tracedFlow(5), beforeWait: [], afterWait: ["1,65,0"] },
]) test(name, async () => {
  const { bot, world, clock } = wetSite(water);
  using _timers = clock.install();
  bot.physicsEnabled = false;
  const { placed, place } = recordingPlace(bot, world);
  const start = bot.time.age;
  const clearing = clearMiningWater(bot, TARGET, place, null);
  await clock.advance(1_950);
  assert.deepEqual(placed, beforeWait);
  await clock.advance(50);
  assert.equal(await clearing, null);
  assert.deepEqual(placed, afterWait);
  assert.equal(bot.time.age, start + 40);
});


import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { liveBlockReader } from "../mineflayer/world.js";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { holdWaterPosition, landOnStanceFloor, settleInWaterForDig, waterStancesHeld } from "./hold-water-position.js";

function stanceBot() {
  const { bot } = createFakeBot();
  Object.assign(bot.entity, { isInWater: true, onGround: false, yaw: 0 });
  return bot;
}

test("a held water stance is counted for its bot until it is released", () => {
  const bot = stanceBot();
  const other = stanceBot();
  assert.equal(waterStancesHeld(bot), 0);
  const first = holdWaterPosition(bot, undefined);
  const second = holdWaterPosition(bot, undefined);
  assert.equal(waterStancesHeld(bot), 2);
  assert.equal(waterStancesHeld(other), 0, "the count is per bot");
  first();
  assert.equal(waterStancesHeld(bot), 1);
  first();
  assert.equal(waterStancesHeld(bot), 1, "the other stance is still held");
  second();
  assert.equal(waterStancesHeld(bot), 0);
});

/** A bot drifting off its stance, so a live stance would steer back: every control write is recorded. */
function driftingStance(signal: AbortSignal) {
  const bot = stanceBot();
  const writes: string[] = [];
  const release = holdWaterPosition(bot, signal, (control, active) => {
    writes.push(`${control}:${active}`);
    bot.setControlState(control, active);
  });
  bot.entity.position.x += 1;
  return { bot, writes, release };
}

test("after an abort a physics tick neither steers nor writes a control, and the stance no longer counts", () => {
  const abort = new AbortController();
  const { bot, writes, release } = driftingStance(abort.signal);
  assert.equal(waterStancesHeld(bot), 1);
  bot.emit("physicsTick");
  assert.ok(writes.some((write) => write.endsWith(":true")), "a live stance steers back");

  abort.abort();
  writes.length = 0;
  bot.emit("physicsTick");
  bot.emit("physicsTick");

  assert.deepEqual(writes, [], "a body taken by a reflex is not written to by the dead stance");
  assert.equal(waterStancesHeld(bot), 0);
  assert.equal(bot.listenerCount("physicsTick"), 0);

  release();

  for (const control of ["forward", "back", "left", "right", "jump"] as const)
    assert.equal(bot.controlState[control], false);
  assert.equal(waterStancesHeld(bot), 0);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("a stance taken on an already aborted signal never listens to physics ticks", () => {
  const { bot, writes, release } = driftingStance(AbortSignal.abort());
  assert.equal(waterStancesHeld(bot), 0);
  bot.emit("physicsTick");
  assert.deepEqual(writes, []);
  assert.equal(bot.listenerCount("physicsTick"), 0);
  release();
  assert.equal(waterStancesHeld(bot), 0);
});

/**
 * A water stance on the shared fake bot whose body moves by Mineflayer's own physics (`simulatePhysics`), so water
 * drag, gravity and the jump's lift are the game's. The
 * hole is one cell of water in a stone floor at y -60, open to the air above (lava-interrupts-mining's escape cell);
 * `cells` reshape it.
 */
function physicalStance(feetY: number, cells: Record<string, string> = {}) {
  const harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    position: { x: 0.5, y: feetY, z: 0.5 },
    groundY: -60,
    cells: { "0,-60,0": "water", ...cells },
    simulatePhysics: true,
  });
  const { bot } = harness;
  Object.assign(bot.entity, { isInWater: true, onGround: false });
  // The jump the body moved with, tick by tick (the engine steps before `physicsTick`).
  const jumps: number[] = [];
  let tick = 0;
  bot.on("physicsTick", () => {
    tick += 1;
    if (bot.controlState.jump) jumps.push(tick);
  });
  const ticks = async (count: number) => {
    for (let at = 0; at < count; at += 1) await harness.clock.advance(50);
  };
  return { ...harness, jumps, ticks, read: liveBlockReader(bot) };
}

test("a hold over a solid floor never jumps while the body is above the floor, and the body lands on it", async () => {
  // Under load the escape walk left the body at -59.62, 0.38 above its floor; the hold kept it there (obsidian x5).
  const { bot, clock, jumps, ticks, read } = physicalStance(-59.62);
  using _timers = clock.install();
  const floor = { stance: { x: 0, y: -60, z: 0 }, read };
  const release = holdWaterPosition(bot, undefined, undefined, floor);
  let landed: boolean | null = null;
  void landOnStanceFloor(bot, floor, new AbortController().signal).then((answer) => (landed = answer));
  for (let tick = 1; tick <= 40 && landed === null; tick += 1) await ticks(1);
  release();
  assert.deepEqual(jumps, [], "no jump while above the floor");
  assert.equal(landed, true, `landed within 40 ticks (y ${bot.entity.position.y.toFixed(3)})`);
  assert.ok(Math.abs(bot.entity.position.y - -60) < 0.01, `on the floor at -60, at ${bot.entity.position.y}`);
});

test("a mid-water hold (no floor under the stance) still keeps its start depth", async () => {
  // Three cells of water: nothing solid under the stance cell, so the hold is the depth the body had.
  const deep = { "0,-61,0": "water", "0,-62,0": "water", "0,-63,0": "stone" };
  const { bot, jumps, ticks, read } = physicalStance(-61.5, deep);
  const release = holdWaterPosition(bot, undefined, undefined, { stance: { x: 0, y: -61, z: 0 }, read });
  await ticks(80);
  release();
  assert.ok(jumps.length > 0, "the hold jumps to stop the sinking");
  assert.ok(Math.abs(bot.entity.position.y - -61.5) < 0.3, `held near -61.5, at ${bot.entity.position.y}`);
  assert.equal(bot.entity.onGround, false);
});

test("a floor broken during the hold falls back to the start depth", async () => {
  const { bot, world, jumps, ticks, read } = physicalStance(-59.62, { "0,-62,0": "stone" });
  const release = holdWaterPosition(bot, undefined, undefined, { stance: { x: 0, y: -60, z: 0 }, read });
  await ticks(40);
  assert.equal(bot.entity.onGround, true);
  world.setCell(new Vec3(0, -61, 0), "water");
  await ticks(80);
  release();
  assert.ok(jumps.length > 0, "without its floor the hold swims again");
  assert.ok(bot.entity.position.y > -60.5, `held near the start depth, at ${bot.entity.position.y}`);
});

test("landing is not waited for on dry ground or when the stance has no floor", async () => {
  const { bot, read } = physicalStance(-61.5, { "0,-61,0": "water", "0,-62,0": "water" });
  const signal = new AbortController().signal;
  assert.equal(await landOnStanceFloor(bot, { stance: { x: 0, y: -61, z: 0 }, read }, signal), false, "no floor: no wait");
  Object.assign(bot.entity, { isInWater: false });
  assert.equal(await landOnStanceFloor(bot, { stance: { x: 0, y: -60, z: 0 }, read }, signal), false, "dry: no wait");
});

for (const { rate, stopped, lands, endMs } of [
  { rate: 5, stopped: false, lands: true, endMs: 7_950 },
  { rate: 5, stopped: false, lands: false, endMs: 8_000 },
  { rate: 10, stopped: false, lands: false, endMs: 4_000 },
  { rate: 5, stopped: true, lands: false, endMs: 20_000 },
]) test(`landing waits for 40 server ticks at ${rate} tps or 20 s of a stopped clock (${stopped}, landed ${lands})`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, server } = createFakeBot({ clock, server: { ticksPerSecond: rate }, cells: { "0,64,0": "water" } });
  const read = liveBlockReader(bot);
  Object.assign(bot.entity, { isInWater: true, onGround: false });
  bot.physicsEnabled = false;
  if (stopped) server.stop();
  const age = bot.time.age;
  if (lands) clock.after(endMs, () => Object.assign(bot.entity, { onGround: true }));
  let settled: boolean | null = null;
  void landOnStanceFloor(bot, { stance: { x: 0, y: 64, z: 0 }, read }, new AbortController().signal).then((landed) => (settled = landed));
  await clock.advance(endMs - 50);
  assert.equal(settled, null, "still waiting while the world age has budget");
  assert.equal(bot.time.age - age, stopped ? 0 : 20);
  await clock.advance(50);
  assert.equal(settled, lands);
  assert.equal(bot.time.age - age, stopped || lands ? (stopped ? 0 : 20) : 40);
});

for (const { rate, stopped, floor, lands, endMs } of [
  { rate: 5, stopped: false, floor: true, lands: true, endMs: 11_950 },
  { rate: 5, stopped: false, floor: true, lands: false, endMs: 12_000 },
  { rate: 10, stopped: false, floor: true, lands: false, endMs: 6_000 },
  { rate: 5, stopped: true, floor: true, lands: false, endMs: 20_000 },
  { rate: 5, stopped: true, floor: false, lands: false, endMs: 3_000 },
]) test(`submerged eyes keep 60 ${floor ? "server" : "client"} ticks at ${rate} tps (stopped ${stopped}, floor ${floor}, landed ${lands})`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, server } = createFakeBot({ clock, server: { ticksPerSecond: rate }, groundY: floor ? 63 : null, cells: { "0,64,0": "water" } });
  Object.assign(bot.entity, { isInWater: true, onGround: false });
  bot.physicsEnabled = !floor;
  if (stopped) server.stop();
  const age = bot.time.age;
  if (lands) clock.after(endMs, () => Object.assign(bot.entity, { onGround: true }));
  let settled: boolean | null = null;
  const waiting = settleInWaterForDig(bot, liveBlockReader(bot), { x: 0, y: 64, z: 0 }, true).then((value) => (settled = value));
  await clock.advance(endMs - 50);
  assert.equal(settled, null);
  assert.equal(bot.time.age - age, stopped ? 0 : 40);
  await clock.advance(50);
  assert.equal(settled, lands);
  assert.equal(bot.time.age - age, stopped || lands ? (stopped ? 0 : 40) : 60);
  await waiting;
  assert.equal(waterStancesHeld(bot), 0);
  assert.equal(bot.controlState.jump, false);
});

test("an aborted landing rejects with the abort's reason and leaves no listener", async () => {
  const { bot, ticks, read } = physicalStance(-59.62);
  const abort = new AbortController();
  const before = bot.listenerCount("physicsTick");
  const landing = landOnStanceFloor(bot, { stance: { x: 0, y: -60, z: 0 }, read }, abort.signal);
  abort.abort(new Error("reflex took the body"));
  await assert.rejects(landing, /reflex took the body/);
  await ticks(1);
  assert.equal(bot.listenerCount("physicsTick"), before);
});

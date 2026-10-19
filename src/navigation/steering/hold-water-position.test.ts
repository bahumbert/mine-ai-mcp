import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { holdWaterPosition, waterStancesHeld } from "./hold-water-position.js";

function stanceBot() {
  return Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), isInWater: true, onGround: false, yaw: 0 },
    setControlState: () => {},
  });
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
  second();
  assert.equal(waterStancesHeld(bot), 0);
});

test("releasing a stance twice does not count it twice", () => {
  const bot = stanceBot();
  const first = holdWaterPosition(bot, undefined);
  const second = holdWaterPosition(bot, undefined);
  first();
  first();
  assert.equal(waterStancesHeld(bot), 1, "the other stance is still held");
  second();
  assert.equal(waterStancesHeld(bot), 0);
});

test("an aborted stance stops counting even when its owner never releases it", () => {
  const bot = stanceBot();
  const abort = new AbortController();
  const release = holdWaterPosition(bot, abort.signal);
  assert.equal(waterStancesHeld(bot), 1);
  abort.abort();
  assert.equal(waterStancesHeld(bot), 0);
  release();
  assert.equal(waterStancesHeld(bot), 0, "the late release does not go below zero");
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("a stance taken on an already aborted signal is not counted", () => {
  const bot = stanceBot();
  const release = holdWaterPosition(bot, AbortSignal.abort());
  assert.equal(waterStancesHeld(bot), 0);
  release();
  assert.equal(waterStancesHeld(bot), 0);
});

/** A bot drifting off its stance, so a live stance would steer back: every control write is recorded. */
function driftingStance(signal: AbortSignal) {
  const bot = stanceBot();
  const writes: string[] = [];
  const release = holdWaterPosition(bot, signal, (control, active) => writes.push(`${control}:${active}`));
  bot.entity.position.x += 1;
  return { bot, writes, release };
}

test("after an abort a physics tick neither steers nor writes a control, and the stance no longer counts", () => {
  const abort = new AbortController();
  const { bot, writes } = driftingStance(abort.signal);
  bot.emit("physicsTick");
  assert.ok(writes.some((write) => write.endsWith(":true")), "a live stance steers back");

  abort.abort();
  writes.length = 0;
  bot.emit("physicsTick");
  bot.emit("physicsTick");

  assert.deepEqual(writes, [], "a body taken by a reflex is not written to by the dead stance");
  assert.equal(waterStancesHeld(bot), 0);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("a release after the abort clears the controls once and does not count the stance twice", () => {
  const abort = new AbortController();
  const { bot, writes, release } = driftingStance(abort.signal);
  bot.emit("physicsTick");
  abort.abort();
  writes.length = 0;

  release();

  assert.equal(writes.length, 5, "the four horizontal controls and jump, each once");
  assert.ok(writes.every((write) => write.endsWith(":false")));
  assert.equal(waterStancesHeld(bot), 0);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("a stance taken on an already aborted signal never listens to physics ticks", () => {
  const { bot, writes, release } = driftingStance(AbortSignal.abort());
  bot.emit("physicsTick");
  assert.deepEqual(writes, []);
  assert.equal(bot.listenerCount("physicsTick"), 0);
  release();
});

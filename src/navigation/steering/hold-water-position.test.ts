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

import type { BotEvents } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { climbsBy, fallsUnder, observeBodyProgress, ReflexProgress, risesOver, turnsTrue, watchBodyTicks } from "./reflex-progress.js";

function fixture() {
  const { bot } = createFakeBot();
  const { entity } = bot;
  const emitter = bot;
  const progress = new ReflexProgress();
  const tick = () => bot.emit("physicsTick");
  return { bot, emitter, entity, progress, tick };
}

test("a 1-block walk marks, a 0.9-block one does not", () => {
  const { bot, entity, progress, tick } = fixture();
  const detach = observeBodyProgress(bot, progress.mark);
  tick();
  entity.position = new Vec3(1.4, 64, 0.5);
  tick();
  assert.equal(progress.marks, 0, "0.9 blocks from the anchor");
  entity.position = new Vec3(1.5, 64, 0.5);
  tick();
  assert.equal(progress.marks, 1, "1 block from the anchor");
  assert.equal(progress.lastReason, "moved");
  detach();
});

test("a swimmer's bob does not mark", () => {
  const { bot, entity, progress, tick } = fixture();
  Object.assign(entity, { isInWater: true });
  const detach = observeBodyProgress(bot, progress.mark);
  tick();
  for (const y of [64.9, 63.8, 64.9, 63.2, 65.1]) {
    entity.position = new Vec3(0.5, y, 0.5);
    tick();
  }
  assert.equal(progress.marks, 0);
  detach();
});

test("a fall out of water keeps marking", () => {
  const { bot, entity, progress, tick } = fixture();
  const detach = observeBodyProgress(bot, progress.mark);
  tick();
  for (let y = 62; y > 20; y -= 2) {
    entity.position = new Vec3(0.5, y, 0.5);
    tick();
  }
  assert.equal(progress.marks, 21, "every 2 blocks of fall");
  detach();
});

test("a health change marks, up or down, and an unchanged health does not", () => {
  const { bot, progress } = fixture();
  const detach = observeBodyProgress(bot, progress.mark);
  bot.emit("health");
  assert.equal(progress.marks, 0);
  Object.assign(bot, { health: 18 });
  bot.emit("health");
  Object.assign(bot, { health: 20 });
  bot.emit("health");
  assert.equal(progress.marks, 2);
  assert.equal(progress.lastReason, "health_changed");
  detach();
});

test("a death marks", () => {
  const { bot, progress } = fixture();
  const detach = observeBodyProgress(bot, progress.mark);
  bot.emit("death");
  assert.equal(progress.lastReason, "died");
  detach();
});

test("detach removes every listener", () => {
  const { bot, emitter, progress } = fixture();
  const listeners = (name: string | symbol) => emitter.listenerCount(name as keyof BotEvents);
  const before = Object.fromEntries(emitter.eventNames().map((name) => [String(name), listeners(name)]));
  const detach = observeBodyProgress(bot, progress.mark);
  const stop = watchBodyTicks(bot, progress.mark, { landed: turnsTrue(() => true) });
  assert.ok(emitter.listenerCount("physicsTick") > 0);
  stop();
  detach();
  for (const name of emitter.eventNames()) assert.equal(listeners(name), before[String(name)] ?? 0, String(name));
});

test("a probe sampler marks when its value turns true, not while it stays true", () => {
  const { bot, progress, tick } = fixture();
  let onGround = false;
  const stop = watchBodyTicks(bot, progress.mark, { landed: turnsTrue(() => onGround) });
  tick();
  tick();
  assert.equal(progress.marks, 0);
  onGround = true;
  tick();
  tick();
  assert.equal(progress.marks, 1);
  assert.equal(progress.lastReason, "landed");
  stop();
});

test("a rising value marks on each rise, and a missing reading is not a rise", () => {
  const { bot, progress, tick } = fixture();
  let air: number | null = 8;
  const stop = watchBodyTicks(bot, progress.mark, { air_rose: risesOver(() => air) });
  tick();
  air = 7;
  tick();
  air = null;
  tick();
  air = 7;
  tick();
  assert.equal(progress.marks, 0, "falling, then unknown, then back at the same value");
  air = 9;
  tick();
  assert.equal(progress.marks, 1);
  stop();
});

test("a sampler that throws marks nothing and does not stop the others", () => {
  const { bot, progress, tick } = fixture();
  let landed = false;
  const stop = watchBodyTicks(bot, progress.mark, {
    broken: () => {
      throw new Error("chunk unloaded");
    },
    landed: turnsTrue(() => landed),
  });
  assert.doesNotThrow(tick);
  landed = true;
  assert.doesNotThrow(tick);
  assert.equal(progress.lastReason, "landed");
  stop();
});

test("a climb marks per block gained from the lowest point, and a bob adds nothing", () => {
  const { bot, progress, tick } = fixture();
  let y = 60;
  const stop = watchBodyTicks(bot, progress.mark, { climbed: climbsBy(() => y, 1) });
  for (const next of [60.6, 59.7, 60.5, 60.2]) {
    y = next;
    tick();
  }
  assert.equal(progress.marks, 0, "the wave never gets a block above its lowest point");
  y = 60.8;
  tick();
  assert.equal(progress.marks, 1, "60.8 is 1.1 above the lowest, 59.7");
  y = 61.4;
  tick();
  assert.equal(progress.marks, 1, "0.6 above the last mark");
  y = 61.9;
  tick();
  assert.equal(progress.marks, 2);
  stop();
});

test("a count that falls marks, one that rises or holds does not", () => {
  const { bot, progress, tick } = fixture();
  let count: number | null = 3;
  const stop = watchBodyTicks(bot, progress.mark, { spent: fallsUnder(() => count) });
  tick();
  count = 4;
  tick();
  count = 4;
  tick();
  assert.equal(progress.marks, 0);
  count = 3;
  tick();
  assert.equal(progress.marks, 1);
  stop();
});

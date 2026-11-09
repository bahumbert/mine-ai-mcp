// A missing native spawn must fail even when physics ticks stop.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../../src/test-support/fake-bot/index.ts";
import { createNativeWave } from "./native-wave.ts";

test("incomplete waves fail at the tick limit and do not resend", () => {
  const { bot } = createFakeBot();
  const sent: string[] = [];
  const wave = createNativeWave(bot, [new Vec3(1, 2, 3), new Vec3(4, 5, 6)], () => {}, (command) => sent.push(command));
  try {
    wave.tick(true);
    wave.spawn(100);
    for (let i = 0; i < 100; i++) wave.tick(true);
    assert.equal(wave.signal.aborted, true);
    assert.match(String(wave.error), /WAVE NOT ANSWERED 1\/2 after 100 ticks/u);
    assert.equal(sent.length, 2);
  } finally { wave.close(); }
});
test("a stalled wave fails on wall time, while closing cancels its deadline", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot } = createFakeBot();
  const wave = createNativeWave(bot, [new Vec3(1, 2, 3)], () => {}, () => {});
  wave.tick(true);
  const stalledWait = wave.waitForTicks(100).catch((error: unknown) => error);
  await clock.advance(10_000);
  assert.match(String(wave.error), /WAVE NOT ANSWERED 0\/1 after 0 ticks/u);
  assert.equal(await stalledWait, wave.error);
  assert.equal(bot.listenerCount("physicsTick"), 0);
  wave.close();
  const closed = createNativeWave(bot, [new Vec3(1, 2, 3)], () => {}, () => {});
  closed.tick(true);
  closed.close();
  await clock.advance(10_000);
  assert.equal(closed.signal.aborted, false);
});

test("post-return tick wait completes and releases its observer", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const { bot } = createFakeBot({ clock });
  const wave = createNativeWave(bot, [new Vec3(1, 2, 3)], () => {}, () => {});
  const waiting = wave.waitForTicks(2);
  await clock.advance(100);
  await waiting;
  assert.equal(bot.listenerCount("physicsTick"), 0);
  wave.close();
});

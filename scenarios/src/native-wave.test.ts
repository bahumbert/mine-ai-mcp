// Native spawn answers and post-return observation keep the same server window at slow rates.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../src/test-support/fake-bot/index.ts";
import { watch } from "../../src/test-support/pending.ts";
import { createNativeWave } from "./native-wave.ts";

/** World-age packet behavior is the shared fake's world-age-per-second contract. */
function waveHarness(ticksPerSecond = 20, timePacketYet = true) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, server: { startAge: 1_000, ticksPerSecond, timePacketYet } });
  const added = listenersAddedSince(harness.bot);
  const clientAdded = listenersAddedSince(harness.bot._client);
  const controller = new AbortController();
  const sent: string[] = [];
  const makeWave = () => createNativeWave(harness.bot, [new Vec3(1, 2, 3), new Vec3(4, 5, 6)], () => {}, command => sent.push(command), controller.signal);
  return { ...harness, controller, sent, makeWave, async assertClean() {
    assert.equal(clock.pendingTimers(), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
    for (const event of harness.bot.eventNames()) assert.equal(added(String(event)), 0);
    for (const event of harness.bot._client.eventNames()) assert.equal(clientAdded(String(event)), 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await clock.advance(30_000);
    assert.equal(clock.pendingTimers(), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
  } };
}

for (const rate of [20, 10]) {
  test(`spawn answers after 60 server ticks remain within the wave window at ${rate} tps`, async () => {
    const { bot, clock, makeWave, sent, assertClean } = waveHarness(rate);
    using _timers = clock.install();
    const wave = makeWave();
    const stopTick = clock.onSlice("physics", () => wave.tick(true));
    try {
      wave.tick(true);
      wave.spawn(100);
      await clock.advance(60 * 1_000 / rate);
      assert.equal(bot.time.age, 1_060);
      assert.equal(wave.signal.aborted, false);
      wave.spawn(101);
      wave.spawn(101);
      assert.equal(wave.pending, false);
      stopTick();
      assert.equal(clock.pendingGlobalTimers(), 0, "the answered wave releases its deadline immediately");
      await clock.advance(20_000);
      assert.equal(wave.signal.aborted, false);
      assert.equal(sent.length, 2);
    } finally { stopTick(); wave.close(); }
    await assertClean();
  });

  for (const answered of [0, 1]) test(`waves with ${answered}/2 answers fail after the +120 packet at ${rate} tps and never resend`, async () => {
    const { bot, clock, makeWave, sent, assertClean } = waveHarness(rate);
    using _timers = clock.install();
    const wave = makeWave();
    try {
      wave.tick(true);
      if (answered) wave.spawn(100);
      await clock.advance(120 * 1_000 / rate);
      assert.equal(bot.time.age, 1_120);
      assert.equal(wave.signal.aborted, false, "expiry looks before the packet");
      await clock.advance(50);
      assert.equal(wave.signal.aborted, true);
      assert.match(String(wave.error), new RegExp(`WAVE NOT ANSWERED ${answered}/2.*ticks.*elapsedTicks.*120`, "u"));
      wave.tick(true);
      wave.death(100, true);
      assert.equal(sent.length, 2);
    } finally { wave.close(); }
    await assertClean();
  });

  test(`post-return observation reaches the +120 packet at ${rate} tps`, async () => {
    const { bot, clock, makeWave, assertClean } = waveHarness(rate);
    using _timers = clock.install();
    const wave = makeWave();
    try {
      const waiting = wave.waitServerTicks(100);
      const state = watch(waiting);
      await clock.advance(120 * 1_000 / rate);
      assert.equal(bot.time.age, 1_120);
      assert.equal(state.over, false);
      await clock.advance(50);
      await waiting;
      assert.equal(clock.now(), 120 * 1_000 / rate + 50);
    } finally { wave.close(); }
    await assertClean();
  });
}

test("a stopped wave fails at the 18000 ms wall and rejects its active wait with the same reason", async () => {
  const { bot, clock, server, makeWave, assertClean } = waveHarness();
  using _timers = clock.install();
  server.stop();
  const wave = makeWave();
  try {
    wave.tick(true);
    const waiting = wave.waitServerTicks(400).catch((error: unknown) => error);
    await clock.advance(17_999);
    assert.equal(wave.signal.aborted, false);
    await clock.advance(1);
    assert.equal(bot.time.age, 1_000);
    assert.match(String(wave.error), /WAVE NOT ANSWERED 0\/2.*wall.*elapsedMs.*18000.*elapsedTicks.*0/u);
    assert.equal(await clock.settle(waiting, 0), wave.error);
  } finally { wave.close(); }
  await assertClean();
});

for (const [kind, ticks, finishMs, end] of [
  ["wall", 100, 18_000, "wall"],
  ["stalled", 400, 20_000, "stalled"],
  ["no age", 100, 5_000, "unobserved"],
] as const) {
  test(`post-return observation rejects ${kind} rather than accepting it as ticks`, async () => {
    const { clock, server, makeWave, assertClean } = waveHarness(20, kind !== "no age");
    using _timers = clock.install();
    server.stop();
    const wave = makeWave();
    try {
      const waiting = wave.waitServerTicks(ticks);
      const rejected = assert.rejects(waiting, new RegExp(`observation.*${end}.*elapsedMs.*${finishMs}.*elapsedTicks`, "u"));
      await clock.advance(finishMs - 1);
      await clock.advance(1);
      await clock.settle(rejected, 0);
      assert.equal(wave.signal.aborted, false, "observation expiry is distinct from a missing spawn");
    } finally { wave.close(); }
    await assertClean();
  });
}

for (const kind of ["cancel", "close", "cancelled at creation"] as const) {
  test(`${kind} releases both the in-flight wave budget and its observation`, async () => {
    const { clock, controller, makeWave, assertClean } = waveHarness();
    using _timers = clock.install();
    const reason = new Error("trial cancelled");
    if (kind === "cancelled at creation") controller.abort(reason);
    const wave = makeWave();
    try {
      wave.tick(true);
      const waiting = wave.waitServerTicks(100);
      const rejected = assert.rejects(waiting, kind === "close" ? /wave closed/u : error => error === reason);
      if (kind !== "cancelled at creation") {
        await clock.advance(500);
        if (kind === "cancel") controller.abort(reason);
        else wave.close();
      }
      await clock.settle(rejected, 0);
      wave.close();
      assert.equal(wave.signal.aborted, false);
    } finally { wave.close(); }
    await assertClean();
  });
}

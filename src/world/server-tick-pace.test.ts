// Server-metered durations use packet pace without crediting an overdue packet indefinitely.
import assert from "node:assert/strict";
import test from "node:test";
import { createMinecraftRuntime } from "../runtime/minecraft-runtime.js";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../test-support/fake-bot/index.js";
import { type ServerTickPace, serverTickPace } from "./server-tick-pace.js";

/** The real time-packet seam of the shared fake, with monotonic time controlled by the test. */
function pacedBot(ticksPerSecond = 10, timePacketYet = true) {
  return createFakeBot({ clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond, timePacketYet } });
}

for (const { rate, packetMs, ticks, age } of [
  { rate: 20, packetMs: 1_000, ticks: 20, age: 24_060 },
  { rate: 10, packetMs: 2_000, ticks: 10, age: 24_040 },
  { rate: 5, packetMs: 4_000, ticks: 5, age: 24_040 },
]) {
  test(`a known ${rate} tps pace credits ${ticks} ticks in 1000 ms${rate === 5 ? " (stress)" : ""}`, async () => {
    const { bot, clock } = pacedBot(rate);
    using _timers = clock.install();
    using pace = serverTickPace(bot);
    await clock.advance(packetMs * 2);
    const mark = pace.mark();
    await clock.advance(1_000);
    assert.equal(clock.now(), packetMs * 2 + 1_000);
    assert.equal(bot.time.age, age);
    assert.ok(Math.abs(pace.creditedSince(mark) - ticks) < 0.01);
    assert.equal(pace.toServerTicks(0.1), rate === 20 ? 0.1 : rate === 10 ? 0.2 : 0.4);
  });
}

test("cold and cached starts credit only the packet lower bound until pace is known at both rates", async () => {
  for (const { rate, packetMs } of [{ rate: 20, packetMs: 1_000 }, { rate: 10, packetMs: 2_000 }]) {
    for (const cached of [false, true]) {
      const { bot, clock } = pacedBot(rate, cached);
      using _timers = clock.install();
      using pace = serverTickPace(bot);
      const origin = pace.mark();
      assert.equal(origin.age, cached ? 24_000 : null);
      assert.equal(pace.toServerTicks(0.1), 0.1);
      await clock.advance(packetMs / 2);
      assert.deepEqual([clock.now(), bot.time.age, pace.creditedSince(origin)], [packetMs / 2, cached ? 24_000 : null, 0]);
      await clock.advance(packetMs / 2);
      assert.deepEqual([clock.now(), bot.time.age, pace.creditedSince(origin)], [packetMs, 24_020, cached ? 1 : 0]);
      const mark = pace.mark();
      await clock.advance(packetMs / 2);
      assert.deepEqual([clock.now(), bot.time.age, pace.creditedSince(mark)], [packetMs * 1.5, 24_020, 0]);
      await clock.advance(packetMs / 2);
      assert.deepEqual([clock.now(), bot.time.age, pace.creditedSince(mark)], [packetMs * 2, 24_040, 20]);
      assert.equal(pace.creditedSince(origin), cached ? 40 : 0);
    }
  }
});

interface PacketStep {
  readonly ms: number;
  readonly at: number;
  readonly age: number;
  readonly pace: number;
  readonly rate?: number;
  readonly resend?: boolean;
}

const packetTraces: readonly { readonly name: string; readonly rate: number; readonly steps: readonly PacketStep[] }[] = [
  { name: "compressed", rate: 10, steps: [
    { ms: 2_000, at: 2_000, age: 24_020, pace: 100 },
    { rate: 20, ms: 500, at: 2_500, age: 24_020, pace: 100 },
    { rate: 10, ms: 1_000, at: 3_500, age: 24_040, pace: 100 },
  ] },
  { name: "catch-up and oldest interval eviction", rate: 10, steps: [
    { ms: 2_000, at: 2_000, age: 24_020, pace: 100 },
    { rate: 50, ms: 400, at: 2_400, age: 24_040, pace: 100 },
    { ms: 400, at: 2_800, age: 24_060, pace: 100 },
    { ms: 400, at: 3_200, age: 24_080, pace: 50 },
  ] },
  { name: "first interval floor", rate: 50, steps: [{ ms: 400, at: 400, age: 24_020, pace: 50 }] },
  { name: "same age before first interval at 10 tps", rate: 10, steps: [
    { ms: 50, at: 50, age: 24_000, pace: 50, resend: true },
    { ms: 1_950, at: 2_000, age: 24_020, pace: 100 },
  ] },
  { name: "same age before first interval at 20 tps", rate: 20, steps: [
    { ms: 25, at: 25, age: 24_000, pace: 50, resend: true },
    { ms: 975, at: 1_000, age: 24_020, pace: 50 },
  ] },
];

test("packet traces preserve the slowest of three intervals, the floor and same-age origins", async () => {
  for (const trace of packetTraces) {
    const { bot, clock, server } = pacedBot(trace.rate);
    using _timers = clock.install();
    using pace = serverTickPace(bot);
    server.resendTime();
    for (const step of trace.steps) {
      if (step.rate !== undefined) server.setTickRate(step.rate);
      await clock.advance(step.ms);
      if (step.resend) server.resendTime();
      assert.deepEqual([clock.now(), bot.time.age, pace.msPerTick()], [step.at, step.age, step.pace], trace.name);
    }
  }
});

test("D1's cached-age cap plateaus at twenty for packet and between-packet marks at both rates", async () => {
  for (const { rate, warmMs, offsetMs, at } of [
    { rate: 20, warmMs: 2_000, offsetMs: 0, at: 12_000 },
    { rate: 20, warmMs: 2_000, offsetMs: 750, at: 12_750 },
    { rate: 10, warmMs: 4_000, offsetMs: 0, at: 14_000 },
    { rate: 10, warmMs: 4_000, offsetMs: 1_500, at: 15_500 },
  ]) {
    const { bot, clock, server } = pacedBot(rate);
    using _timers = clock.install();
    using pace = serverTickPace(bot);
    await clock.advance(warmMs + offsetMs);
    const mark = pace.mark();
    assert.deepEqual(mark, { ms: warmMs + offsetMs, age: 24_040 });
    server.stop();
    await clock.advance(10_000);
    assert.deepEqual([clock.now(), bot.time.age, pace.creditedSince(mark)], [at, 24_040, 20]);
    await clock.advance(10_000);
    assert.deepEqual([clock.now(), bot.time.age, pace.creditedSince(mark)], [at + 10_000, 24_040, 20]);
  }
});

test("a rate change during a mark cannot credit beyond the ticks actually run once observed", async () => {
  const { bot, clock, server } = pacedBot(20);
  using _timers = clock.install();
  using pace = serverTickPace(bot);
  await clock.advance(2_000);
  const mark = pace.mark();
  const started = server.gameTime;
  await clock.advance(500);
  server.setTickRate(10);
  await clock.advance(1_000);
  assert.equal(clock.now(), 3_500);
  assert.equal(bot.time.age, 24_060);
  assert.equal(server.gameTime - started, 20);
  assert.ok(pace.creditedSince(mark) <= 20);
  await clock.advance(2_000);
  assert.equal(bot.time.age, 24_080);
  assert.equal(pace.msPerTick(), 100);
  assert.ok(pace.creditedSince(mark) <= server.gameTime - started);
});

test("readiness requires both the credited duration and the existing client-tick floor", async () => {
  for (const { rate, warmMs, beforeMs, tickMs, at } of [
    { rate: 20, warmMs: 2_000, beforeMs: 600, tickMs: 50, at: 2_650 },
    { rate: 10, warmMs: 4_000, beforeMs: 1_200, tickMs: 100, at: 5_300 },
  ]) {
    const { bot, clock } = pacedBot(rate);
    using _timers = clock.install();
    using pace = serverTickPace(bot);
    await clock.advance(warmMs);
    const mark = pace.mark();
    await clock.advance(beforeMs);
    assert.deepEqual([clock.now(), bot.time.age, pace.ready(mark, 13, 13)], [at - tickMs, 24_040, false]);
    await clock.advance(tickMs);
    assert.deepEqual([clock.now(), bot.time.age, pace.ready(mark, 13, 12)], [at, 24_040, false]);
    assert.equal(pace.ready(mark, 13, 13), true);
  }
});

test("one observer per bot is disposed once and cannot hear later packets", async () => {
  const first = pacedBot();
  const second = pacedBot(20);
  using _timers = first.clock.install();
  const added = listenersAddedSince(first.bot);
  const pace = serverTickPace(first.bot);
  const other = serverTickPace(second.bot);
  assert.equal(serverTickPace(first.bot), pace);
  assert.notEqual(other, pace);
  assert.equal(added("time"), 1);
  await first.clock.advance(4_000);
  const mark = pace.mark();
  pace[Symbol.dispose]();
  pace[Symbol.dispose]();
  assert.equal(added("time"), 0);
  await first.clock.advance(10_000);
  assert.equal(pace.creditedSince(mark), 20);
  const replacement = serverTickPace(first.bot);
  assert.notEqual(replacement, pace);
  replacement[Symbol.dispose]();
  other[Symbol.dispose]();
  assert.equal(added("time"), 0);
  assert.equal(first.clock.pendingGlobalTimers(), 0);
});

test("the runtime installs pace before an action and removes it on close", async () => {
  for (const { rate, warmMs, at, ticks } of [
    { rate: 20, warmMs: 2_000, at: 3_000, ticks: 20 },
    { rate: 10, warmMs: 4_000, at: 5_000, ticks: 10 },
  ]) {
    const { bot, clock } = pacedBot(rate);
    bot.setMaxListeners(40);
    using _timers = clock.install();
    const added = listenersAddedSince(bot);
    const runtime = await createMinecraftRuntime(bot, {
      botData: { storage: { kind: "temporary" }, identity: { worldId: "tick-pace", scope: { kind: "bot", botId: bot.username } } },
    });
    try {
      await clock.advance(warmMs);
      const pace = serverTickPace(bot);
      const mark = pace.mark();
      await clock.advance(1_000);
      assert.deepEqual([clock.now(), bot.time.age], [at, rate === 20 ? 24_060 : 24_040]);
      assert.equal(pace.creditedSince(mark), ticks, "pace heard packets before its first action lookup");
    } finally {
      await runtime.close();
    }
    assert.equal(added("time"), 0);
  }
});

test("failed runtime startup removes its time listener and retires its observer at both rates", async () => {
  for (const rate of [20, 10]) {
    const { bot, clock } = pacedBot(rate);
    bot.setMaxListeners(40);
    using _timers = clock.install();
    const added = listenersAddedSince(bot);
    const on = bot.on.bind(bot);
    let failedPace: ServerTickPace | undefined;
    bot.on = (event, listener) => {
      if (event === "physicsTick") {
        failedPace = serverTickPace(bot);
        throw new Error("Runtime physics listener refused");
      }
      return on(event, listener);
    };
    await assert.rejects(createMinecraftRuntime(bot, {
      botData: { storage: { kind: "temporary" }, identity: { worldId: "tick-pace-failed", scope: { kind: "bot", botId: bot.username } } },
    }), /Runtime physics listener refused/);
    bot.on = on;
    assert.ok(failedPace);
    assert.equal(added("time"), 0);
    const mark = failedPace.mark();
    using replacement = serverTickPace(bot);
    assert.notEqual(replacement, failedPace);
    await clock.advance(4_000);
    assert.deepEqual([clock.now(), bot.time.age, failedPace.creditedSince(mark)], [4_000, rate === 20 ? 24_080 : 24_040, 0]);
  }
});

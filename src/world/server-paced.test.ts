/** Server-paced waits preserve game time at slow rates and release every resource on every exit. */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../test-support/fake-bot/index.js";
import { watch } from "../test-support/pending.js";
import { ServerPacedExpired, serverPacedElapsed, serverPacedSignal, waitForServerPaced } from "./server-paced.js";

/** The shared fake's world-age-per-second contract sends ages in 20-tick packets, after interval callbacks. */
function pacedBot(ticksPerSecond = 20, timePacketYet = true) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, server: { startAge: 1_000, ticksPerSecond, timePacketYet } });
  const added = listenersAddedSince(harness.bot);
  return { ...harness, assertClean: async (signal?: AbortSignal) => {
    assert.equal(clock.pendingTimers(), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
    for (const event of harness.bot.eventNames()) assert.equal(added(String(event)), 0);
    if (signal) assert.equal(getEventListeners(signal, "abort").length, 0);
    await clock.advance(100_000);
    assert.equal(clock.pendingTimers(), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
  } };
}

for (const { rate, finishMs } of [{ rate: 20, finishMs: 5_550 }, { rate: 10, finishMs: 11_550 }]) {
  test(`100 ticks wait past the cached packet at ${rate} tps`, async () => {
    const { bot, clock, assertClean } = pacedBot(rate);
    using _timers = clock.install();
    await clock.advance(500);
    using budget = serverPacedSignal(bot, 100);
    const controller = new AbortController();
    const pending = waitForServerPaced(bot, 100, { signal: controller.signal });
    const state = watch(pending);
    assert.equal(budget.end(), null);
    await clock.advance(finishMs - 100);
    assert.equal(bot.time.age, 1_100);
    assert.equal(state.over, false);
    assert.equal(budget.signal.aborted, false);
    await clock.advance(50);
    assert.equal(bot.time.age, 1_120);
    assert.equal(state.over, false, "the packet follows this look");
    await clock.advance(50);
    assert.equal(await pending, "ticks");
    assert.equal(clock.now(), 500 + finishMs);
    assert.deepEqual(budget.elapsed(), { ms: finishMs, ticks: 120 });
    assert.equal(budget.end(), "ticks");
    assert.ok(budget.signal.reason instanceof ServerPacedExpired);
    assert.equal(budget.signal.reason.end, "ticks");
    assert.equal(budget.signal.reason.ticks, 100);
    assert.equal(budget.signal.reason.elapsedMs, finishMs);
    assert.equal(budget.signal.reason.elapsedTicks, 120);
    await assertClean(controller.signal);
  });
}

test("an answer wins at creation or on the next configured look", async () => {
  for (const { untilAt, finishMs, checkMs, age } of [
    { untilAt: 0, finishMs: 0, checkMs: 50, age: 1_000 },
    { untilAt: 1_000, finishMs: 1_000, checkMs: 50, age: 1_020 },
    { untilAt: 1_000, finishMs: 1_036, checkMs: 37, age: 1_020 },
  ]) {
    const { bot, clock, assertClean } = pacedBot();
    using _timers = clock.install();
    const controller = new AbortController();
    const pending = waitForServerPaced(bot, 100, {
      clock, checkMs, wallMs: untilAt === 0 ? 0 : undefined,
      signal: controller.signal, until: () => clock.now() >= untilAt,
    });
    if (untilAt > 0) {
      const state = watch(pending);
      await clock.advance(999);
      assert.equal(state.over, false);
    }
    assert.equal(await clock.settle(pending, finishMs - clock.now(), 1), "until");
    assert.equal(clock.now(), finishMs);
    assert.equal(bot.time.age, age);
    await assertClean(controller.signal);
  }
});

for (const { ticks, stoppedMs, finishMs, end } of [
  { ticks: 100, stoppedMs: undefined, finishMs: 18_000, end: "wall" },
  { ticks: 600, stoppedMs: undefined, finishMs: 20_000, end: "stalled" },
  { ticks: 600, stoppedMs: null, finishMs: 93_000, end: "wall" },
]) {
  test(`a stopped server ends ${ticks} ticks on ${end} at ${finishMs} ms (stoppedMs ${stoppedMs})`, async () => {
    const { bot, clock, server, assertClean } = pacedBot();
    using _timers = clock.install();
    server.stop();
    using budget = serverPacedSignal(bot, ticks, { stoppedMs });
    const controller = new AbortController();
    const pending = waitForServerPaced(bot, ticks, { stoppedMs, signal: controller.signal });
    const state = watch(pending);
    await clock.advance(finishMs - 1);
    assert.equal(state.over, false);
    assert.equal(budget.end(), null);
    await clock.advance(1);
    assert.equal(await pending, end);
    assert.equal(budget.end(), end);
    assert.deepEqual(budget.elapsed(), { ms: finishMs, ticks: 0 });
    assert.equal(bot.time.age, 1_000);
    await assertClean(controller.signal);
  });
}

for (const latePacket of [false, true]) {
  test(`no initial age ends unobserved at 5000 ms, late packet ${latePacket}`, async () => {
    const { bot, clock, server, assertClean } = pacedBot(20, false);
    using _timers = clock.install();
    server.stop();
    using budget = serverPacedSignal(bot, 100);
    const controller = new AbortController();
    const pending = waitForServerPaced(bot, 100, { signal: controller.signal });
    const state = watch(pending);
    await clock.advance(1_000);
    if (latePacket) server.resendTime();
    await clock.advance(3_999);
    assert.equal(state.over, false);
    await clock.advance(1);
    assert.equal(await pending, "unobserved");
    assert.equal(budget.end(), "unobserved");
    assert.deepEqual(budget.elapsed(), { ms: 5_000, ticks: null });
    await assertClean(controller.signal);
  });
}

for (const ticksPerSecond of [20, 10]) {
  test(`the elapsed read names wall ms and world ticks at ${ticksPerSecond} tps, and no ticks when an age is missing at either end`, async () => {
    const { bot, clock } = pacedBot(ticksPerSecond);
    using _timers = clock.install();
    const elapsed = serverPacedElapsed(bot);
    assert.deepEqual(elapsed(), { elapsedMs: 0, elapsedTicks: 0 });
    await clock.advance(2_000);
    assert.deepEqual(elapsed(), { elapsedMs: 2_000, elapsedTicks: ticksPerSecond * 2 });
    const heard = bot.time;
    Object.defineProperty(bot, "time", { value: { age: null }, configurable: true });
    assert.deepEqual(elapsed(), { elapsedMs: 2_000, elapsedTicks: null }, "no age now: no tick count, not a difference with null");
    Object.defineProperty(bot, "time", { value: heard, configurable: true });
  });

  test(`the elapsed read of a wait begun before any time packet has no ticks at ${ticksPerSecond} tps`, async () => {
    const { bot, clock } = pacedBot(ticksPerSecond, false);
    using _timers = clock.install();
    const elapsed = serverPacedElapsed(bot);
    await clock.advance(1_000);
    assert.deepEqual(elapsed(), { elapsedMs: 1_000, elapsedTicks: null });
  });
}

test("disposing a budget twice leaves its signal live with no interval", async () => {
  const { bot, clock, assertClean } = pacedBot();
  using _timers = clock.install();
  const budget = serverPacedSignal(bot, 100);
  budget[Symbol.dispose]();
  budget[Symbol.dispose]();
  await assertClean();
  assert.equal(budget.signal.aborted, false);
  assert.equal(budget.end(), null);
});

for (const abortedAtCall of [false, true]) {
  test(`outer cancellation rejects its exact reason (already aborted ${abortedAtCall})`, async () => {
    const { bot, clock, assertClean } = pacedBot();
    using _timers = clock.install();
    const controller = new AbortController();
    const reason = new Error("body taken over");
    if (abortedAtCall) controller.abort(reason);
    const pending = waitForServerPaced(bot, 100, { signal: controller.signal, until: () => true === abortedAtCall });
    const rejected = assert.rejects(pending, (error) => error === reason);
    if (!abortedAtCall) {
      await clock.advance(1_000);
      controller.abort(reason);
    }
    await rejected;
    assert.equal(clock.now(), abortedAtCall ? 0 : 1_000);
    await assertClean(controller.signal);
  });
}

test("an until callback throwing on its third look rejects and stops looking", async () => {
  const { bot, clock, assertClean } = pacedBot();
  using _timers = clock.install();
  const controller = new AbortController();
  const reason = new Error("observation failed");
  let looks = 0;
  const pending = waitForServerPaced(bot, 100, { signal: controller.signal, until: () => {
    if (++looks === 3) throw reason;
    return false;
  } });
  const rejected = assert.rejects(pending, (error) => error === reason);
  await clock.advance(100);
  await rejected;
  await assertClean(controller.signal);
  assert.equal(looks, 3);
});

test("a death answer ends the observation without waiting for stopped physics", async () => {
  const { bot, clock, server, combat, assertClean } = pacedBot();
  using _timers = clock.install();
  const pending = waitForServerPaced(bot, 100, { until: () => bot.health <= 0 });
  await clock.advance(1_000);
  server.stop();
  combat.setHealth(0);
  assert.equal(await clock.settle(pending, 50), "until");
  await assertClean();
});

test("5 tps stress reaches the 18000 ms wall before 100 server ticks", async () => {
  const { bot, clock, server, assertClean } = pacedBot(5);
  using _timers = clock.install();
  using budget = serverPacedSignal(bot, 100);
  const pending = waitForServerPaced(bot, 100);
  const state = watch(pending);
  await clock.advance(17_999);
  assert.equal(state.over, false);
  await clock.advance(1);
  assert.equal(await pending, "wall");
  assert.equal(clock.now(), 18_000);
  assert.equal(server.gameTime, 1_090);
  assert.equal(bot.time.age, 1_080, "90 ticks run; the last complete packet carries 80");
  assert.deepEqual(budget.elapsed(), { ms: 18_000, ticks: 80 });
  await assertClean();
});

for (const { name, rate, noAge, stopped, wallMs, stoppedMs, finishMs, end, age } of [
  { name: "ticks over wall at 20 tps", rate: 20, wallMs: 6_050, finishMs: 6_050, end: "ticks", age: 1_120 },
  { name: "ticks over wall at 10 tps", rate: 10, wallMs: 12_050, finishMs: 12_050, end: "ticks", age: 1_120 },
  { name: "wall before unobserved", noAge: true, wallMs: 4_999, finishMs: 4_999, end: "wall", age: null },
  { name: "unobserved over wall", noAge: true, wallMs: 5_000, finishMs: 5_000, end: "unobserved", age: null },
  { name: "wall over stalled", stopped: true, wallMs: 20_000, finishMs: 20_000, end: "wall", age: 1_000 },
  { name: "custom stopped bound", stopped: true, stoppedMs: 123, finishMs: 123, end: "stalled", age: 1_000 },
]) {
  test(`classification: ${name}`, async () => {
    const { bot, clock, server, assertClean } = pacedBot(rate, !noAge);
    using _timers = clock.install();
    if (noAge || stopped) server.stop();
    const ticks = stopped ? 600 : 100;
    const options = { clock, wallMs, stoppedMs, checkMs: noAge || stopped ? 1 : 50 };
    using budget = serverPacedSignal(bot, ticks, options);
    const controller = new AbortController();
    const pending = waitForServerPaced(bot, ticks, { ...options, signal: controller.signal });
    const state = watch(pending);
    await clock.advance(finishMs - 1);
    assert.equal(state.over, false);
    assert.equal(budget.end(), null);
    await clock.advance(1);
    assert.equal(await pending, end);
    assert.equal(budget.end(), end);
    assert.equal(clock.now(), finishMs);
    assert.equal(bot.time.age, age);
    await assertClean(controller.signal);
  });
}

for (const kind of ["signal", "dispose", "until", "ticks", "wall", "stalled", "unobserved", "observation-error", "abort"] as const) {
  test(`cleanup fault preserves ${kind} settlement and releases listeners once`, async () => {
    const { bot, clock, server, assertClean } = pacedBot(20, kind !== "unobserved");
    using _timers = clock.install();
    if (kind !== "ticks") server.stop();
    const reason = new Error("observation or cancellation reason");
    let stops = 0;
    const throwingClock = { now: clock.now, every: (look: () => void, ms: number) => {
      const stop = clock.every(look, ms);
      return () => { stops++; stop(); throw new Error("disposer failed after removing interval"); };
    } };
    const wallMs = kind === "signal" || kind === "wall" ? 50 : undefined;
    const stoppedMs = kind === "stalled" ? 50 : undefined;
    const options = { clock: throwingClock, wallMs, stoppedMs };
    const controller = new AbortController();
    const budget = kind === "signal" || kind === "dispose" ? serverPacedSignal(bot, 100, options) : null;
    const pending = budget ? null : waitForServerPaced(bot, 100, { ...options, signal: controller.signal, until: () => {
      if (clock.now() < 50) return false;
      if (kind === "observation-error") throw reason;
      return kind === "until";
    } });
    const outcome = pending?.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    if (kind === "dispose") {
      assert.doesNotThrow(() => budget?.[Symbol.dispose]());
      assert.doesNotThrow(() => budget?.[Symbol.dispose]());
    } else {
      const finishMs = kind === "ticks" ? 6_050 : kind === "unobserved" ? 5_000 : 50;
      await assert.doesNotReject(clock.advance(finishMs));
      if (kind === "abort") controller.abort(reason);
      if (budget) {
        assert.equal(budget.signal.aborted, true);
        assert.ok(budget.signal.reason instanceof ServerPacedExpired);
        assert.equal(budget.signal.reason.end, "wall");
      } else {
        const result = await clock.settle(outcome!, 0);
        if (kind === "abort" || kind === "observation-error") assert.equal(result.error, reason);
        else assert.equal(result.value, kind);
      }
    }
    await assertClean(controller.signal);
    if (kind === "dispose") assert.equal(budget?.signal.aborted, false);
    assert.equal(stops, 1);
  });
}

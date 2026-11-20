// The idle window counts server ticks from the first age the bot hears, and every exit leaves nothing behind.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { observeIdleWindow, pollServerWindow } from "./idle-reflex-window.ts";

const NEVER = () => false;

/** Count how often a promise settles: a window that settled once must not settle again after the clock moves on. */
function countSettles(promise: Promise<unknown>): { count: number } {
  const settled = { count: 0 };
  const count = () => {
    settled.count++;
  };
  promise.then(count, count);
  return settled;
}

/** Each exit leaves no clock timer, no listener on the bot's events and no abort listener on its signal. */
function assertNothingLeft(clock: { pendingTimers(): number }, added: (event: string) => number, signal: AbortSignal) {
  assert.equal(clock.pendingTimers(), 0, "no clock timer left");
  assert.equal(added("physicsTick"), 0, "no physics listener left");
  assert.equal(added("time"), 0, "no time listener left");
  assert.equal(getEventListeners(signal, "abort").length, 0, "no abort listener left on the signal");
}

for (const { ticksPerSecond, minMs } of [
  { ticksPerSecond: 20, minMs: 47_000 },
  { ticksPerSecond: 10, minMs: 96_000 },
]) {
  test(`at ${ticksPerSecond} tps the window settles once the server ran 960 ticks, not before ${minMs} ms of clock`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { bot } = createFakeBot({ clock, server: { ticksPerSecond } });
    const controller = new AbortController();
    const added = listenersAddedSince(bot);
    const window = observeIdleWindow(bot, 960, NEVER, controller.signal);
    const settles = countSettles(window);
    const observed = await clock.settle(window, 120_000);
    assert.ok(observed.observedTicks >= 960, `observedTicks ${observed.observedTicks}`);
    assert.ok(clock.now() >= minMs, `settled at ${clock.now()} ms`);
    await clock.advance(60_000);
    assert.equal(settles.count, 1, "the window settles once, and not again past the old deadline");
    assertNothingLeft(clock, added, controller.signal);
  });
}

test("an aborted signal rejects the window with its reason and leaves no timer or listener", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot } = createFakeBot({ clock });
  const controller = new AbortController();
  const reason = new Error("cancelled idle window");
  const added = listenersAddedSince(bot);
  const window = observeIdleWindow(bot, 960, NEVER, controller.signal);
  const settles = countSettles(window);
  const rejected = assert.rejects(window, (error) => error === reason);
  await clock.advance(5_000);
  controller.abort(reason);
  await clock.settle(rejected, 5_000);
  await clock.advance(60_000);
  assert.equal(settles.count, 1, "the abort settles the window once");
  assertNothingLeft(clock, added, controller.signal);
});

/** Verify the clock, bot and signal are clean when the window has settled. */
function watchWindow<T>(
  { bot, clock }: ReturnType<typeof createFakeBot>,
  run: (signal: AbortSignal) => Promise<T>,
  controller = new AbortController(),
  workCount = () => 0,
) {
  const { signal } = controller;
  const added = listenersAddedSince(bot);
  const window = run(signal);
  const settles = countSettles(window);
  return {
    window,
    settles,
    async assertClean() {
      const workAtEnd = workCount();
      assertNothingLeft(clock, added, signal);
      assert.equal(clock.pendingGlobalTimers(), 0);
      await clock.advance(60_000);
      assert.equal(settles.count, 1);
      assert.equal(workCount(), workAtEnd, "no observation ran after the window settled");
      assertNothingLeft(clock, added, signal);
      assert.equal(clock.pendingGlobalTimers(), 0);
    },
  };
}

function watchPoll(harness: ReturnType<typeof createFakeBot>, ticks: number, poll: () => Promise<boolean>, controller?: AbortController) {
  let polls = 0;
  return watchWindow(harness, (signal) => pollServerWindow(harness.bot, ticks, () => {
    polls++;
    return poll();
  }, signal), controller, () => polls);
}

for (const { mode, ticksPerSecond } of [
  { mode: "idle", ticksPerSecond: 20 },
  { mode: "poll", ticksPerSecond: 10 },
]) {
  test(`the ${mode} window can end at +200 server ticks at ${ticksPerSecond} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const harness = createFakeBot({ clock, server: { ticksPerSecond } });
    const startAge = harness.server.age;
    const until = () => harness.server.age >= startAge + 200;
    const observation = mode === "poll"
      ? watchPoll(harness, 400, async () => until())
      : watchWindow(harness, (signal) => observeIdleWindow(harness.bot, 960, until, signal));
    const msPerTick = 1_000 / ticksPerSecond;
    const result = await clock.settle(observation.window, 240 * msPerTick);
    if (mode === "poll") assert.equal("ended" in result && result.ended, "poll");
    assert.ok([200, 220].includes(result.observedTicks), `observed ${result.observedTicks} ticks`);
    assert.equal(result.observedTicks, harness.server.age - startAge);
    assert.ok(clock.now() >= 200 * msPerTick && clock.now() <= 220 * msPerTick);
    await observation.assertClean();
  });
}

for (const mode of ["idle budget", "idle early", "poll budget"]) {
  test(`a ${mode} window starts with the first packet's age`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const harness = createFakeBot({ clock, server: { startAge: 50_000, timePacketYet: false } });
    assert.equal(harness.bot.time.age, null, "no age before the first time packet");
    if (mode === "poll budget") {
      const poll = watchPoll(harness, 100, async () => false);
      assert.deepEqual(await clock.settle(poll.window, 7_000), { ended: "ticks", observedTicks: 100 });
      assert.equal(harness.bot.time.age, 50_120);
      assert.equal(clock.now(), 6_000);
      await poll.assertClean();
    } else {
      const early = mode === "idle early";
      const observation = watchWindow(harness, (signal) => observeIdleWindow(harness.bot, 960, () => early, signal));
      const observed = await clock.settle(observation.window, early ? 5_000 : 120_000);
      if (early) assert.deepEqual(observed, { observedTicks: 0 });
      else assert.ok(observed.observedTicks >= 960 && observed.observedTicks < 1_040, `observedTicks ${observed.observedTicks}`);
      await observation.assertClean();
    }
  });
}

for (const { mode, timePacketYet, ticks } of [
  { mode: "idle", timePacketYet: true, ticks: 960 },
  { mode: "poll", timePacketYet: true, ticks: 400 },
  { mode: "poll", timePacketYet: false, ticks: 400 },
]) {
  test(`a stopped server fails the ${mode} window at 30 s ${timePacketYet ? "with" : "without"} an initial age`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const harness = createFakeBot({ clock, server: { timePacketYet } });
    harness.server.stop();
    const age = harness.bot.time.age;
    const observation = mode === "poll"
      ? watchPoll(harness, ticks, async () => false)
      : watchWindow(harness, (signal) => observeIdleWindow(harness.bot, ticks, NEVER, signal));
    const failure = assert.rejects(observation.window, {
      message: `${mode} window: the server's world age stood still for 30 s after 0 of ${ticks} ticks`,
    });
    await clock.advance(29_950);
    assert.equal(observation.settles.count, 0);
    await clock.advance(50);
    assert.equal(observation.settles.count, 1);
    await failure;
    assert.equal(harness.bot.time.age, age);
    await observation.assertClean();
  });
}

test("a poll window stalls 30 s after the last of several advancing time packets", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const harness = createFakeBot({ clock });
  const startAge = harness.server.age;
  const poll = watchPoll(harness, 400, async () => false);
  const failure = assert.rejects(poll.window, {
    message: "poll window: the server's world age stood still for 30 s after 60 of 400 ticks",
  });
  await clock.advance(3_250);
  harness.server.stop();
  assert.equal(harness.server.age - startAge, 60);
  await clock.advance(29_700);
  assert.equal(poll.settles.count, 0);
  await clock.advance(50);
  assert.equal(poll.settles.count, 1);
  await failure;
  await poll.assertClean();
});

test("aborting while the poll window waits for another time packet rejects immediately", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const harness = createFakeBot({ clock });
  const controller = new AbortController();
  const reason = new Error("cancelled tick wait");
  const poll = watchPoll(harness, 400, async () => false, controller);
  const failure = assert.rejects(poll.window, (error) => error === reason);
  await clock.advance(150);
  controller.abort(reason);
  await clock.settle(failure, 20);
  await poll.assertClean();
});

test("cancellation waits for an in-flight poll before rejecting with the abort reason", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const harness = createFakeBot({ clock });
  const controller = new AbortController();
  const reason = new Error("cancelled poll window");
  const pending = Promise.withResolvers<boolean>();
  const startAge = harness.server.age;
  const poll = watchPoll(harness, 400, async () => {
    if (harness.server.age === startAge) return false;
    return pending.promise;
  }, controller);
  const failure = assert.rejects(poll.window, (error) => error === reason);
  await clock.advance(2_000);
  assert.equal(harness.server.age - startAge, 40);
  controller.abort(reason);
  await clock.advance(150);
  assert.equal(poll.settles.count, 0, "three ticks after abort, the window is still waiting for the read");
  pending.resolve(true);
  await clock.settle(failure, 100);
  await poll.assertClean();
});

test("a rejected async poll rejects the window once", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const harness = createFakeBot({ clock });
  const error = new Error("the event read failed");
  const poll = watchPoll(harness, 400, async () => { throw error; });
  await assert.rejects(poll.window, (failure) => failure === error);
  await poll.assertClean();
});

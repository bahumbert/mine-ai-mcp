// The idle window counts server ticks from the first age the bot hears, and every exit leaves nothing behind.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { observeIdleWindow } from "./idle-reflex-window.ts";

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

test("an until that holds at +200 ticks ends the window within one time packet, with nothing left", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot } = createFakeBot({ clock });
  const controller = new AbortController();
  const added = listenersAddedSince(bot);
  const startAge = bot.time.age ?? 0;
  const window = observeIdleWindow(bot, 960, () => (bot.time.age ?? 0) - startAge >= 200, controller.signal);
  const settles = countSettles(window);
  const observed = await clock.settle(window, 60_000);
  assert.ok(observed.observedTicks >= 200 && observed.observedTicks < 260, `observedTicks ${observed.observedTicks}`);
  await clock.advance(60_000);
  assert.equal(settles.count, 1);
  assertNothingLeft(clock, added, controller.signal);
});

test("a stopped server fails the window at 30 s with the stall text, and nothing runs after it", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, server } = createFakeBot({ clock });
  const controller = new AbortController();
  const added = listenersAddedSince(bot);
  server.stop();
  const window = observeIdleWindow(bot, 960, NEVER, controller.signal);
  const settles = countSettles(window);
  const failed = assert.rejects(window, /idle window: the server's world age stood still for 30 s/);
  await clock.advance(31_000);
  assert.ok(clock.now() >= 30_000, `clock at ${clock.now()} ms`);
  await clock.settle(failed, 5_000);
  await clock.advance(60_000);
  assert.equal(settles.count, 1, "no { observedTicks } result, and nothing after the stall");
  assertNothingLeft(clock, added, controller.signal);
});

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

test("a bot that has heard no time packet counts from the first age it hears, not from zero", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot } = createFakeBot({ clock, server: { startAge: 50_000, timePacketYet: false } });
  assert.equal(bot.time.age, null, "no age before the first time packet");
  const observed = await clock.settle(observeIdleWindow(bot, 960, NEVER, new AbortController().signal), 120_000);
  assert.ok(observed.observedTicks >= 960 && observed.observedTicks < 1_040, `observedTicks ${observed.observedTicks}`);
});

test("an until that holds before any age is heard reports no ticks, not an absolute age", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot } = createFakeBot({ clock, server: { startAge: 50_000, timePacketYet: false } });
  const observed = await clock.settle(observeIdleWindow(bot, 960, () => true, new AbortController().signal), 5_000);
  assert.deepEqual(observed, { observedTicks: 0 });
});

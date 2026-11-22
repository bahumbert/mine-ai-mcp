import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createFakeClock } from "../test-support/fake-bot/fake-clock.js";
import { PHYSICS_TICK_WALL_MS, PhysicsStoppedError, physicsTicksUntil, waitForPhysicsTicks, waitForTicksOrCancel } from "./physics-ticks.js";

test("physics waits count observed ticks and release their listener", async () => {
  const source = new EventEmitter();
  const waiting = waitForPhysicsTicks(source, 2, new AbortController().signal);
  source.emit("physicsTick");
  assert.equal(source.listenerCount("physicsTick"), 1);
  source.emit("physicsTick");
  await waiting;
  assert.equal(source.listenerCount("physicsTick"), 0);
});

test("cancellation settles a physics wait when no further tick arrives", async () => {
  const source = new EventEmitter();
  const abort = new AbortController();
  const waiting = waitForPhysicsTicks(source, 20, abort.signal);
  abort.abort(new Error("connection ended"));
  await assert.rejects(waiting, /connection ended/);
  assert.equal(source.listenerCount("physicsTick"), 0);
  await assert.rejects(waitForPhysicsTicks(source, 1, abort.signal), /connection ended/);
  assert.equal(source.listenerCount("physicsTick"), 0);
});

test("a wall bound rejects PhysicsStoppedError when no tick comes", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const source = new EventEmitter();
  const waiting = waitForPhysicsTicks(source, 3, new AbortController().signal, { wallMs: 1_000 });
  source.emit("physicsTick");
  // Attached before the clock moves: the bound rejects during the advance.
  const rejected = assert.rejects(waiting, (error: unknown) => {
    assert.ok(error instanceof PhysicsStoppedError);
    assert.match((error as Error).message, /no physics tick for 1000 ms/);
    return true;
  });
  await clock.advance(1_000);
  await rejected;
  assert.equal(source.listenerCount("physicsTick"), 0);
});

test("ticks within the wall bound resolve and leave no timer", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const source = new EventEmitter();
  const abort = new AbortController();
  const waiting = waitForPhysicsTicks(source, 2, abort.signal, { wallMs: 1_000 });
  source.emit("physicsTick");
  source.emit("physicsTick");
  await waiting;
  // A timer left running would reject nothing now, but would keep the process alive in production.
  assert.equal(clock.pendingGlobalTimers(), 0, "the ticks settle the wait and clear its wall timer");
  await clock.advance(5_000);
  assert.equal(source.listenerCount("physicsTick"), 0);
  assert.equal(abort.signal.aborted, false);
});

test("an abort still rejects with the signal's reason when a wall bound is set", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const source = new EventEmitter();
  const abort = new AbortController();
  const waiting = waitForPhysicsTicks(source, 20, abort.signal, { wallMs: 1_000 });
  abort.abort(new Error("run stopped"));
  await assert.rejects(waiting, /run stopped/);
  assert.equal(source.listenerCount("physicsTick"), 0);
  assert.equal(clock.pendingGlobalTimers(), 0, "the abort clears the wall timer");
  // The cleared timer cannot turn the settled wait into a second rejection.
  await clock.advance(1_000);
});

test("a wait until a condition ends with its answer when the condition comes, the ticks run out, or physics stops", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const source = new EventEmitter();
  const signal = new AbortController().signal;
  let grounded = false;
  const settling = physicsTicksUntil(source, () => grounded, 60, signal);
  grounded = true;
  source.emit("physicsTick");
  assert.equal(await settling, true);
  assert.equal(source.listenerCount("physicsTick"), 0);

  const stopped = physicsTicksUntil(source, () => false, 60, signal);
  await clock.advance(PHYSICS_TICK_WALL_MS);
  assert.equal(await stopped, false);

  const outOfTicks = physicsTicksUntil(source, () => false, 2, signal);
  source.emit("physicsTick");
  await new Promise((resolve) => setImmediate(resolve));
  source.emit("physicsTick");
  assert.equal(await outOfTicks, false);

  const abort = new AbortController();
  const aborted = physicsTicksUntil(source, () => false, 60, abort.signal);
  abort.abort(new Error("run stopped"));
  await assert.rejects(aborted, /run stopped/);
});

/** A bot as the helper sees it: Mineflayer's own wait (counted here) and the tick event. */
function botWithOwnWait() {
  const source = new EventEmitter();
  const waits: number[] = [];
  return Object.assign(source, {
    waits,
    waitForTicks: async (ticks: number) => void waits.push(ticks),
  });
}

test("a tick wait with a signal is released by the abort when no tick comes, and leaves no listener", async () => {
  const bot = botWithOwnWait();
  const abort = new AbortController();
  const waiting = waitForTicksOrCancel(bot, 1, abort.signal);
  assert.equal(bot.listenerCount("physicsTick"), 1);
  abort.abort(new Error("bot died"));
  await assert.rejects(waiting, /bot died/);
  assert.equal(bot.listenerCount("physicsTick"), 0);
  assert.deepEqual(bot.waits, [], "the signalled wait does not use Mineflayer's five-second wait");
});

test("a tick wait with a signal and no tick or abort still ends at Mineflayer's own bound, with PhysicsStoppedError", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const bot = botWithOwnWait();
  const waiting = waitForTicksOrCancel(bot, 2, new AbortController().signal);
  const rejected = assert.rejects(waiting, (error: unknown) => error instanceof PhysicsStoppedError && /no physics tick for 5100 ms/.test(error.message));
  await clock.advance(2 * 50 + 5_000 - 1);
  assert.equal(bot.listenerCount("physicsTick"), 1, "still waiting one ms before the bound");
  await clock.advance(1);
  await rejected;
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("a tick wait with no signal keeps Mineflayer's own wait: nothing can cancel the action", async () => {
  const bot = botWithOwnWait();
  await waitForTicksOrCancel(bot, 3, undefined);
  assert.deepEqual(bot.waits, [3]);
});

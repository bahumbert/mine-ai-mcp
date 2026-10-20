import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PHYSICS_TICK_WALL_MS, PhysicsStoppedError, physicsTicksUntil, waitForPhysicsTicks } from "./physics-ticks.js";

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

test("a wall bound rejects PhysicsStoppedError when no tick comes", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const source = new EventEmitter();
  const waiting = waitForPhysicsTicks(source, 3, new AbortController().signal, { wallMs: 1_000 });
  source.emit("physicsTick");
  context.mock.timers.tick(1_000);
  await assert.rejects(waiting, (error: unknown) => {
    assert.ok(error instanceof PhysicsStoppedError);
    assert.match((error as Error).message, /no physics tick for 1000 ms/);
    return true;
  });
  assert.equal(source.listenerCount("physicsTick"), 0);
});

test("ticks within the wall bound resolve and leave no timer", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const source = new EventEmitter();
  const abort = new AbortController();
  const waiting = waitForPhysicsTicks(source, 2, abort.signal, { wallMs: 1_000 });
  source.emit("physicsTick");
  source.emit("physicsTick");
  await waiting;
  // A timer left running would reject nothing now, but would keep the process alive in production.
  context.mock.timers.tick(5_000);
  assert.equal(source.listenerCount("physicsTick"), 0);
  assert.equal(abort.signal.aborted, false);
});

test("an abort still rejects with the signal's reason when a wall bound is set", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const source = new EventEmitter();
  const abort = new AbortController();
  const waiting = waitForPhysicsTicks(source, 20, abort.signal, { wallMs: 1_000 });
  abort.abort(new Error("run stopped"));
  await assert.rejects(waiting, /run stopped/);
  assert.equal(source.listenerCount("physicsTick"), 0);
  // The cleared timer cannot turn the settled wait into a second rejection.
  context.mock.timers.tick(1_000);
});

test("a wait until a condition ends with its answer when the condition comes, the ticks run out, or physics stops", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const source = new EventEmitter();
  const signal = new AbortController().signal;
  let grounded = false;
  const settling = physicsTicksUntil(source, () => grounded, 60, signal);
  grounded = true;
  source.emit("physicsTick");
  assert.equal(await settling, true);
  assert.equal(source.listenerCount("physicsTick"), 0);

  const stopped = physicsTicksUntil(source, () => false, 60, signal);
  context.mock.timers.tick(PHYSICS_TICK_WALL_MS);
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

import assert from "node:assert/strict";
import test from "node:test";
import type { StallClock } from "../actions/stall-watch.js";
import { flush, handClock } from "../test-support/hand-clock.js";
import { BodyAbort } from "./abort.js";
import { watchBodyOwner, type BodyLimitHit, type BodyWatchEnd, type BodyWatchOptions } from "./body-watch.js";

/** A watch on a run the test settles by hand, with the options filled in; each is overridable. */
function watched<Value = string>(clock: StallClock, overrides: Partial<BodyWatchOptions> = {}) {
  const controller = new AbortController();
  const hits: BodyLimitHit[] = [];
  let ticksAt = 0;
  let settle!: (value: Value) => void;
  let fail!: (cause: unknown) => void;
  const run = new Promise<Value>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  let end: BodyWatchEnd<Value> | null = null;
  const options: BodyWatchOptions = {
    owner: "fire_reflex",
    signal: controller.signal,
    controller,
    clock,
    cancelGraceMs: 500,
    lastPhysicsTickAt: () => ticksAt,
    physicsExpected: () => true,
    abortFor: (limit, elapsedMs) => new BodyAbort({ kind: "reflex_limit", reflex: "fire_reflex", limit, elapsedMs }, `limit ${limit}`),
    cancelledWithoutTicks: (owner, reason) => `${reason} (${owner} did not stop)`,
    onLimit: (hit) => hits.push(hit),
    ...overrides,
  };
  void watchBodyOwner(run, options).then((value) => (end = value));
  return {
    controller, hits, settle, fail,
    /** A physics tick happened at this reading of the clock. */
    tickedAt: (at: number) => { ticksAt = at; },
    end: () => end,
  };
}

test("no physics tick for the stall limit aborts the owner with reflex_limit physics_stalled, then releases it after the grace", async () => {
  const time = handClock();
  const watch = watched(time.clock, { stallMs: 1_000 });
  await time.advance(950);
  assert.equal(watch.hits.length, 0);
  await time.advance(100);
  assert.equal(watch.hits.length, 1);
  assert.equal(watch.hits[0]!.limit, "physics_stalled");
  const reason = watch.controller.signal.reason;
  assert.ok(reason instanceof BodyAbort && reason.detail.kind === "reflex_limit" && reason.detail.limit === "physics_stalled");
  assert.equal(watch.end(), null, "the owner has the grace to stop on its own");
  await time.advance(500);
  assert.deepEqual(watch.end(), { kind: "released", hit: watch.hits[0], cancelled: null });
});

test("a server that ticks every 150 ms is not stalled, however long the owner waits", async () => {
  const time = handClock();
  const watch = watched(time.clock, { stallMs: 1_000 });
  for (let step = 0; step < 100; step += 1) {
    await time.advance(150, 50);
    watch.tickedAt(time.clock.now());
  }
  assert.equal(watch.hits.length, 0);
  assert.equal(watch.end(), null);
});

test("in a vehicle no tick is owed: no stall, and the ceiling still ends the claim", async () => {
  const time = handClock();
  const watch = watched(time.clock, { stallMs: 1_000, physicsExpected: () => false, ceilingMs: 5_000 });
  await time.advance(4_900);
  assert.equal(watch.hits.length, 0);
  await time.advance(200);
  assert.deepEqual(watch.hits.map((hit) => hit.limit), ["ceiling"]);
});

test("past the ceiling the owner is aborted with reflex_limit ceiling, onLimit is called once, and the elapsed time is the claim's age", async () => {
  const time = handClock();
  const watch = watched(time.clock, { ceilingMs: 2_000 });
  await time.advance(5_000);
  assert.equal(watch.hits.length, 1);
  assert.equal(watch.hits[0]!.limit, "ceiling");
  assert.equal(watch.hits[0]!.elapsedMs, 2_000);
});

test("marks that do not change for the no-progress limit abort the owner with no_progress, and a mark resets the clock", async () => {
  const time = handClock();
  let marks = 0;
  const watch = watched(time.clock, { noProgress: { ms: 6_000, marks: () => marks } });
  await time.advance(4_000);
  marks += 1;
  await time.advance(5_900);
  assert.equal(watch.hits.length, 0, "5.9 s since the mark");
  await time.advance(300);
  assert.deepEqual(watch.hits.map((hit) => hit.limit), ["no_progress"]);
});

test("two limits that trip together report one: the first", async () => {
  const time = handClock();
  const watch = watched(time.clock, { ceilingMs: 2_000, noProgress: { ms: 2_000, marks: () => 0 }, stallMs: 2_000 });
  await time.advance(3_000);
  assert.equal(watch.hits.length, 1);
});

test("an owner that ignores the abort is released after the grace; its late settle changes nothing", async () => {
  const time = handClock();
  const watch = watched(time.clock, { ceilingMs: 1_000 });
  await time.advance(1_600);
  assert.equal(watch.end()?.kind, "released");
  const released = watch.end();
  watch.settle("late");
  await flush();
  assert.equal(watch.end(), released);
  assert.equal(watch.hits.length, 1);
  assert.equal(time.timers(), 0);
});

test("an owner that settles inside the grace keeps its value, and the hit is reported", async () => {
  const time = handClock();
  const watch = watched(time.clock, { ceilingMs: 1_000 });
  await time.advance(1_100);
  watch.settle("stopped");
  await flush();
  assert.deepEqual(watch.end(), { kind: "settled", value: "stopped", hit: watch.hits[0] });
});

test("an owner that throws after a hit is reported as thrown with the hit; without a hit as thrown alone", async () => {
  const time = handClock();
  const cause = new Error("dig interrupted");
  const hit = watched(time.clock, { ceilingMs: 1_000 });
  await time.advance(1_100);
  hit.fail(cause);
  await flush();
  assert.deepEqual(hit.end(), { kind: "threw", cause, hit: hit.hits[0] });
  const plain = watched(time.clock, { ceilingMs: 100_000 });
  plain.fail(cause);
  await flush();
  assert.deepEqual(plain.end(), { kind: "threw", cause, hit: null });
});

test("a cancel the owner cannot act on for want of ticks releases it after the grace, with no limit hit", async () => {
  const time = handClock();
  const watch = watched(time.clock, { stallMs: 10_000 });
  await time.advance(200);
  watch.controller.abort(new Error("stop"));
  await time.advance(450);
  assert.equal(watch.end(), null);
  await time.advance(100);
  assert.deepEqual(watch.end(), { kind: "released", hit: null, cancelled: "stop (fire_reflex did not stop)" });
  assert.equal(watch.hits.length, 0);
});

test("the abandon signal ends the watch and stops every timer", async () => {
  const time = handClock();
  const abandon = new AbortController();
  const watch = watched(time.clock, { stallMs: 1_000, ceilingMs: 5_000, noProgress: { ms: 3_000, marks: () => 0 }, abandon: abandon.signal });
  assert.equal(time.timers(), 2, "one timer for the limits, one for the no-progress sampler");
  abandon.abort(new Error("disconnected"));
  await flush();
  assert.equal(watch.end()?.kind, "released");
  assert.equal(time.timers(), 0);
});

test("no timer is left after the owner settles on its own, with every limit set", async () => {
  const time = handClock();
  const watch = watched(time.clock, { stallMs: 1_000, ceilingMs: 5_000, noProgress: { ms: 3_000, marks: () => 0 } });
  await time.advance(100);
  watch.settle("done");
  await flush();
  assert.equal(watch.end()?.kind, "settled");
  assert.equal(time.timers(), 0);
});

test("with no limit set the watch starts no timer and passes the run through", async () => {
  const time = handClock();
  const watch = watched(time.clock);
  assert.equal(time.timers(), 0);
  watch.settle("done");
  await flush();
  assert.deepEqual(watch.end(), { kind: "settled", value: "done", hit: null });
});

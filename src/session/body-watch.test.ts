import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import type { StallClock } from "../actions/stall-watch.js";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../test-support/fake-bot/index.js";
import { flush, handClock } from "../test-support/hand-clock.js";
import { serverPacedWallMs } from "../world/world-age.js";
import { BodyAbort } from "./abort.js";
import { watchBodyOwner, type BodyLimitHit, type BodyWatchEnd, type BodyWatchOptions } from "./body-watch.js";

/** A watch on a run the test settles by hand, with the options filled in; each is overridable. */
function watched<Value = string>(clock: StallClock, overrides: Partial<BodyWatchOptions> = {}) {
  const controller = new AbortController();
  const hits: BodyLimitHit[] = [];
  const hitAtMs: number[] = [];
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
    abortFor: (limit, elapsedMs, elapsedTicks) => new BodyAbort({ kind: "reflex_limit", reflex: "fire_reflex", limit, elapsedMs, elapsedTicks }, `limit ${limit}`),
    cancelledWithoutTicks: (owner, reason) => `${reason} (${owner} did not stop)`,
    onLimit: (hit) => {
      hits.push(hit);
      hitAtMs.push(clock.now());
    },
    ...overrides,
  };
  void watchBodyOwner(run, options).then((value) => (end = value));
  return {
    controller, hits, hitAtMs, settle, fail,
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
  const watch = watched(time.clock, { stallMs: 1_000, physicsExpected: () => false, ceilingTicks: 100 });
  await time.advance(4_900);
  assert.equal(watch.hits.length, 0);
  await time.advance(200);
  assert.deepEqual(watch.hits.map((hit) => hit.limit), ["ceiling"]);
});

// Run 20 (Vex): a ride over 30 s ended in a get-off and the watch counted the whole ride as silence. The watches below
// check at every step the hand clock takes, so `advance(ms, 250)` checks at 250, 500, ...; a check owes a tick when
// `physicsExpected()` is true at it.
test("no tick for the stall limit after a ride is counted from the first check that owes one, not from before the ride", async () => {
  const time = handClock();
  const watch = watched(time.clock, { stallMs: 1_000, physicsExpected: () => time.clock.now() > 3_100 });
  await time.advance(4_000, 250);
  assert.equal(watch.hits.length, 0, "the first check that owes a tick is at 3250");
  await time.advance(250, 250);
  assert.deepEqual(watch.hits.map((hit) => [hit.limit, hit.elapsedMs]), [["physics_stalled", 1_000]], "a real stall after the ride is still caught");
});

for (const getOffAt of [3_100, 6_100]) {
  test(`a server that ticks every 150 ms after a ride that ended at ${getOffAt} ms is not stalled (a get-off answered late too)`, async () => {
    const time = handClock();
    const watch = watched(time.clock, { stallMs: 1_000, physicsExpected: () => time.clock.now() > getOffAt });
    for (let step = 0; step < 200; step += 1) {
      await time.advance(50, 50);
      if (time.clock.now() > getOffAt && time.clock.now() % 150 === 0) watch.tickedAt(time.clock.now());
    }
    assert.ok(time.clock.now() >= 10_000);
    assert.equal(watch.hits.length, 0);
  });
}

test("a second ride restarts the count: the silence is measured from the first check that owes a tick again", async () => {
  const time = handClock();
  const seatedNow = () => time.clock.now() <= 3_100 || (time.clock.now() > 3_600 && time.clock.now() <= 6_100);
  const watch = watched(time.clock, { stallMs: 1_000, physicsExpected: () => !seatedNow() });
  await time.advance(7_000, 250);
  assert.equal(watch.hits.length, 0, "owed 3250-3500 only, then seated again until 6100");
  await time.advance(250, 250);
  assert.deepEqual(watch.hits.map((hit) => [hit.limit, hit.elapsedMs]), [["physics_stalled", 1_000]], "6250 + 1000");
});

test("past the ceiling the owner is aborted with reflex_limit ceiling, onLimit is called once, and the elapsed time is the claim's age", async () => {
  const time = handClock();
  const watch = watched(time.clock, { ceilingTicks: 40 });
  await time.advance(5_000);
  assert.equal(watch.hits.length, 1);
  assert.equal(watch.hits[0]!.limit, "ceiling");
  assert.equal(watch.hits[0]!.elapsedMs, 2_000, "no world age: the ticks count 50 ms each");
  assert.equal(watch.hits[0]!.elapsedTicks, null);
});

test("marks that do not change for the no-progress limit abort the owner with no_progress, and a mark resets the clock", async () => {
  const time = handClock();
  let marks = 0;
  const watch = watched(time.clock, { noProgress: { ticks: 120, marks: () => marks } });
  await time.advance(4_000);
  marks += 1;
  await time.advance(5_900);
  assert.equal(watch.hits.length, 0, "5.9 s since the mark");
  await time.advance(300);
  assert.deepEqual(watch.hits.map((hit) => hit.limit), ["no_progress"]);
});

test("two limits that trip together report one: the first", async () => {
  const time = handClock();
  const watch = watched(time.clock, { ceilingTicks: 40, noProgress: { ticks: 40, marks: () => 0 }, stallMs: 2_000 });
  await time.advance(3_000);
  assert.equal(watch.hits.length, 1);
});

test("an owner that ignores the abort is released after the grace; its late settle changes nothing", async () => {
  const time = handClock();
  const watch = watched(time.clock, { ceilingTicks: 20 });
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
  const watch = watched(time.clock, { ceilingTicks: 20 });
  await time.advance(1_100);
  watch.settle("stopped");
  await flush();
  assert.deepEqual(watch.end(), { kind: "settled", value: "stopped", hit: watch.hits[0] });
});

test("an owner that throws after a hit is reported as thrown with the hit; without a hit as thrown alone", async () => {
  const time = handClock();
  const cause = new Error("dig interrupted");
  const hit = watched(time.clock, { ceilingTicks: 20 });
  await time.advance(1_100);
  hit.fail(cause);
  await flush();
  assert.deepEqual(hit.end(), { kind: "threw", cause, hit: hit.hits[0] });
  const plain = watched(time.clock, { ceilingTicks: 2_000 });
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
  const watch = watched(time.clock, { stallMs: 1_000, ceilingTicks: 100, noProgress: { ticks: 60, marks: () => 0 }, abandon: abandon.signal });
  abandon.abort(new Error("disconnected"));
  await flush();
  assert.equal(watch.end()?.kind, "released");
  assert.equal(time.timers(), 0);
});

// The optional limits (plan 2026-11-16-reflex-limits-ticks T2 step 1f), on the shared fake clock so the checks run at the
// cadence of the shortest limit: the production foreground caller sets `stallMs` only, a claim sets the other two. Each is
// bounded when the run hangs; when the run settles first the end is exactly `settled` with no hit, and no timer or hit
// is left past every old deadline. The last rows: no limit at all (no timer, the run passes through) and all three.
for (const { name, limits, hit } of [
  { name: "the stall limit alone (the foreground caller)", limits: { stallMs: 1_000 }, hit: "physics_stalled" },
  { name: "the ceiling alone", limits: { ceilingTicks: 20 }, hit: "ceiling" },
  { name: "the no-progress window alone", limits: { noProgress: { ticks: 20, marks: () => 0 } }, hit: "no_progress" },
  { name: "every limit", limits: { stallMs: 1_000, ceilingTicks: 100, noProgress: { ticks: 60, marks: () => 0 } }, hit: "physics_stalled" },
  { name: "no limit", limits: {}, hit: null },
] as const) {
  test(`${name}: ${hit ?? "no limit"} when the run hangs; a run that settles leaves no timer and no hit`, async () => {
    const hangingClock = createFakeClock({ mode: "manual" });
    const hanging = watched(hangingClock, limits);
    await hangingClock.advance(1_600);
    assert.deepEqual(hanging.hits.map((one) => one.limit), hit === null ? [] : [hit]);

    const settlingClock = createFakeClock({ mode: "manual" });
    const settled = watched(settlingClock, limits);
    await settlingClock.advance(100);
    settled.settle("done");
    await flush();
    assert.deepEqual(settled.end(), { kind: "settled", value: "done", hit: null });
    assert.equal(settlingClock.pendingTimers(), 0);
    await settlingClock.advance(120_000, 1_000);
    assert.equal(settled.hits.length, 0, "nothing fires after the run is over");
  });
}

// The limits count the server's world age (plan 2026-11-16-reflex-limits-ticks T2). The packet of age `A + k` falls
// `k * msPerTick` after the server starts (one packet per 20 ticks at any rate, `world-age.test.ts`); each watch starts
// `CREATED_AFTER_MS` after the packet of age `A`, so its cached age is `A`.
const START_AGE = 1_000;
const CREATED_AFTER_MS = 500;
/** A quarter of the shortest limit (100 ticks = 5 000 ms), capped at 250: `checkEveryMs`. */
const CHECK_MS = 250;
const RATES = [
  { ticksPerSecond: 20, msPerTick: 50 },
  { ticksPerSecond: 10, msPerTick: 100 },
] as const;

/** A watch on the shared fake bot's server, started `CREATED_AFTER_MS` after the packet of age `A`; `limits` gets the age reader. */
async function watchedOnServer(ticksPerSecond: number, limits: (age: () => number) => Partial<BodyWatchOptions>) {
  const clock = createFakeClock({ mode: "manual" });
  const harness = createFakeBot({ clock, server: { startAge: START_AGE, ticksPerSecond } });
  await clock.advance(CREATED_AFTER_MS);
  const age = () => harness.bot.time.age;
  const added = listenersAddedSince(harness.bot);
  const watch = watched(clock, { worldAge: age, ...limits(age) });
  return { ...harness, clock, watch, age, added, createdMs: clock.now() };
}

for (const { ticksPerSecond, msPerTick } of RATES) {
  test(`no progress for 100 ticks ends at the first check after the packet of age A + 120, not at A + 100 (${ticksPerSecond} tps)`, async () => {
    const { clock, watch, age, createdMs } = await watchedOnServer(ticksPerSecond, () => ({ noProgress: { ticks: 100, marks: () => 0 } }));
    await clock.advance(100 * msPerTick + CHECK_MS - createdMs);
    assert.equal(age(), START_AGE + 100);
    assert.equal(watch.hits.length, 0, "A + 100: 20 ticks short of the window, one packet of margin");
    await clock.advance(20 * msPerTick);
    assert.equal(age(), START_AGE + 120);
    assert.equal(watch.hits.length, 1);
    const [hit] = watch.hits;
    assert.equal(hit!.limit, "no_progress");
    assert.equal(hit!.elapsedTicks, 120);
    assert.ok(watch.hitAtMs[0]! >= 120 * msPerTick && watch.hitAtMs[0]! <= 120 * msPerTick + CHECK_MS, `hit at ${watch.hitAtMs[0]} ms, the packet at ${120 * msPerTick} ms`);
    assert.equal(hit!.elapsedMs, watch.hitAtMs[0]! - createdMs, "the measured window, not the configured one");
  });

  test(`a mark read at the cached age A + 40 restarts the window from that age: it ends 120 ticks later (${ticksPerSecond} tps)`, async () => {
    let marks = 0;
    const { clock, watch, age, createdMs } = await watchedOnServer(ticksPerSecond, () => ({ noProgress: { ticks: 100, marks: () => marks } }));
    await clock.advance(40 * msPerTick + 100 - createdMs);
    marks += 1; // read at the next check, while the cached age is A + 40 (the packet of A + 60 is 20 ticks on)
    await clock.advance(80 * msPerTick + CHECK_MS);
    assert.equal(age(), START_AGE + 120);
    assert.equal(watch.hits.length, 0, "the first window would end here; the mark moved it");
    await clock.advance(20 * msPerTick);
    assert.equal(age(), START_AGE + 140);
    assert.equal(watch.hits.length, 0, "A + 140: the renewed window's last packet before its end");
    await clock.advance(20 * msPerTick);
    assert.equal(age(), START_AGE + 160);
    assert.equal(watch.hits.length, 1);
    assert.equal(watch.hits[0]!.elapsedTicks, 120, "from the age cached at the restart's check");
  });

  test(`a ceiling of 200 ticks with marks at every packet ends at the first check after the packet of age A + 220 (${ticksPerSecond} tps)`, async () => {
    const { clock, watch, age, createdMs } = await watchedOnServer(ticksPerSecond, (readAge) => ({
      ceilingTicks: 200,
      noProgress: { ticks: 100, marks: () => Math.floor(readAge() / 20) },
    }));
    await clock.advance(200 * msPerTick + CHECK_MS - createdMs);
    assert.equal(age(), START_AGE + 200);
    assert.equal(watch.hits.length, 0, "the marks kept the window open, A + 200 is a packet short of the ceiling");
    await clock.advance(20 * msPerTick);
    assert.equal(age(), START_AGE + 220);
    assert.deepEqual(watch.hits.map((hit) => [hit.limit, hit.elapsedTicks]), [["ceiling", 220]]);
  });

  test(`a stopped server ends the no-progress window on its wall, 18 000 ms, before the 20 s of a still clock (${ticksPerSecond} tps)`, async () => {
    const { clock, server, watch, createdMs } = await watchedOnServer(ticksPerSecond, () => ({ noProgress: { ticks: 100, marks: () => 0 } }));
    server.stop();
    await clock.advance(18_000 - CHECK_MS);
    assert.equal(watch.hits.length, 0, "17 750 ms after the start");
    await clock.advance(2 * CHECK_MS);
    assert.equal(watch.hits.length, 1);
    assert.ok(watch.hitAtMs[0]! - createdMs >= 18_000 && watch.hitAtMs[0]! - createdMs <= 18_000 + CHECK_MS);
    assert.equal(watch.hits[0]!.elapsedTicks, 0, "the age never moved");
  });

  test(`a stopped server ends a 600-tick no-progress window after 20 s of a still clock, not on its 93 s wall (${ticksPerSecond} tps)`, async () => {
    const { clock, server, watch, createdMs } = await watchedOnServer(ticksPerSecond, () => ({ noProgress: { ticks: 600, marks: () => 0 } }));
    server.stop();
    await clock.advance(20_000 - CHECK_MS);
    assert.equal(watch.hits.length, 0, "19 750 ms after the start");
    await clock.advance(2 * CHECK_MS);
    assert.equal(watch.hits.length, 1);
    assert.ok(watch.hitAtMs[0]! - createdMs >= 20_000 && watch.hitAtMs[0]! - createdMs <= 20_000 + CHECK_MS);
  });

  test(`the ceiling of a stopped server ends on its 33 000 ms wall, whatever the marks do (${ticksPerSecond} tps)`, async () => {
    let marks = 0;
    const { clock, server, watch, createdMs } = await watchedOnServer(ticksPerSecond, () => ({
      ceilingTicks: 200,
      noProgress: { ticks: 100, marks: () => marks },
    }));
    server.stop();
    for (let second = 0; second < 32; second += 1) {
      marks += 1;
      await clock.advance(1_000);
    }
    await clock.advance(750);
    assert.equal(clock.now() - createdMs, serverPacedWallMs(200) - 250);
    assert.equal(watch.hits.length, 0, "32 750 ms: the marks moved every second, the ceiling is not there yet");
    await clock.advance(500);
    assert.deepEqual(watch.hits.map((hit) => hit.limit), ["ceiling"]);
    assert.ok(watch.hitAtMs[0]! - createdMs >= serverPacedWallMs(200) && watch.hitAtMs[0]! - createdMs <= serverPacedWallMs(200) + CHECK_MS);
    assert.equal(watch.hits[0]!.elapsedMs, watch.hitAtMs[0]! - createdMs);
  });

  // The exits of the world-age path (T6, T13): each ends the watch once with its own end and the hits it had, and leaves no
  // timer, no listener on the bot and no `abort` listener on the abandon signal, however far past the wall the clock goes.
  const exits: ReadonlyArray<{
    readonly name: string;
    readonly act: (watch: Awaited<ReturnType<typeof watchedOnServer>>["watch"], abandon: AbortController) => void;
    readonly end: "settled" | "threw" | "released";
    readonly hits: number;
    /** The limit runs into the ignored owner first: the clock goes past its window and grace before the exit. */
    readonly afterLimit?: true;
  }> = [
    { name: "the run settles", act: (watch) => watch.settle("done"), end: "settled", hits: 0 },
    { name: "the run throws", act: (watch) => watch.fail(new Error("dig interrupted")), end: "threw", hits: 0 },
    { name: "the owner is released after a limit it ignored", act: () => {}, end: "released", hits: 1, afterLimit: true },
    { name: "the connection ends (abandon)", act: (_watch, abandon) => abandon.abort(new Error("disconnected")), end: "released", hits: 0 },
  ];
  for (const { name, act, end, hits, afterLimit } of exits) {
    test(`${name}: ends ${end} with ${hits} hit(s), no timer and no listener left after the wall (${ticksPerSecond} tps)`, async () => {
      const abandon = new AbortController();
      const abandonListeners = () => getEventListeners(abandon.signal, "abort").length;
      const before = abandonListeners();
      const { clock, watch, added } = await watchedOnServer(ticksPerSecond, () => ({
        ceilingTicks: 200, noProgress: { ticks: 100, marks: () => 0 }, abandon: abandon.signal,
      }));
      assert.equal(abandonListeners(), before + 1, "the watch listens for the connection's end");
      if (afterLimit) await clock.advance(120 * msPerTick + 2_000);
      act(watch, abandon);
      await clock.advance(1_000);
      assert.equal(watch.end()?.kind, end);
      assert.equal(watch.hits.length, hits);
      assert.equal(clock.pendingTimers(), 0);
      assert.equal(abandonListeners(), before, "the abandon listener is gone");
      for (const event of ["time", "physicsTick", "entityGone", "death", "end"]) assert.equal(added(event), 0, event);
      await clock.advance(serverPacedWallMs(200) + 1_000, 250);
      assert.equal(watch.hits.length, hits, "no hit after the old wall");
    });
  }
}

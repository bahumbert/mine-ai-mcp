import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { parseHuntMobRequest } from "./contract.js";
import type { Navigate } from "../../navigation/index.js";
import { type CampFailure, observationWindow, SpawnerCamp } from "./spawner-camp.js";

const SPAWNER = new Vec3(0, 64, 0);

// The camp's windows are game time (plan 2026-11-18-scenario-reds-part2-a3 T13f, D32): a wait of `t` ticks ends at the first
// time packet `ceil((t + 20) / 20) * 20` ticks after the age cached at its start; packets come each 1 000 ms at 20 tps
// and each 2 000 ms at 10 tps.
const CAMP_RATES = [
  { ticksPerSecond: 20, msPerTick: 50 },
  { ticksPerSecond: 10, msPerTick: 100 },
] as const;
const SLICE_MS = 50;

/** The camp reads `Date.now` and waits on timers: the clock is a mocked one a test installs when it waits. */
function fixture(waitMs = 15, ticksPerSecond = 20) {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, world, server } = createFakeBot({ position: new Vec3(20.5, 64, 0.5), cells: { "0,64,0": "spawner" }, clock, server: { ticksPerSecond } });
  let routes = 0;
  let returnTo = async (position: Vec3, _signal: AbortSignal): ReturnType<Navigate> => {
    routes++;
    bot.entity.position = position.offset(1.5, 0, 0.5);
    return { status: "completed", elapsedMs: 1 };
  };
  const camp = new SpawnerCamp(bot, SPAWNER, waitMs, (position, signal) => returnTo(position, signal));
  return {
    bot,
    clock,
    camp,
    routes: () => routes,
    destroy: () => world.setCell(SPAWNER, "air"),
    stopServer: () => server.stop(),
    /** Replace the route the camp walks home with (the default walks 1.5 blocks from the spawner at once). */
    routeWith: (route: typeof returnTo) => { returnTo = route; },
    startAge: bot.time.age,
  };
}

test("normal hunting defaults to no wait; camping requires explicit finite patience", () => {
  const input = { mob_name: "blaze", drop_name: "blaze_rod" };
  assert.equal(parseHuntMobRequest(input).observeForMs, 0);
  assert.equal(parseHuntMobRequest(input).campSpawner, false);
  assert.throws(() => parseHuntMobRequest({ ...input, camp_spawner: true }), /positive observe_for_ms/);
  assert.equal(parseHuntMobRequest({ ...input, camp_spawner: true, observe_for_ms: 100 }).campSpawner, true);
});

test("an empty camp returns observation_exhausted after one return and a finite wait", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  const waiting = f.camp.waitForQuarry(() => false, new AbortController().signal);
  // The away wait (15 ms = 1 tick: the packet at +40 ticks, 2 000 ms), the return, then the wait at the spawner (the same).
  const result = await f.clock.settle(waiting, 10_000, SLICE_MS);
  assert.equal(result?.termination, "observation_exhausted");
  assert.equal(f.routes(), 1);
  assert.ok(f.camp.snapshot.observationUntil);
});

test("new quarry resumes hunting without resetting an interrupted camp deadline", async () => {
  const f = fixture(30);
  using _timers = f.clock.install();
  f.bot.entity.position = new Vec3(1.5, 64, 0.5);
  const stop = new AbortController();
  const pending = f.camp.waitForQuarry(() => false, stop.signal);
  const deadline = f.camp.snapshot.observationUntil;
  stop.abort(new Error("reflex takeover"));
  await assert.rejects(pending, /reflex takeover/);
  const again = new AbortController();
  const resumed = f.camp.waitForQuarry(() => false, again.signal);
  assert.equal(f.camp.snapshot.observationUntil, deadline);
  again.abort(new Error("second takeover"));
  await assert.rejects(resumed, /second takeover/);
  assert.equal(await f.camp.waitForQuarry(() => true, new AbortController().signal), null);
  assert.equal(f.camp.snapshot.phase, "hunting");
  assert.equal(f.camp.snapshot.observationUntil, null);
  assert.equal(f.routes(), 0);
});

test("a destroyed camp wakes its wait and reports source loss", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  f.bot.entity.position = new Vec3(1.5, 64, 0.5);
  const pending = f.camp.waitForQuarry(() => false, new AbortController().signal);
  f.destroy();
  assert.equal((await pending)?.termination, "spawner_unavailable");
});

// A count met during the wait hands back to hunting even when the spawner is gone (plan 2026-11-18-scenario-reds-part3-a3 T18g).
test("a camp whose quantity was carried during the wait hands back to hunting although its spawner is gone", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  f.bot.entity.position = new Vec3(1.5, 64, 0.5);
  let available = false;
  const pending = f.camp.waitForQuarry(() => available, new AbortController().signal);
  available = true;
  f.destroy();
  const failure = await f.clock.settle(pending, 10_000, SLICE_MS);
  assert.equal(failure, null, `the old code answered ${failure?.reason}`);
  assert.equal(f.camp.snapshot.phase, "hunting");
});

test("a camp whose spawner is gone and whose quantity is not carried still reports the loss", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  f.bot.entity.position = new Vec3(1.5, 64, 0.5);
  f.destroy();
  const failure = await f.clock.settle(f.camp.waitForQuarry(() => false, new AbortController().signal), 10_000, SLICE_MS);
  assert.equal(failure?.termination, "spawner_unavailable");
  assert.match(failure?.reason ?? "", /\[HUNT_SPAWNER_UNAVAILABLE\] The remembered spawner at .* is now air\./);
});

test("failed navigation returns its observation instead of waiting again", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  const camp = new SpawnerCamp(f.bot, SPAWNER, 1, async () => ({
    status: "stopped",
    elapsedMs: 1,
    reason: "No safe route",
  }));
  const waiting = camp.waitForQuarry(() => false, new AbortController().signal);
  // The 1 ms away wait is 1 tick: it ends at the packet at +40 ticks (2 000 ms), then the route stops.
  const result = await f.clock.settle(waiting, 10_000, SLICE_MS);
  assert.equal(result?.termination, "spawner_unreachable");
  assert.match(result?.reason ?? "", /No safe route/);
});

test("missing spawner refuses camping without a route or wait", async () => {
  const f = fixture();
  const camp = new SpawnerCamp(f.bot, null, 10, async () => {
    throw new Error("Unexpected route");
  });
  assert.equal(
    (await camp.waitForQuarry(() => false, new AbortController().signal))?.termination,
    "spawner_unavailable",
  );
});

// Plan 2026-10-27-p1-monotonic-clock T5: the camp's wait is a deadline (monotonic) kept across a reflex takeover; its
// snapshot keeps epoch times. One wait cannot tell the clocks apart (its timer is set once): the takeover re-enters it.
// T13f: the 3 s wait is 60 ticks of game time and ends at the packet 80 ticks after its start (4 000 ms at 20 tps, 8 000 ms
// at 10); a wall step moves `Date.now` only.
for (const row of [
  { name: "a wall step forward of 1.2 s does not cut it short", wallStepMs: 1_200 },
  { name: "a wall step back of 0.8 s does not stretch it", wallStepMs: -800 },
].flatMap((step) => CAMP_RATES.map((rate) => ({ ...step, ...rate })))) {
  test(`a 3 s wait at the spawner resumed after a takeover ends at the packet 80 ticks on (${80 * row.msPerTick} ms, ${row.ticksPerSecond} tps): ${row.name}`, async () => {
    const f = fixture(3_000, row.ticksPerSecond);
    using _timers = f.clock.install();
    // Live the two clocks read unrelated values (uptime vs epoch): a start taken on the wrong one cannot pass.
    f.clock.stepWallClock(5_000);
    f.bot.entity.position = new Vec3(1.5, 64, 0.5);
    const takeover = new AbortController();
    const interrupted = f.camp.waitForQuarry(() => false, takeover.signal);
    assert.equal(f.camp.snapshot.observationUntil, Date.now() + 3_000, "the snapshot's deadline stays an epoch time of day");
    await f.clock.advance(1_000);
    takeover.abort(new Error("reflex takeover"));
    await assert.rejects(interrupted, /reflex takeover/);
    f.clock.stepWallClock(row.wallStepMs);
    let result: CampFailure | null | undefined;
    const settled = () => result !== undefined;
    const resumed = f.camp.waitForQuarry(() => false, new AbortController().signal).then((failure) => { result = failure; });
    await f.clock.advance(80 * row.msPerTick - 1_000 - 100);
    assert.equal(settled(), false, "100 ms before the packet at +80 ticks: still waiting");
    await f.clock.advance(200);
    assert.equal(result?.termination, "observation_exhausted", "100 ms after it: over");
    await resumed;
  });
}

// The away wait (before the return route) is a deadline of the same kind: its snapshot field `returnAfter` stays epoch.
for (const row of [
  { name: "a wall step forward of 1.2 s does not send the bot back early", wallStepMs: 1_200 },
  { name: "a wall step back of 0.8 s does not keep the bot away longer", wallStepMs: -800 },
].flatMap((step) => CAMP_RATES.map((rate) => ({ ...step, ...rate })))) {
  test(`a 3 s wait away from the spawner resumed after a takeover returns at the packet 80 ticks on (${80 * row.msPerTick} ms, ${row.ticksPerSecond} tps): ${row.name}`, async () => {
    const f = fixture(3_000, row.ticksPerSecond);
    using _timers = f.clock.install();
    // Live the two clocks read unrelated values (uptime vs epoch): a start taken on the wrong one cannot pass.
    f.clock.stepWallClock(5_000);
    const takeover = new AbortController();
    const interrupted = f.camp.waitForQuarry(() => false, takeover.signal);
    assert.equal(f.camp.snapshot.returnAfter, Date.now() + 3_000, "the snapshot's deadline stays an epoch time of day");
    await f.clock.advance(1_000);
    takeover.abort(new Error("reflex takeover"));
    await assert.rejects(interrupted, /reflex takeover/);
    f.clock.stepWallClock(row.wallStepMs);
    const again = new AbortController();
    const resumed = f.camp.waitForQuarry(() => false, again.signal).catch(() => undefined);
    await f.clock.advance(80 * row.msPerTick - 1_000 - 100);
    assert.equal(f.routes(), 0, "100 ms before the packet at +80 ticks: still waiting away");
    await f.clock.advance(200);
    assert.equal(f.routes(), 1, "100 ms after it: the bot started back");
    again.abort(new Error("test over"));
    await resumed;
  });
}

/** The clock reading when `pending` settled, moving the clock on in `SLICE_MS` slices for at most `maxMs`. */
function settledAtMs<T>(clock: ReturnType<typeof fixture>["clock"], pending: Promise<T>, maxMs: number): Promise<{ value: T; atMs: number }> {
  return clock.settle(pending.then((value) => ({ value, atMs: clock.now() })), maxMs, SLICE_MS);
}

for (const { ticksPerSecond, msPerTick } of CAMP_RATES) {
  // 2 000 ms = 40 ticks: each wait ends at the packet 60 ticks after the age cached at its start.
  test(`a 2 s away wait ends at the packet 60 ticks on and the bot starts back then (${ticksPerSecond} tps)`, async () => {
    const f = fixture(2_000, ticksPerSecond);
    using _timers = f.clock.install();
    const pending = f.camp.waitForQuarry(() => false, new AbortController().signal).catch(() => undefined);
    await f.clock.advance(60 * msPerTick - 100);
    assert.equal(f.routes(), 0, "100 ms before the packet at +60 ticks");
    assert.equal(f.camp.snapshot.phase, "waiting_away");
    await f.clock.advance(200);
    assert.equal(f.routes(), 1, "100 ms after it");
    await f.clock.settle(pending, 20_000, SLICE_MS);
  });

  test(`away, then home: the camp window starts at the arrival and ends 60 ticks of packets later (${ticksPerSecond} tps)`, async () => {
    const f = fixture(2_000, ticksPerSecond);
    using _timers = f.clock.install();
    const { value, atMs } = await settledAtMs(f.clock, f.camp.waitForQuarry(() => false, new AbortController().signal), 30_000);
    assert.equal(value?.termination, "observation_exhausted");
    // Away to the packet at +60, home at once, then a new window cached at that packet: its +60 is the packet at +120.
    assert.ok(atMs >= 120 * msPerTick && atMs <= 120 * msPerTick + SLICE_MS, `ended at ${atMs} ms, not at the old wall`);
    assert.equal(f.bot.time.age, f.startAge + 120);
  });

  test(`displaced from the camp, the same camp window is not renewed on the way back (${ticksPerSecond} tps)`, async () => {
    const f = fixture(2_000, ticksPerSecond);
    using _timers = f.clock.install();
    f.bot.entity.position = new Vec3(1.5, 64, 0.5);
    const pending = f.camp.waitForQuarry(() => false, new AbortController().signal);
    await f.clock.advance(20 * msPerTick);
    assert.equal(f.camp.snapshot.phase, "waiting_at_spawner");
    f.bot.entity.position = new Vec3(20.5, 64, 0.5);
    const { value, atMs } = await settledAtMs(f.clock, pending, 30_000);
    assert.equal(value?.termination, "observation_exhausted");
    assert.equal(f.routes(), 1);
    // The away window starts at +20 and ends at the packet +80; the camp window opened at +0 was over at +60: the bot is
    // home and the result is the camp's, at once (a renewed window would end at +140).
    assert.ok(atMs >= 80 * msPerTick && atMs <= 80 * msPerTick + SLICE_MS, `ended at ${atMs} ms`);
  });

  test(`the snapshot shows the window of its phase in game ticks: away, returning (none), at the spawner (${ticksPerSecond} tps)`, async () => {
    const f = fixture(2_000, ticksPerSecond);
    using _timers = f.clock.install();
    let release: (() => void) | undefined;
    f.routeWith(async (position) => {
      await new Promise<void>((resolve) => { release = resolve; });
      f.bot.entity.position = position.offset(1.5, 0, 0.5);
      return { status: "completed", elapsedMs: 1 };
    });
    const pending = f.camp.waitForQuarry(() => false, new AbortController().signal);
    await f.clock.advance(20 * msPerTick);
    assert.equal(f.camp.snapshot.phase, "waiting_away");
    assert.deepEqual(f.camp.snapshot.observationTicks, { elapsed: 20, limit: 40 });
    await f.clock.advance(60 * msPerTick);
    assert.equal(f.camp.snapshot.phase, "returning");
    assert.equal(f.camp.snapshot.observationTicks, null);
    release?.();
    await f.clock.advance(20 * msPerTick);
    assert.equal(f.camp.snapshot.phase, "waiting_at_spawner");
    assert.deepEqual(f.camp.snapshot.observationTicks, { elapsed: 20, limit: 40 }, "the camp window counts from the arrival");
    const { value } = await settledAtMs(f.clock, pending, 30_000);
    assert.equal(value?.termination, "observation_exhausted");
  });

  test(`a cancelled return rejects with the reason and leaves no window or timer (${ticksPerSecond} tps)`, async () => {
    const f = fixture(2_000, ticksPerSecond);
    using _timers = f.clock.install();
    const added = listenersAddedSince(f.bot);
    f.routeWith((_position, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const cancel = new AbortController();
    const pending = f.camp.waitForQuarry(() => false, cancel.signal).catch((error: unknown) => error);
    await f.clock.advance(60 * msPerTick + 100);
    assert.equal(f.camp.snapshot.phase, "returning");
    cancel.abort(new Error("reflex takeover"));
    assert.match(String(await f.clock.settle(pending, 1_000, SLICE_MS)), /reflex takeover/);
    for (const event of ["time", "physicsTick", "entitySpawn", "entityUpdate", "blockUpdate"]) assert.equal(added(event), 0, event);
    assert.equal(f.clock.pendingGlobalTimers(), 0);
  });

  test(`a spawner destroyed on the packet that ends the camp window is reported before the expiry (${ticksPerSecond} tps)`, async () => {
    const f = fixture(2_000, ticksPerSecond);
    using _timers = f.clock.install();
    f.bot.entity.position = new Vec3(1.5, 64, 0.5);
    const pending = f.camp.waitForQuarry(() => false, new AbortController().signal);
    await f.clock.advance(SLICE_MS);
    // Registered after the camp's own `time` listener: the block goes on the packet that also ends the window.
    f.bot.on("time", () => {
      if (f.bot.time.age >= f.startAge + 60) f.destroy();
    });
    const { value } = await settledAtMs(f.clock, pending, 30_000);
    assert.equal(value?.termination, "spawner_unavailable");
  });

  test(`quarry that shows on the packet that ends the window wins and resets both windows (${ticksPerSecond} tps)`, async () => {
    const f = fixture(2_000, ticksPerSecond);
    using _timers = f.clock.install();
    let quarry = false;
    const pending = f.camp.waitForQuarry(() => quarry, new AbortController().signal);
    await f.clock.advance(SLICE_MS);
    f.bot.on("time", () => {
      if (f.bot.time.age >= f.startAge + 60) quarry = true;
    });
    const { value } = await settledAtMs(f.clock, pending, 30_000);
    assert.equal(value, null);
    assert.equal(f.routes(), 0, "the away wait was over, but the quarry won: no route home");
    assert.equal(f.camp.snapshot.phase, "hunting");
    assert.equal(f.camp.snapshot.returnAfter, null);
    assert.equal(f.camp.snapshot.observationUntil, null);
    assert.equal(f.camp.snapshot.observationTicks, null);
    // A later absence opens a fresh window: it ends 60 ticks after its own start, not at the old one.
    quarry = false;
    const again = settledAtMs(f.clock, f.camp.waitForQuarry(() => false, new AbortController().signal), 40_000);
    const startedAtMs = f.clock.now();
    const { atMs } = await again;
    assert.ok(atMs - startedAtMs >= 120 * msPerTick - 1_000, `a fresh away wait and camp wait: ${atMs - startedAtMs} ms`);
  });

  test(`a stopped server ends a 2 s away wait at its wall backstop of 9 000 ms (${ticksPerSecond} tps)`, async () => {
    const f = fixture(2_000, ticksPerSecond);
    using _timers = f.clock.install();
    const pending = f.camp.waitForQuarry(() => false, new AbortController().signal).catch(() => undefined);
    await f.clock.advance(SLICE_MS);
    f.stopServer();
    await f.clock.advance(9_000 - 2 * SLICE_MS);
    assert.equal(f.routes(), 0, "100 ms before the backstop");
    await f.clock.advance(2 * SLICE_MS + SLICE_MS);
    assert.equal(f.routes(), 1, "after it");
    await f.clock.settle(pending, 30_000, SLICE_MS);
  });

  test(`a stopped server ends a 2 s wait at the spawner at its wall backstop of 9 000 ms (${ticksPerSecond} tps)`, async () => {
    const f = fixture(2_000, ticksPerSecond);
    using _timers = f.clock.install();
    f.bot.entity.position = new Vec3(1.5, 64, 0.5);
    const pending = f.camp.waitForQuarry(() => false, new AbortController().signal);
    await f.clock.advance(SLICE_MS);
    assert.equal(f.camp.snapshot.phase, "waiting_at_spawner");
    f.stopServer();
    await f.clock.advance(9_000 - 2 * SLICE_MS);
    assert.equal(f.camp.snapshot.phase, "waiting_at_spawner", "100 ms before the backstop: still waiting");
    const { value, atMs } = await settledAtMs(f.clock, pending, 30_000);
    assert.equal(value?.termination, "observation_exhausted");
    assert.ok(atMs >= 9_000 && atMs <= 9_000 + 2 * SLICE_MS, `ended at ${atMs} ms`);
    assert.equal(f.routes(), 0, "never left the spawner");
  });
}

// `wakeMs` is how long the next sleep of a wait may be: the wall left or the no-age fallback, at least 1 ms, never past
// the timer API's limit (a longer delay fires at once).
test("an observation window's next wake is bounded by the timer limit, the wall left and the no-age fallback, and is at least 1 ms", () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const withAge = createFakeBot({ clock }).bot;
  const huge = observationWindow(withAge, Number.MAX_SAFE_INTEGER);
  assert.equal(huge.wakeMs(huge.start.began), 2_147_483_647, "a window of 1.8e14 ticks sleeps by the timer limit");
  const small = observationWindow(withAge, 2_000);
  assert.equal(small.wallMs, 9_000);
  assert.equal(small.wakeMs(small.start.began), 9_000, "an age was heard: the wall is the only bound");
  assert.equal(small.wakeMs(small.start.began + 8_998.5), 2, "1.5 ms left rounds up");
  assert.equal(small.wakeMs(small.start.began + 8_999.9), 1);
  assert.equal(small.wakeMs(small.start.began + 9_500), 1, "past the wall: still a positive delay");
  const noAge = createFakeBot({ clock, server: { timePacketYet: false } }).bot;
  const noAgeWindow = observationWindow(noAge, 2_000);
  assert.equal(noAgeWindow.wakeMs(noAgeWindow.start.began), 2_000, "no age heard at its start: real milliseconds (ticks x 50)");
  assert.equal(noAgeWindow.wakeMs(noAgeWindow.start.began + 1_500), 500);
});

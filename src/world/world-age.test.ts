import assert from "node:assert/strict";
import test from "node:test";
import { type FakeBotOptions, createFakeBot, createFakeClock } from "../test-support/fake-bot/index.js";
import { watch } from "../test-support/pending.js";
import {
  AGE_PACKET_TICKS,
  MS_PER_ON_TIME_TICK,
  SERVER_CLOCK_STOPPED_MS,
  type ServerTickDeadlineOptions,
  serverPacedWallMs,
  serverTickDeadline,
  ticksOnTime,
  waitForServerAnswer,
  waitForServerTicks,
  waitForWorldAge,
} from "./world-age.js";

/** A bot on a server whose world age is `age` and whose clock the test moves; the waits read their time from it. */
function worldBot(age = 1_000, options: FakeBotOptions = {}) {
  const clock = createFakeClock({ mode: "manual" });
  const harness = createFakeBot({ clock, server: { startAge: age }, ...options });
  return { ...harness, timing: { now: clock.now, sleep: clock.sleep } };
}

interface DeadlineSetup {
  /** The server runs this long before the deadline is created (its age is then the cached age of the last packet). */
  readonly createdAfterMs?: number;
  readonly limits?: ServerTickDeadlineOptions;
  /** False: nobody looks at the deadline until the test does. */
  readonly lookEachSlice?: boolean;
}

/** Observe each server slice, including stopped ones, without adding a timer to the deadline. */
async function deadlineOnServer(ticks: number, options: FakeBotOptions = {}, setup: DeadlineSetup = {}) {
  const harness = worldBot(1_000, options);
  const { bot, clock } = harness;
  await clock.advance(setup.createdAfterMs ?? 0);
  const createdMs = clock.now();
  const deadline = serverTickDeadline(() => bot.time?.age, ticks, createdMs, setup.limits);
  let passedAt: { ms: number; ticks: number | null } | undefined;
  if (setup.lookEachSlice !== false) {
    clock.onSlice("physics", () => {
      if (deadline.passed(clock.now())) passedAt ??= deadline.elapsed(clock.now());
    });
  }
  return { ...harness, deadline, createdMs, passedAt: () => passedAt };
}

test("a server-tick deadline follows the packet's world age at slow and on-time rates", async () => {
  for (const { ticks, server, beforeMs, passedMs, elapsedTicks } of [
    { ticks: 100, server: { ticksPerSecond: 5 }, beforeMs: 16_000, passedMs: 20_000, elapsedTicks: 100 },
    { ticks: 100, server: { ticksPerSecond: 10 }, beforeMs: 8_000, passedMs: 10_000, elapsedTicks: 100 },
    { ticks: 100, server: {}, beforeMs: 4_900, passedMs: 5_000, elapsedTicks: 100 },
    { ticks: 100, server: { phaseMs: 900 }, beforeMs: 4_050, passedMs: 4_900, elapsedTicks: 100 },
    { ticks: 110, server: {}, beforeMs: 5_999, passedMs: 6_000, elapsedTicks: 120 },
  ]) {
    const { bot, clock, deadline, passedAt } = await deadlineOnServer(ticks, { server: { startAge: 1_000, ...server } });
    assert.equal(deadline.ticks, ticks);
    await clock.advance(beforeMs);
    assert.equal(deadline.passed(clock.now()), false, `${ticks} ticks: still pending at ${beforeMs} ms`);
    if (server.ticksPerSecond === 5) assert.equal(bot.time.age, 1_080);
    await clock.advance(passedMs - beforeMs);
    assert.deepEqual(passedAt(), { ms: passedMs, ticks: elapsedTicks });
    assert.equal(deadline.passed(clock.now()), true);
    assert.equal(clock.pendingTimers(), 0, "the deadline owns no timer");
  }
});

test("an extra time packet neither passes nor stalls a deadline early", async () => {
  const { clock, server, deadline, passedAt } = await deadlineOnServer(100);
  await clock.advance(450);
  server.resendTime();
  assert.deepEqual(deadline.elapsed(clock.now()), { ms: 450, ticks: 9 });
  assert.equal(deadline.passed(clock.now()), false);
  await clock.advance(4_500);
  assert.equal(deadline.passed(clock.now()), false);
  await clock.advance(50);
  assert.deepEqual(passedAt(), { ms: 5_000, ticks: 100 });
});

test("a stopped server passes a deadline 20 seconds after the last moving age", async () => {
  const { clock, server, deadline, passedAt } = await deadlineOnServer(100);
  await clock.advance(2_500);
  server.stop();
  await clock.advance(19_450);
  assert.equal(deadline.passed(clock.now()), false);
  await clock.advance(50);
  assert.deepEqual(passedAt(), { ms: 22_000, ticks: 40 });
});

test("a no-age deadline falls back to on-time milliseconds and stays passed after a late first packet", async () => {
  const { clock, server, deadline, passedAt } = await deadlineOnServer(100, { server: { timePacketYet: false } });
  server.stop();
  await clock.advance(4_999);
  assert.equal(deadline.passed(clock.now()), false);
  assert.deepEqual(deadline.elapsed(clock.now()), { ms: 4_999, ticks: null });
  await clock.advance(1);
  assert.deepEqual(passedAt(), { ms: 5_000, ticks: null });
  assert.equal(deadline.passed(clock.now()), true);
  server.resendTime();
  assert.deepEqual(deadline.elapsed(clock.now()), { ms: 5_000, ticks: 0 });
  assert.equal(deadline.passed(clock.now()), true, "the late first age cannot reopen a wall-expired deadline");
});

test("a deadline starts its tick count at the first age heard, even after starting without one", async () => {
  const { clock, deadline, passedAt } = await deadlineOnServer(100, { server: { startAge: 1_000, timePacketYet: false } });
  await clock.advance(1_000);
  assert.deepEqual(deadline.elapsed(clock.now()), { ms: 1_000, ticks: 0 });
  await clock.advance(4_000);
  assert.equal(deadline.passed(clock.now()), false, "the first packet is the baseline, not a move from zero");
  await clock.advance(1_000);
  assert.deepEqual(passedAt(), { ms: 6_000, ticks: 100 });
});

test("a deadline nobody looked at for 20 seconds expires even if the age moved too little", async () => {
  const { bot, clock, server } = worldBot(1_000, { server: { startAge: 1_000, ticksPerSecond: 5 } });
  const deadline = serverTickDeadline(() => bot.time.age, 100, clock.now());
  clock.after(10_000, () => server.stop());
  clock.after(20_000, () => server.resume());
  await clock.advance(1_000);
  assert.equal(deadline.passed(clock.now()), false);
  await clock.advance(24_000);
  assert.equal(bot.time.age, 1_060);
  assert.equal(deadline.passed(clock.now()), true);
});

test("server ticks wait for moving age without a wall cap, and stop on a still clock", async () => {
  const { bot, clock, server, timing } = worldBot();
  assert.equal(await clock.settle(waitForServerTicks(bot, 40, timing), 2_000), "moved");
  assert.equal(clock.now(), 2_000);
  assert.equal(bot.time.age, 1_040);
  const pending = waitForServerTicks(bot, Infinity, timing);
  const long = watch(pending);
  await clock.advance(600_000);
  assert.equal(long.over, false, "moving age remains pending after ten minutes");
  server.stop();
  await clock.advance(SERVER_CLOCK_STOPPED_MS);
  assert.equal(long.over, true);
  assert.equal(await pending, "stalled");
});

test("server ticks forward the condition and cancellation", async () => {
  const { bot, clock, timing } = worldBot();
  let done = false;
  clock.after(100, () => { done = true; });
  assert.equal(await clock.settle(waitForServerTicks(bot, 40, { ...timing, until: () => done }), 100), "until");
  const controller = new AbortController();
  const pending = waitForServerTicks(bot, 40, { ...timing, signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled/);
  controller.abort(new Error("cancelled"));
  await clock.advance(25);
  await rejected;
});

test("resolves moved when the server age advanced the asked ticks, seen in jumps of 20", async () => {
  const { bot, clock, timing } = worldBot();
  const jumps: number[] = [];
  let seen = bot.time.age;
  bot.on("time", () => {
    jumps.push(bot.time.age - seen);
    seen = bot.time.age;
  });

  const moved = await clock.settle(waitForWorldAge(bot, 40, { wallMs: 10_000, ...timing }), 2_050);

  assert.equal(moved, "moved");
  assert.deepEqual(jumps, [20, 20], "the age reached the bot as two time packets of 20 ticks");
});

test("resolves until when the condition becomes true before the age moves", async () => {
  const { bot, clock, timing } = worldBot();
  let done = false;
  clock.after(100, () => (done = true));

  const wait = await clock.settle(waitForWorldAge(bot, 40, { wallMs: 10_000, until: () => done, ...timing }), 150);

  assert.equal(wait, "until");
});

test("times out on the wall clock when the world age never moves", async () => {
  const { bot, clock, server, timing } = worldBot();
  server.stop();
  const pending = waitForWorldAge(bot, 40, { wallMs: 10_000, ...timing });
  const wait = watch(pending);

  await clock.advance(9_900);
  assert.equal(wait.over, false, "still inside the 10 s wall bound");
  await clock.advance(150);

  assert.equal(await pending, "timeout");
  assert.ok(wait.over);
});

test("a server seconds behind: age frozen 10 s then moving again past the asked ticks still reports moved within a longer bound", async () => {
  // The game moves the age 20 a time packet (contract check `world-age-per-second`), never the +200 at once the old
  // fixture jumped; 30 ticks is no whole number of packets, so the age passes them rather than landing on them.
  const { bot, clock, server, timing } = worldBot();
  server.stop();
  clock.after(10_000, () => server.resume());
  const pending = waitForWorldAge(bot, 30, { wallMs: 15_000, ...timing });
  const wait = watch(pending);

  await clock.advance(10_000);
  assert.equal(wait.over, false, "the age was frozen for the first 10 s");
  await clock.advance(2_050);

  assert.equal(await pending, "moved");
  assert.ok(wait.over);
});

test("an until already true resolves at once, and an aborted signal rejects", async () => {
  const { bot, timing } = worldBot();
  assert.equal(await waitForWorldAge(bot, 40, { wallMs: 1_000, until: () => true, ...timing }), "until");
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(waitForWorldAge(bot, 40, { wallMs: 1_000, signal: controller.signal, ...timing }), /cancelled/);
});

test("works with the default clock: performance.now and setTimeout", async () => {
  // No injected `now` or `sleep`: the wait reads `performance.now` and `setTimeout`, which the clock now stands in for.
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, server } = createFakeBot({ clock, server: { startAge: 0 } });
  using _timers = clock.install();
  server.stop();

  assert.equal(await clock.settle(waitForWorldAge(bot, 40, { wallMs: 120 }), 170), "timeout");
});

test("the server answer counts ticks from the send, not from the call", async () => {
  const { bot, clock, timing } = worldBot(140);
  assert.equal(await waitForServerAnswer(bot, 100, { wallMs: 10_000, until: () => false, ...timing }), "moved");
  assert.equal(clock.now(), 0, "40 ticks had already passed since the send: no wait at all");
});

test("the server answer without a send age counts from the call", async () => {
  const { bot, clock, timing } = worldBot();
  const pending = waitForServerAnswer(bot, undefined, { wallMs: 10_000, until: () => false, ...timing });
  const wait = watch(pending);

  await clock.advance(1_900);
  assert.equal(wait.over, false, "one time packet is 20 ticks, not the 40 the answer waits");
  await clock.advance(150);

  assert.equal(await pending, "moved");
  assert.ok(clock.now() > 0 && clock.now() < 10_000);
});

test("the shared stopped-clock bound waits exactly 20 s without a moving age", async () => {
  const { bot, clock, server, timing } = worldBot();
  server.stop();
  const pending = waitForServerAnswer(bot, 1_000, {
    wallMs: Number.POSITIVE_INFINITY, stallMs: SERVER_CLOCK_STOPPED_MS, ...timing,
  });
  const wait = watch(pending);
  await clock.advance(19_975);
  assert.equal(wait.over, false);
  assert.equal(await clock.settle(pending, 25), "stalled");
  assert.equal(clock.now(), 20_000);
});

test("the awaited change wins over the world age in the server answer wait", async () => {
  const { bot, timing } = worldBot(140);
  assert.equal(await waitForServerAnswer(bot, 100, { wallMs: 5_000, until: () => true, ...timing }), "until");
});

test("a bot that has heard no time packet yet counts from the first age it hears", async () => {
  // `time.js` starts with a null age: the first packet is the baseline, not a move from zero.
  const { bot, clock, timing } = worldBot(1_000, { server: { startAge: 1_000, timePacketYet: false } });
  let moved = false;
  void waitForWorldAge(bot, 40, { wallMs: 10_000, ...timing }).then(() => void (moved = true));

  await clock.advance(2_000); // the first packet, then one 20 ticks on
  assert.equal(moved, false, "a null age at the start is no age to move from");
  await clock.advance(1_000);
  assert.equal(moved, true);
});

test("a bot without a world age waits on the wall clock only", async () => {
  // The server never sent a time packet: the bot has no `time` to read.
  const { bot, clock, timing } = worldBot(1_000, { overrides: { time: undefined } });
  const wait = await clock.settle(waitForServerAnswer(bot, 0, { wallMs: 1_000, until: () => false, ...timing }), 1_050);
  assert.equal(wait, "timeout");
});

// `stallMs`: the wait times out when the age stands still that long, not when 40 ticks take long.
test("a server at 8 ticks a second moves 40 ticks in about 5 s: no timeout under a 5 s stall bound", async () => {
  // The game sends a time packet per 20 ticks at any rate (contract check world-age-at-slow-tick): every 2.5 s here, inside the stall bound.
  const { bot, clock, timing } = worldBot(1_000, { server: { startAge: 1_000, ticksPerSecond: 8 } });
  const pending = waitForWorldAge(bot, 40, { wallMs: 15_000, stallMs: 5_000, ...timing });
  const wait = watch(pending);

  await clock.advance(4_000);
  assert.equal(wait.over, false, "40 ticks at 8 a second take 5 s");

  assert.equal(await clock.settle(pending, 6_000), "moved");
  assert.ok(clock.now() >= 4_000 && clock.now() <= 8_000, `moved after ${clock.now()} ms`);
});

for (const { stopMs, outcome } of [{ stopMs: 3_000, outcome: "moved" }, { stopMs: 6_000, outcome: "stalled" }] as const) {
  test(`a server stopped ${stopMs / 1_000} s inside the wait with a 5 s stall bound ends ${outcome}, long before the 15 s wall bound`, async () => {
    const { bot, clock, server, timing } = worldBot();
    clock.after(1_000, () => server.stop());
    clock.after(1_000 + stopMs, () => server.resume());

    assert.equal(await clock.settle(waitForWorldAge(bot, 40, { wallMs: 15_000, stallMs: 5_000, ...timing }), 15_000), outcome);
    assert.ok(clock.now() < 10_000, `ended at ${clock.now()} ms`);
  });
}

test("an age that moves under the stall bound but too slowly for the asked ticks ends at the outer wall bound", async () => {
  // A time object the test moves by hand: the age creeps one tick every 2 s, never standing still for the 5 s stall bound.
  const time = { age: 1_000 };
  const { bot, clock, timing } = worldBot(1_000, { overrides: { time } as FakeBotOptions["overrides"] });
  const creep = () => {
    time.age += 1;
    clock.after(2_000, creep);
  };
  clock.after(2_000, creep);

  assert.equal(await clock.settle(waitForWorldAge(bot, 40, { wallMs: 15_000, stallMs: 5_000, ...timing }), 16_000), "timeout");
  assert.ok(clock.now() >= 15_000, `ended at ${clock.now()} ms`);
});

test("a stall bound counts from the first age a bot hears when it had none", async () => {
  const { bot, clock, timing } = worldBot(1_000, { server: { startAge: 1_000, timePacketYet: false } });
  assert.equal(await clock.settle(waitForWorldAge(bot, 40, { wallMs: 15_000, stallMs: 5_000, ...timing }), 15_000), "moved");
});

// Server-paced limits (plan 2026-11-16-reflex-limits-ticks T1): the deadline counts from the age read at its start plus
// one time packet, with a total wall backstop. The packet of age `A + k` falls `k * msPerTick` after the server's start
// (one packet per 20 ticks at any rate; the start age, 1 000, is the packet of age `A` at 0 ms).
const START_AGE = 1_000;
const CREATED_AFTER_MS = 500;
const RATES = [
  { ticksPerSecond: 20, msPerTick: 50 },
  { ticksPerSecond: 10, msPerTick: 100 },
] as const;
const LIMIT_TICKS = 200;
const PACKET_LIMITS = { origin: "packet", wallMs: serverPacedWallMs(LIMIT_TICKS) } as const;

/** A server-paced deadline of `ticks` created `CREATED_AFTER_MS` after the packet of age `START_AGE`. */
function deadlineAfterPacket(ticks: number, server: NonNullable<FakeBotOptions["server"]>, limits: ServerTickDeadlineOptions, lookEachSlice = true) {
  return deadlineOnServer(ticks, { server: { startAge: START_AGE, ...server } }, { createdAfterMs: CREATED_AFTER_MS, limits, lookEachSlice });
}

for (const { ticksPerSecond, msPerTick } of RATES) {
  for (const { origin, passesAtAge } of [{ origin: "packet", passesAtAge: 220 }, { origin: "cached", passesAtAge: 200 }] as const) {
    for (const lookEveryMs of [50, 25]) {
      test(`a ${origin}-origin deadline of 200 ticks passes at the packet of age A + ${passesAtAge}, not at the one before (${ticksPerSecond} tps, looked at every ${lookEveryMs} ms)`, async () => {
        const { bot, clock, deadline, createdMs, passedAt } = await deadlineAfterPacket(LIMIT_TICKS, { ticksPerSecond }, { ...PACKET_LIMITS, origin });
        const beforeAge = passesAtAge - AGE_PACKET_TICKS;
        await clock.advance(beforeAge * msPerTick - createdMs, lookEveryMs);
        assert.equal(bot.time.age, START_AGE + beforeAge);
        assert.equal(deadline.passed(clock.now()), false, `A + ${beforeAge} is one packet short of the deadline`);
        assert.equal(passedAt(), undefined);
        await clock.advance(AGE_PACKET_TICKS * msPerTick, lookEveryMs);
        assert.equal(bot.time.age, START_AGE + passesAtAge);
        assert.deepEqual(passedAt(), { ms: passesAtAge * msPerTick - createdMs, ticks: passesAtAge });
      });
    }
  }

  test(`a packet-origin deadline read only once, long after its limit, is passed at that read (${ticksPerSecond} tps)`, async () => {
    // Never looked at before: the first read, at the packet of age A + 260, counts from the age at creation.
    const { clock, deadline, createdMs } = await deadlineAfterPacket(LIMIT_TICKS, { ticksPerSecond }, { ...PACKET_LIMITS, stoppedMs: null }, false);
    await clock.advance(260 * msPerTick - createdMs);
    assert.equal(deadline.passed(clock.now()), true);
    assert.equal(deadline.elapsed(clock.now()).ticks, 260);
  });
}

// No age at creation: only `ticks * 50` ms and the wall, whatever packets come later, at the default stopped-clock bound (20 s)
// too (a 600-tick budget is 30 000 ms, past it).
for (const ticks of [LIMIT_TICKS, 600]) {
  for (const { name, ticksPerSecond, stopped } of [
    { name: "a server running at 20 tps", ticksPerSecond: 20, stopped: false },
    { name: "a server running at 10 tps", ticksPerSecond: 10, stopped: false },
    { name: "a stopped server that sends one extra packet", ticksPerSecond: 20, stopped: true },
  ]) {
    test(`a packet-origin deadline of ${ticks} ticks created before any time packet ends at ticks times 50 ms: ${name}`, async () => {
      const expiryMs = ticks * MS_PER_ON_TIME_TICK;
      const { clock, server, deadline, passedAt } = await deadlineAfterPacket(
        ticks, { ticksPerSecond, timePacketYet: false }, { origin: "packet", wallMs: serverPacedWallMs(ticks) },
      );
      if (stopped) {
        server.stop();
        server.resendTime();
      }
      await clock.advance(expiryMs - 1);
      assert.equal(deadline.passed(clock.now()), false);
      assert.deepEqual(deadline.elapsed(clock.now()), { ms: expiryMs - 1, ticks: null });
      await clock.advance(1);
      assert.deepEqual(passedAt(), { ms: expiryMs, ticks: null });
    });
  }
}

// Each stopped-clock bound alone, on independent deadlines one ms either side (T10): a stopped server ends on the last move
// (polled each slice, so the last look is recent), a moving server read once ends on the last look, `stoppedMs: null`
// leaves only the wall. Each row's age stays under its budget, so no tick count explains a pass.
const STOPPED_BOUNDS: ReadonlyArray<{
  name: string; ticks: number; ticksPerSecond: number; stopped: boolean; polled: boolean;
  limits: ServerTickDeadlineOptions; boundMs: number; passesAtBound: boolean;
}> = [
  { name: "packet, bound off, stopped: the wall", ticks: 200, ticksPerSecond: 20, stopped: true, polled: true, limits: { ...PACKET_LIMITS, stoppedMs: null }, boundMs: 33_000, passesAtBound: true },
  { name: "packet, default bound, stopped: the last move", ticks: 200, ticksPerSecond: 20, stopped: true, polled: true, limits: PACKET_LIMITS, boundMs: SERVER_CLOCK_STOPPED_MS, passesAtBound: true },
  { name: "packet, 2 s bound, stopped: the last move", ticks: 200, ticksPerSecond: 20, stopped: true, polled: true, limits: { ...PACKET_LIMITS, stoppedMs: 2_000 }, boundMs: 2_000, passesAtBound: true },
  { name: "cached, 5 s wall, bound off, stopped", ticks: 200, ticksPerSecond: 20, stopped: true, polled: true, limits: { wallMs: 5_000, stoppedMs: null }, boundMs: 5_000, passesAtBound: true },
  { name: "packet, default bound, 20 tps read once: the last look", ticks: 600, ticksPerSecond: 20, stopped: false, polled: false, limits: { origin: "packet", wallMs: serverPacedWallMs(600) }, boundMs: SERVER_CLOCK_STOPPED_MS, passesAtBound: true },
  { name: "packet, default bound, 10 tps read once: the last look", ticks: 600, ticksPerSecond: 10, stopped: false, polled: false, limits: { origin: "packet", wallMs: serverPacedWallMs(600) }, boundMs: SERVER_CLOCK_STOPPED_MS, passesAtBound: true },
  { name: "packet, 2 s bound, 20 tps read once: the last look", ticks: 600, ticksPerSecond: 20, stopped: false, polled: false, limits: { origin: "packet", wallMs: serverPacedWallMs(600), stoppedMs: 2_000 }, boundMs: 2_000, passesAtBound: true },
  { name: "packet, bound off, 20 tps read once: no last look", ticks: 600, ticksPerSecond: 20, stopped: false, polled: false, limits: { origin: "packet", wallMs: serverPacedWallMs(600), stoppedMs: null }, boundMs: SERVER_CLOCK_STOPPED_MS, passesAtBound: false },
  { name: "packet, bound off, 10 tps read once: no last look", ticks: 600, ticksPerSecond: 10, stopped: false, polled: false, limits: { origin: "packet", wallMs: serverPacedWallMs(600), stoppedMs: null }, boundMs: SERVER_CLOCK_STOPPED_MS, passesAtBound: false },
];
for (const row of STOPPED_BOUNDS) {
  test(`a stopped-clock bound ends a deadline exactly at its value: ${row.name}`, async () => {
    const lookAfter = async (gapMs: number) => {
      const { clock, server, deadline } = await deadlineAfterPacket(row.ticks, { ticksPerSecond: row.ticksPerSecond }, row.limits, row.polled);
      if (row.stopped) server.stop();
      await clock.advance(gapMs);
      const passed = deadline.passed(clock.now());
      const { ticks } = deadline.elapsed(clock.now());
      assert.ok(ticks !== null && ticks < row.ticks + AGE_PACKET_TICKS, `no tick count explains the pass: ${ticks} ticks at ${gapMs} ms`);
      return passed;
    };
    assert.equal(await lookAfter(row.boundMs - 1), false, "one ms short of the bound");
    assert.equal(await lookAfter(row.boundMs), row.passesAtBound, "at the bound");
    if (!row.passesAtBound) assert.equal(await lookAfter(row.boundMs + 1), false, "one ms past the bound, still only the wall and the ticks");
  });
}

test("a catch-up burst after a stop passes a packet-origin deadline at the first packet of age A + 220 or later", async () => {
  const { bot, clock, server, deadline } = await deadlineAfterPacket(LIMIT_TICKS, {}, PACKET_LIMITS);
  await clock.advance(8_900); // 9 400 ms: the packet of age A + 180 was heard at 9 000
  assert.equal(bot.time.age, START_AGE + 180);
  const heard: Array<{ age: number; passed: boolean }> = [];
  bot.on("time", () => void heard.push({ age: bot.time.age, passed: deadline.passed(clock.now()) }));
  server.stop();
  await clock.advance(1_700); // 34 owed ticks, under the 2 000 ms the game drops: all run at once at `resume`
  assert.deepEqual(heard, []);
  server.resume();
  assert.deepEqual(heard, [
    { age: START_AGE + 200, passed: false },
    { age: START_AGE + 220, passed: true },
  ]);
});

test("the wall backstop of a server-paced limit is three times its ticks plus one packet interval at 50 ms a tick", () => {
  assert.equal(serverPacedWallMs(40), 9_000);
  assert.equal(serverPacedWallMs(100), 18_000);
  assert.equal(serverPacedWallMs(200), 33_000);
  assert.equal(serverPacedWallMs(600), 93_000);
  assert.equal(serverPacedWallMs(12_000), 1_803_000);
});

test("milliseconds on a server on time are rounded up to whole ticks", () => {
  assert.equal(ticksOnTime(30_000), 600);
  assert.equal(ticksOnTime(55_000), 1_100);
  assert.equal(ticksOnTime(1), 1);
  assert.equal(ticksOnTime(50), 1);
  assert.equal(ticksOnTime(51), 2);
});

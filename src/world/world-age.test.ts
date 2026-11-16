import assert from "node:assert/strict";
import test from "node:test";
import { type FakeBotOptions, createFakeBot, createFakeClock } from "../test-support/fake-bot/index.js";
import { watch } from "../test-support/pending.js";
import { SERVER_CLOCK_STOPPED_MS, serverTickDeadline, waitForServerAnswer, waitForServerTicks, waitForWorldAge } from "./world-age.js";

/** A bot on a server whose world age is `age` and whose clock the test moves; the waits read their time from it. */
function worldBot(age = 1_000, options: FakeBotOptions = {}) {
  const clock = createFakeClock({ mode: "manual" });
  const harness = createFakeBot({ clock, server: { startAge: age }, ...options });
  return { ...harness, timing: { now: clock.now, sleep: clock.sleep } };
}

/** Observe each server slice, including stopped ones, without adding a timer to the deadline. */
function deadlineOnServer(ticks: number, options: FakeBotOptions = {}) {
  const harness = worldBot(1_000, options);
  const { bot, clock } = harness;
  const deadline = serverTickDeadline(() => bot.time?.age, ticks, clock.now());
  let passedAt: { ms: number; ticks: number | null } | undefined;
  clock.onSlice("physics", () => {
    if (deadline.passed(clock.now())) passedAt ??= deadline.elapsed(clock.now());
  });
  return { ...harness, deadline, passedAt: () => passedAt };
}

test("a server-tick deadline follows the packet's world age at slow and on-time rates", async () => {
  for (const { ticks, server, beforeMs, passedMs, elapsedTicks } of [
    { ticks: 100, server: { ticksPerSecond: 5 }, beforeMs: 16_000, passedMs: 20_000, elapsedTicks: 100 },
    { ticks: 100, server: { ticksPerSecond: 10 }, beforeMs: 8_000, passedMs: 10_000, elapsedTicks: 100 },
    { ticks: 100, server: {}, beforeMs: 4_900, passedMs: 5_000, elapsedTicks: 100 },
    { ticks: 100, server: { phaseMs: 900 }, beforeMs: 4_050, passedMs: 4_900, elapsedTicks: 100 },
    { ticks: 110, server: {}, beforeMs: 5_999, passedMs: 6_000, elapsedTicks: 120 },
  ]) {
    const { bot, clock, deadline, passedAt } = deadlineOnServer(ticks, { server: { startAge: 1_000, ...server } });
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
  const { clock, server, deadline, passedAt } = deadlineOnServer(100);
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
  const { clock, server, deadline, passedAt } = deadlineOnServer(100);
  await clock.advance(2_500);
  server.stop();
  await clock.advance(19_450);
  assert.equal(deadline.passed(clock.now()), false);
  await clock.advance(50);
  assert.deepEqual(passedAt(), { ms: 22_000, ticks: 40 });
});

test("a no-age deadline falls back to on-time milliseconds and stays passed after a late first packet", async () => {
  const { clock, server, deadline, passedAt } = deadlineOnServer(100, { server: { timePacketYet: false } });
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
  const { clock, deadline, passedAt } = deadlineOnServer(100, { server: { startAge: 1_000, timePacketYet: false } });
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

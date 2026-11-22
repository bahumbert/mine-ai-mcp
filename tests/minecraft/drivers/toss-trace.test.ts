import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "./server-ticks.ts";
import { describeRest, pollWithinServerTicks, traceToss } from "./toss-trace.ts";

const ITEM_ID = 7;
/** One physics tick of the fake's client, in clock ms: the bot's client ticks 20 a second whatever the server's rate. */
const PHYSICS_TICK_MS = 50;
/** Past every wait a case can have: nothing may fire then (T6). */
const PAST_EVERY_DEADLINE_MS = 400_000;
const RATES = [20, 10] as const;

/** A bot at (0.5, -59, 0.5) with an item entity lying 1.5 blocks east and one block lower, another item 20 blocks away and a cow beside it, on a server at `ticksPerSecond`. */
function tracedFixture(ticksPerSecond: number = 20) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({
    clock,
    position: new Vec3(0.5, -59, 0.5),
    server: { ticksPerSecond },
    entities: {
      [ITEM_ID]: { name: "item", position: new Vec3(2, -60, 0.5), velocity: new Vec3(0.1, 0, 0) },
      8: { name: "item", position: new Vec3(20, -60, 0.5) },
      9: { name: "cow", position: new Vec3(2, -60, 0.5) },
    },
  });
  const { bot, server } = harness;
  bot.entity.yaw = 1.5;
  bot.entity.pitch = 0.25;
  let physicsTicks = 0;
  bot.on("physicsTick", () => void (physicsTicks += 1));
  return { clock, bot, server, physicsTicks: () => physicsTicks, added: listenersAddedSince(bot) };
}

const giverTicks = (lines: string[]) => lines.filter((line) => line.includes("giver=")).map((line) => Number(/ t=(\d+) /u.exec(line)![1]));

/** Nothing the code under test started may still wait or fire once the clock has moved past every deadline. */
async function assertNothingLeft(fixture: ReturnType<typeof tracedFixture>) {
  const ticksBefore = fixture.physicsTicks();
  await fixture.clock.advance(PAST_EVERY_DEADLINE_MS);
  assert.equal(fixture.clock.pendingTimers(), 0, "a fake-clock timer is still waiting");
  assert.equal(fixture.clock.pendingGlobalTimers(), 0, "a global timer is still pending");
  assert.ok(fixture.physicsTicks() > ticksBefore, "the client went on ticking: the probe is live");
  for (const event of ["physicsTick", "playerCollect"]) assert.equal(fixture.added(event), 0, `${event} listener left behind`);
}

const SAMPLINGS = [
  { every: 5, callTicks: 12, why: "ticks 0, 5, 10 during the call, then every 5th" },
  { every: 1, callTicks: 3, why: "every tick, the call's own ticks 0-3 included" },
] as const;

for (const ticksPerSecond of RATES) {
  for (const { every, callTicks, why } of SAMPLINGS) {
    test(`at ${ticksPerSecond} tps traceToss samples the giver and each item within 6 blocks every ${every} physics tick(s), from the call until 60 server ticks after its answer`, async () => {
      const fixture = tracedFixture(ticksPerSecond);
      const { clock, bot, server } = fixture;
      using _timers = clock.install();
      const physicsAtStart = fixture.physicsTicks();
      let answeredAtGameTime = 0;
      const { value, lines } = await clock.settle(traceToss(bot, async () => {
        await clock.sleep(callTicks * PHYSICS_TICK_MS);
        answeredAtGameTime = server.gameTime;
        return "answered";
      }, every), 60_000);
      assert.equal(value, "answered");
      const ticks = giverTicks(lines);
      assert.deepEqual(ticks.slice(0, callTicks / every + 1), Array.from({ length: callTicks / every + 1 }, (_, index) => index * every), why);
      assert.deepEqual(ticks, ticks.map((_, index) => index * every), "one sample per `every` physics ticks, none missed");
      // The server's ticks decide how long it goes on: 60 of them is 3 s at 20 tps and 6 s at 10 tps; the client ticks 20 a second at both.
      const serverTicksAfter = server.gameTime - answeredAtGameTime;
      assert.ok(serverTicksAfter >= 60, `traced ${serverTicksAfter} server ticks after the answer, not 60`);
      assert.ok(serverTicksAfter <= 60 + 2 * 20, `traced ${serverTicksAfter} server ticks after the answer: the world age moves in jumps of 20`);
      const physicsSince = fixture.physicsTicks() - physicsAtStart;
      assert.ok(ticks.at(-1)! >= physicsSince - every && ticks.at(-1)! <= physicsSince, `the last sample, t=${ticks.at(-1)}, is within one cadence of the ${physicsSince} physics ticks run`);
      assert.match(lines.find((line) => line.includes("giver="))!, /^TOSS_TRACE t=0 giver=0\.50 -59\.00 0\.50 vel=0\.00 0\.00 0\.00 onGround=\w+ yaw=1\.50 pitch=0\.25$/u);
      assert.ok(lines.some((line) => line === `TOSS_TRACE t=0 item=${ITEM_ID} at=2.00 -60.00 0.50 vel=0.10 0.00 0.00`), lines.join("\n"));
      // The item 20 blocks away and the cow beside the giver are no toss.
      assert.equal(lines.filter((line) => line.includes(" item=")).every((line) => line.includes(` item=${ITEM_ID} `)), true, lines.join("\n"));
      await assertNothingLeft(fixture);
    });
  }

  test(`at ${ticksPerSecond} tps a call that never answers is sampled for 2 000 server ticks, then no more until it answers`, async () => {
    const fixture = tracedFixture(ticksPerSecond);
    const { clock, bot } = fixture;
    using _timers = clock.install();
    // 2 600 server ticks of call: the trace stops at 2 000 of them, the call goes on, and the answer's own 60 ticks are sampled again.
    const { lines } = await clock.settle(traceToss(bot, () => clock.sleep((2_600 / ticksPerSecond) * 1_000).then(() => "late"), 5), 600_000);
    const ticks = giverTicks(lines);
    const cut = ticks.findIndex((tick, index) => tick !== index * 5);
    // 2 000 server ticks are 2 000 * (20 / ticksPerSecond) physics ticks, sampled every 5th (the t=0 sample included): the cut is on the server's ticks, not the client's.
    const physicsPerServerTick = 20 / ticksPerSecond;
    const least = Math.floor((2_000 * physicsPerServerTick) / 5);
    const most = Math.ceil(((2_000 + 20) * physicsPerServerTick) / 5) + 2;
    assert.ok(cut >= least && cut <= most, `${cut} samples before the call answered, from ${least} to ${most} expected (the world age moves in jumps of 20)`);
    assert.ok(ticks.length > cut + 10, "the answer's own tail is sampled again");
    await assertNothingLeft(fixture);
  });
}

test("traceToss notes who collected an item, at the last sample taken (the world age is no clock for it: it moves in jumps of 20)", async () => {
  const fixture = tracedFixture();
  const { clock, bot } = fixture;
  using _timers = clock.install();
  const { lines } = await clock.settle(traceToss(bot, async () => {
    await clock.sleep(6 * PHYSICS_TICK_MS);
    bot.emit("playerCollect", { username: "Receiver" } as never, bot.entities[ITEM_ID]!);
  }), 60_000);
  const index = lines.findIndex((line) => line === `TOSS_TRACE t=5 collected by=Receiver item=${ITEM_ID}`);
  assert.ok(index >= 0, lines.join("\n"));
  assert.ok(lines.slice(0, index).some((line) => line.startsWith("TOSS_TRACE t=5 giver=")), "the collect line follows the sample it is stamped with");
  await assertNothingLeft(fixture);
});

/** How the call ends and what the sampler hit meanwhile: the error the caller must see, and every exit leaves nothing behind (T6). */
const FAULTS = [
  { name: "the call throws", bodyGone: false, endsWith: () => { throw new Error("cancelled"); }, error: /cancelled/u },
  { name: "a sample cannot be read (the body is gone), then the call throws: the call's own error wins", bodyGone: true, endsWith: () => { throw new Error("the call failed"); }, error: /the call failed/u },
  { name: "a sample cannot be read and the call itself went well: the sample's error is reported", bodyGone: true, endsWith: () => "answered", error: /the body is gone/u },
] as const;

for (const { name, bodyGone, endsWith, error } of FAULTS) {
  test(`traceToss removes its listeners and stops sampling when ${name}`, async () => {
    const fixture = tracedFixture();
    const { clock, bot } = fixture;
    using _timers = clock.install();
    const faulty = traceToss(bot, async () => {
      await clock.sleep(6 * PHYSICS_TICK_MS);
      if (bodyGone) Object.defineProperty(bot, "entities", { get() { throw new Error("the body is gone"); } });
      await clock.sleep(6 * PHYSICS_TICK_MS);
      return endsWith();
    });
    await assert.rejects(clock.settle(faulty, 60_000), error);
    await assertNothingLeft(fixture);
  });
}

test("traceToss ends its tail at once, with the sample's error, when a sample cannot be read after the answer", async () => {
  const fixture = tracedFixture();
  const { clock, bot, server } = fixture;
  using _timers = clock.install();
  let answeredAtGameTime = 0;
  // The body is gone 4 physics ticks after the call answered, inside the 60-server-tick tail.
  clock.after(10 * PHYSICS_TICK_MS, () => Object.defineProperty(bot, "entities", { get() { throw new Error("the body is gone"); } }));
  const gone = traceToss(bot, async () => {
    await clock.sleep(6 * PHYSICS_TICK_MS);
    answeredAtGameTime = server.gameTime;
    return "answered";
  });
  await assert.rejects(clock.settle(gone, 60_000), /the body is gone/u);
  const serverTicksAfter = server.gameTime - answeredAtGameTime;
  assert.ok(serverTicksAfter < 30, `the tail went on ${serverTicksAfter} server ticks after the unreadable sample; a full tail is 60 or more`);
  await assertNothingLeft(fixture);
});

test("with the server stopped and the call never answering, traceToss stops sampling at the stalled-clock bound", async () => {
  const fixture = tracedFixture();
  const { clock, bot, server } = fixture;
  using _timers = clock.install();
  const { lines } = await clock.settle(traceToss(bot, async () => {
    await clock.sleep(4 * PHYSICS_TICK_MS);
    server.stop();
    await clock.sleep(200_000);
    return "late";
  }, 5), 600_000);
  const ticks = giverTicks(lines);
  const cut = ticks.findIndex((tick, index) => tick !== index * 5);
  // 30 s of a still world age are 600 physics ticks, 120 samples (plus the few before the stop and up to a second of age already stale); 200 s unbounded would be 800.
  const stallSamples = (DRIVER_CLOCK_STOPPED_MS / PHYSICS_TICK_MS) / 5;
  assert.ok(cut >= stallSamples - 20 && cut <= stallSamples + 10, `${cut} samples before the answer, about ${stallSamples} expected: the cap must hold when the world age stops`);
  await assertNothingLeft(fixture);
});

test("with the server stopped after the answer, traceToss ends at the stalled-clock bound and says the world age stood still", async () => {
  const fixture = tracedFixture();
  const { clock, bot, server } = fixture;
  using _timers = clock.install();
  const startMs = clock.now();
  let answeredMs = 0;
  const { value, lines } = await clock.settle(traceToss(bot, async () => {
    await clock.sleep(4 * PHYSICS_TICK_MS);
    server.stop();
    answeredMs = clock.now();
    return "answered";
  }), 120_000);
  assert.equal(value, "answered");
  const waitedMs = clock.now() - answeredMs;
  assert.ok(waitedMs >= DRIVER_CLOCK_STOPPED_MS - 1_000 && waitedMs <= DRIVER_CLOCK_STOPPED_MS + 1_000, `ended ${waitedMs} ms after the answer; the stall bound is ${DRIVER_CLOCK_STOPPED_MS}`);
  assert.match(lines.at(-1)!, /^TOSS_TRACE world age stood still for 30000 ms: the trace ends$/u);
  assert.ok(clock.now() > startMs);
  await assertNothingLeft(fixture);
});

test("describeRest says where the nearest item lies from the bot's feet, or that none is seen", () => {
  assert.equal(describeRest(tracedFixture().bot), "rest_dy=-1.00 rest_dist=1.50 me=0.50 -59.00 0.50 item=2.00 -60.00 0.50");
  assert.equal(describeRest(createFakeBot({ position: new Vec3(0.5, -59, 0.5) }).bot), "no item seen");
});

/** `look` runs each `every` physics ticks; its record of the client ticks and the server's game time at each look. */
function recordedLooks(fixture: ReturnType<typeof tracedFixture>, answerAtServerTick: number | null) {
  const startGameTime = fixture.server.gameTime;
  const looks: { physics: number; serverTick: number }[] = [];
  const look = async () => {
    looks.push({ physics: fixture.physicsTicks(), serverTick: fixture.server.gameTime - startGameTime });
    return answerAtServerTick !== null && fixture.server.gameTime - startGameTime >= answerAtServerTick ? "found" : undefined;
  };
  return { looks, look, startGameTime };
}

for (const ticksPerSecond of RATES) {
  test(`at ${ticksPerSecond} tps pollWithinServerTicks looks at the start, then every 10 physics ticks, and gives up after the budget in server ticks, never before it`, async () => {
    const fixture = tracedFixture(ticksPerSecond);
    using _timers = fixture.clock.install();
    // The poll starts 19 ticks after the last time packet: the cached world age is the stalest it gets, so the budget needs its margin.
    await fixture.clock.advance((19 * 1_000) / ticksPerSecond);
    const { looks, look, startGameTime } = recordedLooks(fixture, null);
    const outcome = await fixture.clock.settle(pollWithinServerTicks(fixture.bot, 100, 10, look), 60_000);
    assert.deepEqual(outcome, { ended: "budget" });
    const served = fixture.server.gameTime - startGameTime;
    assert.ok(served >= 100, `gave up after ${served} server ticks, not 100`);
    assert.ok(served <= 100 + 19 + 20, `gave up after ${served} server ticks: the world age moves in jumps of 20`);
    // 100 server ticks are 100 * (20 / ticksPerSecond) physics ticks, a look in each 10: 10 looks at 20 tps, 20 at 10 tps.
    const leastLooks = Math.floor((100 * (20 / ticksPerSecond)) / 10);
    assert.ok(looks.length >= leastLooks, `${looks.length} looks, ${leastLooks} expected: it looked on its cadence the whole time`);
    assert.equal(looks[0]!.serverTick, 0, "the first look is at the start");
    // The last look is the one taken at the end, off the cadence.
    const gaps = looks.slice(1, -1).map((entry, index) => entry.physics - looks[index]!.physics);
    assert.ok(gaps.every((gap) => gap >= 10 && gap <= 11), `a look every 10 physics ticks: ${gaps.join(",")}`);
    await assertNothingLeft(fixture);
  });

  test(`at ${ticksPerSecond} tps pollWithinServerTicks never runs two looks at once, and none is left running when it returns`, async () => {
    const fixture = tracedFixture(ticksPerSecond);
    using _timers = fixture.clock.install();
    let running = 0;
    let mostAtOnce = 0;
    let calls = 0;
    // A look of 30 physics ticks (1.5 s) against a cadence of 10: the next look is due while this one runs.
    const slowLook = async () => {
      calls += 1;
      mostAtOnce = Math.max(mostAtOnce, (running += 1));
      await fixture.clock.sleep(30 * PHYSICS_TICK_MS);
      running -= 1;
      return undefined;
    };
    assert.deepEqual(await fixture.clock.settle(pollWithinServerTicks(fixture.bot, 100, 10, slowLook), 60_000), { ended: "budget" });
    assert.equal(running, 0, "a look is still running after the poll returned");
    const callsAtReturn = calls;
    assert.ok(callsAtReturn >= 3, `${callsAtReturn} looks: the cadence is slower than the look`);
    await assertNothingLeft(fixture);
    assert.equal(mostAtOnce, 1, "two looks ran at once");
    assert.equal(calls, callsAtReturn, "a look began after the poll returned");
  });

  test(`at ${ticksPerSecond} tps pollWithinServerTicks finds what appears one server tick short of its budget, and ends on what appears after it`, async () => {
    for (const { appearsAt, expected } of [{ appearsAt: 99, expected: { found: "found" } }, { appearsAt: 200, expected: { ended: "budget" } }] as const) {
      const fixture = tracedFixture(ticksPerSecond);
      using _timers = fixture.clock.install();
      const { look } = recordedLooks(fixture, appearsAt);
      assert.deepEqual(await fixture.clock.settle(pollWithinServerTicks(fixture.bot, 100, 10, look), 60_000), expected, `appears at server tick ${appearsAt}`);
      await assertNothingLeft(fixture);
    }
  });
}

test("with the server stopped, pollWithinServerTicks ends at the stalled-clock bound and has looked at the end", async () => {
  const fixture = tracedFixture();
  using _timers = fixture.clock.install();
  fixture.server.stop();
  const { looks, look } = recordedLooks(fixture, null);
  const startMs = fixture.clock.now();
  const outcome = await fixture.clock.settle(pollWithinServerTicks(fixture.bot, 100, 10, look), 120_000);
  assert.deepEqual(outcome, { ended: "stalled" });
  const waitedMs = fixture.clock.now() - startMs;
  assert.ok(waitedMs >= DRIVER_CLOCK_STOPPED_MS && waitedMs <= DRIVER_CLOCK_STOPPED_MS + 1_000, `ended after ${waitedMs} ms; the stall bound is ${DRIVER_CLOCK_STOPPED_MS}`);
  assert.ok(looks.length >= 2 && looks.every((entry) => entry.serverTick === 0), "the server ran no tick, the client went on looking");
  await assertNothingLeft(fixture);
});

test("pollWithinServerTicks takes one last look at the end: a value that appeared after the last cadence look is found", async () => {
  const fixture = tracedFixture();
  using _timers = fixture.clock.install();
  fixture.server.stop();
  const startMs = fixture.clock.now();
  let looks = 0;
  // A cadence of 2 000 physics ticks (100 s) is longer than the stall bound: only the first look and the last one run, and the value shows between them.
  const look = async () => (++looks, fixture.clock.now() - startMs >= 20_000 ? "found" : undefined);
  assert.deepEqual(await fixture.clock.settle(pollWithinServerTicks(fixture.bot, 100, 2_000, look), 120_000), { found: "found" });
  assert.equal(looks, 2, "the first look and the last");
  await assertNothingLeft(fixture);
});

test("pollWithinServerTicks rethrows a look's error, stops looking and leaves no listener", async () => {
  const fixture = tracedFixture();
  using _timers = fixture.clock.install();
  let calls = 0;
  const failing = async () => {
    calls += 1;
    if (calls === 3) throw new Error("view_status failed");
    return undefined;
  };
  await assert.rejects(fixture.clock.settle(pollWithinServerTicks(fixture.bot, 400, 10, failing), 60_000), /view_status failed/u);
  const callsAtFailure = calls;
  await assertNothingLeft(fixture);
  assert.equal(calls, callsAtFailure, "no look after the failure");
});

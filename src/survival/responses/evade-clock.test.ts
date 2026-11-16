import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { EVADE_WALL_FACTOR, EvadeClock, evadeBudgetTicks } from "./evade-clock.js";

const TICKS = 300;
const WALL_MS = 45_000;

function clockFixture({ ticksPerSecond = 20, timePacketYet = true, phaseMs = 0 } = {}) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, server: { ticksPerSecond, timePacketYet, phaseMs } });
  return { ...harness, clock };
}

/** Move the clock on in 50 ms slices until `count` more time packets were heard, never past `maxMs`. */
async function untilPackets(fixture: ReturnType<typeof clockFixture>, count: number, maxMs = 30_000) {
  let heard = 0;
  const listener = () => { heard++; };
  fixture.bot.on("time", listener);
  try { for (let passed = 0; heard < count && passed < maxMs; passed += 50) await fixture.clock.advance(50); }
  finally { fixture.bot.off("time", listener); }
  assert.ok(heard >= count, `${count} packets within ${maxMs} ms`);
  return heard;
}

test("the budget in ticks is the policy's milliseconds at 20 ticks a second", () => {
  assert.equal(evadeBudgetTicks({ evade_timeout_ms: 15_000 }), TICKS);
  assert.equal(evadeBudgetTicks({ evade_timeout_ms: 3_000 }), 60);
  assert.equal(evadeBudgetTicks({ evade_timeout_ms: 3_001 }), 61, "a partial tick rounds up");
  assert.equal(EVADE_WALL_FACTOR, 3);
});

for (const [ticksPerSecond, endMs] of [[20, 15_000], [10, 30_000]] as const) {
  test(`the clock ends on ticks at the packet where the age moved ${TICKS}, at ${ticksPerSecond} tps (~${endMs} ms)`, async () => {
    const { bot, clock, server } = clockFixture({ ticksPerSecond });
    using _installed = clock.install();
    const origin = bot.time.age!;
    using evade = new EvadeClock(bot, TICKS);
    // Just below: 280 ticks of age moved is not exhausted (the packets come 20 ticks apart).
    const below = Math.floor(280 / ticksPerSecond) * 1_000 + 100;
    await clock.advance(below);
    assert.equal(evade.elapsedTicks(), 280, `age ${server.age}`);
    assert.equal(evade.exhausted, false);
    assert.equal(evade.reason, null);
    assert.equal(evade.signal.aborted, false);
    await clock.advance(endMs + 100 - below);
    assert.equal(evade.exhausted, true);
    assert.equal(evade.reason, "ticks");
    assert.equal(evade.signal.aborted, true);
    assert.equal(evade.elapsedTicks(), server.age - origin);
    assert.ok(evade.elapsedTicks()! >= TICKS && evade.elapsedTicks()! < TICKS + 20, `elapsed ${evade.elapsedTicks()}`);
  });
}

test("the wall ends the clock at 45 s when the server stopped after 2 s (age moved 40); the wall left floors at 1 until then", async () => {
  const { bot, clock, server } = clockFixture();
  using _installed = clock.install();
  using evade = new EvadeClock(bot, TICKS);
  assert.equal(evade.remainingMs(), WALL_MS);
  await clock.advance(2_000);
  server.stop();
  assert.equal(evade.elapsedTicks(), 40);
  assert.equal(evade.remainingMs(), WALL_MS - 2_000);
  await clock.advance(WALL_MS - 1 - 2_000);
  assert.equal(evade.exhausted, false, "44 999 ms: not exhausted");
  assert.equal(evade.signal.aborted, false);
  assert.equal(evade.remainingMs(), 1);
  await clock.advance(0.5);
  assert.equal(evade.remainingMs(), 1, "half a millisecond left reads as 1, never 0, while the clock runs");
  assert.equal(evade.exhausted, false);
  await clock.advance(0.5);
  assert.equal(evade.exhausted, true);
  assert.equal(evade.remainingMs(), 0, "nothing is left once exhausted");
  assert.equal(evade.reason, "wall");
  assert.equal(evade.signal.aborted, true);
  assert.equal(evade.elapsedTicks(), 40);
});

test("a never-heard age is ended by the wall only, with no elapsed ticks", async () => {
  const { bot, clock, server } = clockFixture({ timePacketYet: false });
  using _installed = clock.install();
  server.stop();
  using evade = new EvadeClock(bot, TICKS);
  assert.equal(evade.elapsedTicks(), null);
  assert.equal(evade.ageMovedAtMs(), null, "no age, no move time");
  await clock.advance(WALL_MS - 1);
  assert.equal(evade.exhausted, false);
  assert.equal(evade.elapsedTicks(), null);
  await clock.advance(1);
  assert.equal(evade.reason, "wall");
  assert.equal(evade.elapsedTicks(), null);
  assert.equal(evade.ageMovedAtMs(), null);
});

test("the first age heard mid-attempt is the origin of the ticks", async () => {
  const { bot, clock, server } = clockFixture({ timePacketYet: false });
  using _installed = clock.install();
  using evade = new EvadeClock(bot, TICKS);
  assert.equal(evade.elapsedTicks(), null);
  // The test's own listener is added after the clock's, so it sees the clock's state right after the first packet.
  const atFirstPacket: { age: number; elapsed: number | null }[] = [];
  bot.once("time", () => { atFirstPacket.push({ age: bot.time.age!, elapsed: evade.elapsedTicks() }); });
  server.stop();
  await clock.advance(1_000);
  server.resume();
  await clock.advance(1_100);
  assert.equal(atFirstPacket.length, 1, "a first packet has come");
  assert.equal(atFirstPacket[0]!.elapsed, 0, "the origin is latched at the first age heard");
  const origin = atFirstPacket[0]!.age;
  await clock.advance(13_000);
  assert.equal(evade.elapsedTicks(), bot.time.age! - origin);
  assert.ok(evade.elapsedTicks()! < TICKS && evade.elapsedTicks()! > 200, `age moved ${evade.elapsedTicks()}`);
  assert.equal(evade.exhausted, false);
  await clock.advance(3_000);
  assert.equal(evade.reason, "ticks");
  assert.ok(evade.elapsedTicks()! >= TICKS);
});

test("disposing removes the listener and the timer, and the signal aborts at most once", async () => {
  const { bot, clock } = clockFixture();
  using _installed = clock.install();
  const added = listenersAddedSince(bot);
  const timers = clock.pendingGlobalTimers();
  const evade = new EvadeClock(bot, TICKS);
  assert.equal(added("time"), 1);
  assert.equal(clock.pendingGlobalTimers(), timers + 1, "the wall timer is set");
  let aborts = 0;
  evade.signal.addEventListener("abort", () => { aborts++; });
  evade[Symbol.dispose]();
  evade[Symbol.dispose]();
  assert.equal(added("time"), 0);
  assert.equal(clock.pendingGlobalTimers(), timers, "the wall timer is cleared");
  await clock.advance(WALL_MS + 5_000);
  assert.equal(aborts, 0, "a disposed clock fires nothing past its old wall");
  assert.equal(evade.signal.aborted, false);
});

test("a clock that expired by ticks cleans its timer and aborts once", async () => {
  const { bot, clock } = clockFixture();
  using _installed = clock.install();
  const added = listenersAddedSince(bot);
  const timers = clock.pendingGlobalTimers();
  let aborts = 0;
  {
    using evade = new EvadeClock(bot, 60);
    evade.signal.addEventListener("abort", () => { aborts++; });
    await clock.advance(4_000);
    assert.equal(evade.reason, "ticks");
    assert.equal(aborts, 1);
    assert.equal(clock.pendingGlobalTimers(), timers + 1, "the wall timer stays until the clock is disposed");
  }
  assert.equal(clock.pendingGlobalTimers(), timers, "disposing clears it");
  await clock.advance(WALL_MS);
  assert.equal(aborts, 1);
  assert.equal(added("time"), 0);
});

// Freshness: 30 ticks at the cadence of the server's own time packets, with a 4 500 ms backstop (a packet every 1 s at 20 tps,
// 2 s at 10, 4 s at 5: the interval over its 20 ticks gives the ms a tick takes).
// At each rate (and the packet's place in the second at 20 tps): the on-time warm-up before two packets were heard, the
// rate's limit after, and the limit unchanged by a stopped server. The 5 tps row is the backstop (6 000 capped to 4 500).
for (const { ticksPerSecond, phaseMs, staleAfterMs } of [
  { ticksPerSecond: 20, phaseMs: 0, staleAfterMs: 1_500 }, { ticksPerSecond: 20, phaseMs: 400, staleAfterMs: 1_500 },
  { ticksPerSecond: 10, phaseMs: 0, staleAfterMs: 3_000 }, { ticksPerSecond: 5, phaseMs: 0, staleAfterMs: 4_500 },
]) {
  test(`staleAfterMs follows the packet cadence at ${ticksPerSecond} tps${phaseMs ? ` (packet phase ${phaseMs} ms)` : ""}: ${staleAfterMs} ms`, async () => {
    const fixture = clockFixture({ ticksPerSecond, phaseMs });
    using _installed = fixture.clock.install();
    using evade = new EvadeClock(fixture.bot, TICKS);
    assert.equal(evade.staleAfterMs(), 1_500, "none heard: on time");
    await untilPackets(fixture, 1);
    assert.equal(evade.staleAfterMs(), 1_500, "one heard: on time");
    await untilPackets(fixture, 1);
    assert.equal(evade.staleAfterMs(), staleAfterMs, "two heard");
    fixture.server.stop();
    await fixture.clock.advance(10_000);
    assert.equal(evade.staleAfterMs(), staleAfterMs, "a stopped server leaves it as it was");
  });
}

test("a server that slows from 20 to 10 tps shows it at its first full slow interval, and 3 intervals after it speeds up again it is gone", async () => {
  const fixture = clockFixture();
  using _installed = fixture.clock.install();
  using evade = new EvadeClock(fixture.bot, TICKS);
  await untilPackets(fixture, 3);
  assert.equal(evade.staleAfterMs(), 1_500);
  fixture.server.setTickRate(10);
  await untilPackets(fixture, 1);
  const slow = evade.staleAfterMs();
  assert.ok(slow > 2_800 && slow <= 3_000, `the first full 10 tps interval: ${slow}`);
  fixture.server.setTickRate(20);
  // The slow interval stays among the last 3 for the next two fast intervals, then it is evicted.
  for (const stays of [true, true, false]) {
    await untilPackets(fixture, 1);
    if (stays) assert.ok(evade.staleAfterMs() > 2_800, `the slow interval is still among the last three: ${evade.staleAfterMs()}`);
    else assert.equal(evade.staleAfterMs(), 1_500, "three fast intervals after it, it is gone");
  }
});

test("owed packets that arrive in one burst after a stall keep the limit the server had", async () => {
  const fixture = clockFixture();
  using _installed = fixture.clock.install();
  using evade = new EvadeClock(fixture.bot, TICKS);
  await untilPackets(fixture, 3);
  // A first long stall is dropped (the server warns); the packet after it spans the stall, so the limit widens to the backstop.
  fixture.server.stop();
  await fixture.clock.advance(3_000);
  fixture.server.resume();
  await untilPackets(fixture, 2);
  const beforeCatchUp = evade.staleAfterMs();
  assert.equal(beforeCatchUp, 4_500);
  // A second stall inside 15 s is caught up in full (`fake-server.ts` stall rule): five owed packets at once.
  fixture.server.stop();
  await fixture.clock.advance(5_000);
  let burst = 0;
  fixture.bot.on("time", () => { burst++; });
  fixture.server.resume();
  await fixture.clock.advance(50);
  assert.ok(burst >= 4, `the owed packets came at once: ${burst}`);
  assert.ok(evade.staleAfterMs() >= beforeCatchUp, `a catch-up burst is not a faster server: ${evade.staleAfterMs()}`);
});

test("the age moved at the arrival of each new age: the construction, then every packet that changes it", async () => {
  const fixture = clockFixture();
  using _installed = fixture.clock.install();
  const start = fixture.clock.now();
  using evade = new EvadeClock(fixture.bot, TICKS);
  assert.equal(evade.ageMovedAtMs(), start, "the age known at the start");
  await untilPackets(fixture, 1);
  const first = evade.ageMovedAtMs()!;
  assert.ok(first > start && first <= fixture.clock.now());
  fixture.bot.emit("time");
  assert.equal(evade.ageMovedAtMs(), first, "the same age again is no move");
  await untilPackets(fixture, 1);
  assert.ok(evade.ageMovedAtMs()! > first);
});

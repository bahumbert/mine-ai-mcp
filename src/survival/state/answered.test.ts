import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { serverPacedWallMs } from "../../world/world-age.js";
import { Answered } from "./answered.js";

test("a failed scope captures its own construction and consumes only relevant permissions", () => {
  const answered = new Answered();
  const terrain = { cell: "0,64,0", wall: "stone" };
  const policy = { place: true, bow: true };
  const read = {
    capability: "hide",
    response: "enclose",
    scope: "cell:0,64,0",
    facts: () => terrain,
    permissions: () => ({ place: policy.place }),
  };
  terrain.wall = "cobblestone";
  const entry = answered.remember(read, { kind: "no_passage", why: "The finished wall obstructed the exit." });
  policy.bow = false;
  assert.equal(answered.find("hide", read.scope)?.id, entry.id);
  policy.place = false;
  assert.equal(answered.find("hide", read.scope), null);
});

test("failed recovery does not erase enclosure or rearm on damage", () => {
  const answered = new Answered();
  let food = 3;
  const read = {
    capability: "recovery",
    response: "recover",
    scope: "protected-cell",
    facts: () => ({ usableFood: food }),
    permissions: () => ({ recover: "when_possible" }),
  };
  answered.remember(read, { kind: "budget_exhausted", why: "Health did not reach the requested bar." });
  assert.equal(answered.find("hide", "protected-cell"), null);
  assert.equal(answered.find("recovery", "protected-cell")?.failure.kind, "budget_exhausted");
  food = 0;
  assert.equal(answered.find("recovery", "protected-cell"), null);
});

test("only a declared temporal premise expires, and one arrangement cannot exclude another", () => {
  let now = 100;
  const answered = new Answered(() => now, () => 5_000_000 + now);
  const scope = { capability: "position", response: "fight", scope: "A", facts: () => null, permissions: () => null };
  answered.remember(scope, { kind: "unproductive", why: "No requested-target damage." });
  answered.remember(
    { ...scope, scope: "B" },
    { kind: "projectile_window", why: "Shot still crossing the opening." },
    { premise: "flight_complete", ticks: 2, why: "Observed launch and predicted flight duration." },
  );
  now = 200;
  assert.ok(answered.find("position", "A"));
  assert.equal(answered.find("position", "B"), null);
  answered.clear();
  assert.deepEqual(answered.snapshot(), []);
});

test("a temporal premise expires on the monotonic reading while the entry reports epoch times", () => {
  let monotonic = 1_000;
  let wall = 1_700_000_000_000;
  const answered = new Answered(() => monotonic, () => wall);
  const scope = { capability: "fire", response: "escape", scope: "A", facts: () => null, permissions: () => null };
  const entry = answered.remember(scope, { kind: "no_escape", why: "Still burning." }, { premise: "retry_after_failure", ticks: 40, why: "Retry." });
  assert.equal(entry.since, wall);
  assert.equal(entry.temporal?.expiresAt, wall + 2_000, "the record is a 20 tps estimate: ticks * 50");
  wall -= 800; // WSL steps the wall clock back: the deadline is not the wall clock's
  monotonic += 1_999;
  assert.ok(answered.find("fire", "A"), "1 ms left on the monotonic clock");
  monotonic += 2;
  assert.equal(answered.find("fire", "A"), null);
});

// A pause counts world ticks (plan 2026-11-16-reflex-limits-ticks T3). The fake server's time packet comes once per 20
// ticks, the first at age `A` (START_AGE) at 0 ms; each pause is remembered `CREATED_AFTER_MS` later, so its cached age is
// `A` and its deadline is the packet of age `A + ticks + 20`: at 20 tps (50 ms a tick) `(ticks + 20) * 50` ms after the
// start, at 10 tps twice that.
const START_AGE = 1_000;
const CREATED_AFTER_MS = 500;
const RATES = [
  { ticksPerSecond: 20, msPerTick: 50 },
  { ticksPerSecond: 10, msPerTick: 100 },
] as const;
const FAILURE = { kind: "no_escape", why: "Still burning." };

/** A pause of `ticks` remembered 500 ms after the packet of age `A`, on the fake server's age and clock. */
async function pausedOnServer(ticksPerSecond: number, ticks: number, facts: () => number | null = () => null) {
  const clock = createFakeClock({ mode: "manual" });
  const { bot, server } = createFakeBot({ clock, server: { startAge: START_AGE, ticksPerSecond } });
  await clock.advance(CREATED_AFTER_MS);
  const answered = new Answered(clock.now, () => 5_000_000 + clock.now(), () => bot.time.age);
  const scope = { capability: "fire", response: "escape", scope: "A", facts, permissions: () => null };
  const entry = answered.remember(scope, FAILURE, { premise: "retry_after_failure", ticks, why: "Retry." });
  return { answered, entry, server, clock, age: () => bot.time.age, createdMs: clock.now() };
}

for (const { ticksPerSecond, msPerTick } of RATES) {
  test(`a 200-tick pause is found at the packet of age A + 200 and gone at A + 220 (${ticksPerSecond} tps)`, async () => {
    const { answered, clock, age, createdMs } = await pausedOnServer(ticksPerSecond, 200);
    await clock.advance(200 * msPerTick - createdMs);
    assert.equal(age(), START_AGE + 200);
    assert.ok(answered.find("fire", "A"), "A + 200: 20 ticks short, one packet of margin");
    await clock.advance(20 * msPerTick);
    assert.equal(age(), START_AGE + 220);
    assert.equal(clock.now(), 220 * msPerTick, `${220 * msPerTick} ms after the server start (old code: gone at 10 000 ms)`);
    assert.equal(answered.find("fire", "A"), null);
  });

  test(`a pause not read until the packet of age A + 300 is gone at that first read, not restarted from it (${ticksPerSecond} tps)`, async () => {
    const { answered, clock, age, createdMs } = await pausedOnServer(ticksPerSecond, 200);
    await clock.advance(300 * msPerTick - createdMs);
    assert.equal(age(), START_AGE + 300);
    assert.equal(answered.find("fire", "A"), null);
  });

  test(`a pause read every 25 ms ends at the same packet as one read once (${ticksPerSecond} tps)`, async () => {
    const { answered, clock, age } = await pausedOnServer(ticksPerSecond, 200);
    while (age() < START_AGE + 220) {
      assert.ok(answered.find("fire", "A"), `found at age ${age()}`);
      await clock.advance(25);
    }
    assert.equal(clock.now(), 220 * msPerTick);
    assert.equal(answered.find("fire", "A"), null);
  });

  test(`a changed fact reopens a pause at once, whatever its ticks (${ticksPerSecond} tps)`, async () => {
    let reads = 0;
    const { answered } = await pausedOnServer(ticksPerSecond, 200, () => ++reads);
    assert.equal(answered.find("fire", "A"), null, "the facts differ at the first read: no wait for the ticks");
  });

  test(`a pause on a stopped server ends on its wall, 33 000 ms after it was remembered, not before (${ticksPerSecond} tps)`, async () => {
    const { answered, clock, server, createdMs } = await pausedOnServer(ticksPerSecond, 200);
    server.stop();
    await clock.advance(serverPacedWallMs(200) - 1);
    assert.equal(clock.now() - createdMs, serverPacedWallMs(200) - 1);
    assert.ok(answered.find("fire", "A"), "32 999 ms after the remember");
    await clock.advance(1);
    assert.equal(answered.find("fire", "A"), null, "33 000 ms after the remember");
  });
}

test("a pause with no age to read ends at ticks * 50 ms, and the record says the same", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const answered = new Answered(clock.now, () => 1_700_000_000_000);
  const scope = { capability: "fire", response: "escape", scope: "A", facts: () => null, permissions: () => null };
  const entry = answered.remember(scope, FAILURE, { premise: "retry_after_failure", ticks: 200, why: "Retry." });
  assert.equal(entry.temporal!.expiresAt - entry.since, 200 * 50);
  await clock.advance(9_999);
  assert.ok(answered.find("fire", "A"));
  await clock.advance(1);
  assert.equal(answered.find("fire", "A"), null);
});

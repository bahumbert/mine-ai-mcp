// The held request's first-wins transitions, clock boundaries and cleanup.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock, flush } from "../test-support/fake-bot/index.js";
import { watch } from "../test-support/pending.js";
import { SERVER_CLOCK_STOPPED_MS } from "../world/world-age.js";
import type { Continuation } from "./abort.js";
import { HeldRequest } from "./held-request.js";

const OWNER = "hostile_reflex";
const HOLD = "[HOSTILE_SETTLED] evade exhausted.";
const CONTACT = "[HOSTILE_CONTACT] fight.";
const hold: Continuation = { kind: "hold", owner: OWNER, reason: HOLD, backstopTicks: 600 };

test("held observers report only winning changes, including re-entry and the terminal backstop", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const events: unknown[] = [];
  const record = new HeldRequest({ request: "walk", owner: OWNER, reason: HOLD, backstopTicks: 600,
    worldAge: () => 1_000, onTransition: (event) => events.push(event) });
  record.attach(OWNER, CONTACT);
  record.backstop(); // An attached claim wins over the expired waiting generation.
  record.verdict(hold, OWNER);
  record.backstop();
  record.attach(OWNER, "late");
  record.release("late");
  record.abort("late");
  assert.deepEqual(events, [
    { request: "walk", owner: OWNER, outcome: "attached", generation: 1, worldAge: 1_000, resumed: false },
    { request: "walk", owner: OWNER, outcome: "held", generation: 2, worldAge: 1_000, resumed: false },
    { request: "walk", owner: OWNER, outcome: "backstop", generation: 2, worldAge: 1_000, resumed: false },
  ]);
  await record.done;
  await clock.advance(100_000, 1_000);
  assert.equal(events.length, 3);
  assert.equal(clock.pendingGlobalTimers(), 0);
});

/** A hold hears the same packet clock as the body that created it. */
function held(worldAge: () => number | null = () => null) {
  return new HeldRequest({ request: "walk", owner: OWNER, reason: HOLD, backstopTicks: 600, worldAge });
}

for (const first of ["attach", "release", "backstop", "abort"] as const) {
  for (const second of ["attach", "release", "backstop", "abort"] as const) {
    test(`held request: ${first} wins before ${second} at the same instant`, async () => {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const record = held();
      const transitions = {
        attach: () => record.attach(OWNER, CONTACT),
        release: () => record.release("stand_down", first !== "release" && second === "release"
          ? "no projectile in flight, no hostile tracked" : null),
        backstop: () => record.backstop(),
        abort: () => record.abort("operator stop"),
      };
      assert.equal(transitions[first](), true);
      // Cancellation of the request is final even after a claim attached.
      assert.equal(transitions[second](), first === "attach" && second === "abort");
      assert.equal(record.snapshot().resumed, false);
      if (first === "attach" && second !== "abort") {
        assert.equal(record.state, "attached");
        record.verdict({ kind: "resume" }, OWNER);
      }
      const end = await record.done;
      assert.equal(end.kind, first === "abort" || second === "abort" && first === "attach" ? "abort"
        : first === "attach" ? "resume" : "return");
      assert.equal(record.snapshot().resumed, false, "an attached verdict is not an evidence release");
      assert.equal(clock.pendingGlobalTimers(), 0);
      await clock.advance(100_000, 1_000);
      assert.equal(clock.pendingGlobalTimers(), 0);
    });
  }
}

for (const continuation of [hold, { kind: "resume" }] as Continuation[]) {
  for (const ticksPerSecond of [20, 10]) {
  test(`held request: ${continuation.kind} resets the same record's deadline at ${ticksPerSecond} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const harness = createFakeBot({ clock, server: { ticksPerSecond, startAge: 1_000 } });
    const tickMs = 1_000 / ticksPerSecond;
    await clock.advance(19 * tickMs);
    const baseline = clock.pendingGlobalTimers();
    const record = held(() => harness.bot.time.age);
    const pending = watch(record.done);
    await clock.advance(400 * tickMs);
    assert.equal(record.attach(OWNER, CONTACT), true);
    assert.equal(clock.pendingGlobalTimers(), baseline);
    await clock.advance(700 * tickMs);
    assert.equal(pending.over, false, "the old deadline cannot fire while a claim owns the hold");
    assert.equal(record.verdict(continuation, continuation.kind === "resume" ? "hunger_reflex" : OWNER), true);
    assert.equal(record.state, "waiting");
    assert.equal(record.generation, 2);
    assert.deepEqual(record.reasons, continuation.kind === "hold" ? [HOLD, CONTACT, HOLD] : [HOLD, CONTACT]);
    const resetMs = clock.now();
    const resetAge = harness.bot.time.age!;
    await clock.advance(600 * tickMs - 1);
    assert.equal(pending.over, false, "generation 2 gets its own complete tick budget");
    assert.equal((await clock.settle(record.done, 40 * tickMs)).kind, "return");
    assert.equal(record.state, "backstop");
    assert.ok(harness.bot.time.age! - resetAge >= 620);
    const elapsedTicks = (clock.now() - resetMs) / tickMs;
    assert.ok(elapsedTicks >= 600 && elapsedTicks <= 639, `${elapsedTicks} ticks since re-entry`);
    assert.equal(clock.pendingGlobalTimers(), baseline);
    await clock.advance(100_000, 1_000);
    assert.equal(clock.pendingGlobalTimers(), baseline);
  });
  }
}

for (const by of [OWNER, "footing_reflex"]) {
  for (const continuation of [{ kind: "return", reason: "cannot fight" }, { kind: "cancel", cause: { kind: "death" } }] as const) {
    test(`held request: ${by}'s ${continuation.kind} ends an attached record`, async () => {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const record = held();
      assert.equal(record.attach(OWNER, CONTACT), true);
      assert.equal(record.verdict(continuation, by), true);
      assert.equal((await record.done).kind, continuation.kind === "cancel" ? "abort" : "return");
      if (continuation.kind === "return") assert.equal((await record.done).reason, continuation.reason);
      assert.equal(record.attach(OWNER, "late"), false);
      assert.equal(record.verdict({ kind: "resume" }, OWNER), false);
      assert.equal(clock.pendingGlobalTimers(), 0);
      await clock.advance(100_000, 1_000);
      assert.equal(clock.pendingGlobalTimers(), 0);
    });
  }
}

test("held request: release keeps the last receipt and names the decision", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const record = held();
  assert.equal(record.release("stand_down", null), true);
  assert.deepEqual(await record.done, { kind: "return", reason: `${HOLD}; ${OWNER} chose no further response (stand_down).` });
});

test("held request: stand-down evidence resumes once with the receipt and release suffix", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const record = held();
  const suffix = "; hostile_reflex stood down (no projectile in flight, no hostile tracked): the walk resumes.";
  assert.equal(record.release("none_observed", "no projectile in flight, no hostile tracked"), true);
  assert.deepEqual(await record.done, { kind: "resume", reason: `${HOLD}${suffix}` });
  assert.equal(record.suffix, suffix);
  assert.equal(record.snapshot().resumed, true);
  assert.equal(record.release("late", "late evidence"), false);
  await clock.advance(100_000, 1_000);
  assert.equal(clock.pendingGlobalTimers(), 0);
});

for (const ticksPerSecond of [20, 10]) {
  for (const offsetTicks of [19, 21]) {
    test(`held request: 600 ticks never expire early, creation tick ${offsetTicks} at ${ticksPerSecond} tps`, async () => {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const harness = createFakeBot({ clock, server: { ticksPerSecond, startAge: 1_000 } });
      await clock.advance(offsetTicks * 1_000 / ticksPerSecond);
      const baseline = clock.pendingGlobalTimers();
      const record = held(() => harness.bot.time.age);
      const startedMs = clock.now();
      const pending = watch(record.done);
      await clock.advance(600 * 1_000 / ticksPerSecond - 1);
      assert.equal(pending.over, false);
      assert.equal((await clock.settle(record.done, 40 * 1_000 / ticksPerSecond)).kind, "return");
      assert.equal(record.state, "backstop");
      const elapsedTicks = (clock.now() - startedMs) * ticksPerSecond / 1_000;
      assert.ok(elapsedTicks >= 600 && elapsedTicks <= 639, `${elapsedTicks} ticks`);
      assert.ok(harness.bot.time.age! - record.startedAge! >= 620);
      if (ticksPerSecond === 10) assert.ok(clock.now() - startedMs >= 60_000);
      assert.equal(clock.pendingGlobalTimers(), baseline);
      await clock.advance(100_000, 1_000);
      assert.equal(clock.pendingGlobalTimers(), baseline);
    });
  }
  test(`held request: stopped clock ends after ${SERVER_CLOCK_STOPPED_MS} ms at ${ticksPerSecond} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const harness = createFakeBot({ clock, server: { ticksPerSecond, startAge: 1_000 } });
    harness.server.stop();
    const record = held(() => harness.bot.time.age);
    const pending = watch(record.done);
    await clock.advance(SERVER_CLOCK_STOPPED_MS - 1);
    assert.equal(pending.over, false);
    await clock.advance(1);
    assert.equal((await record.done).kind, "return");
    assert.equal(record.state, "backstop");
    assert.equal(harness.bot.time.age, 1_000);
    assert.equal(clock.pendingGlobalTimers(), 0);
  });
}

test("held request: no age at creation uses 30 seconds even if packets arrive later", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  let age: number | null = null;
  const record = held(() => age);
  const pending = watch(record.done);
  age = 1_000;
  await clock.advance(29_999);
  assert.equal(pending.over, false);
  await clock.advance(1);
  assert.match((await record.done).reason!, /no decision from hostile_reflex within 600 world ticks/);
  assert.equal(clock.now(), 30_000);
  assert.equal(clock.pendingGlobalTimers(), 0);
  await flush();
});

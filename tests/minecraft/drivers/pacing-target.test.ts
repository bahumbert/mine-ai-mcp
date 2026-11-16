// The timing driver rejects pacing fights that never limit or retry before the escalating pause, counts world age, and ends on a stopped server clock.
import assert from "node:assert/strict";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import { ExecutionScope, executionChannel } from "../../../src/execution/execution-scope.ts";
import { createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { SurvivalPolicyState } from "../../../src/survival/state/survival-policy.ts";
import { arenaFrame } from "../arena/frame.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import type { ScenarioCall } from "../scenario.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "./server-ticks.ts";
import { MAX_FIGHT_TICKS, run } from "./pacing-target.ts";

/** One fight is a scope of the Collector's `combat` operation opened and closed at fake clock times (ms from the start). */
type Fight = readonly [start: number, end: number];
type Rate = 20 | 10;
const RATES: readonly Rate[] = [20, 10];
/** The fake server sends a 20-tick time packet each second at 20 tps and each 2 s at 10 tps (`fake-server.ts` ticksPerSecond), so the age moves `rate` ticks per second. */
const ageAt = (rate: Rate, ms: number) => rate * Math.floor(ms / 1000);

function pacingFixture(options: { fights: readonly Fight[]; limitsAt: readonly number[]; limit?: string; rate: Rate; cancelThrows?: boolean }) {
  const clock = createFakeClock({ mode: "mocked" });
  const installed = clock.install();
  const harness = createFakeBot({ clock, server: { ticksPerSecond: options.rate } });
  const { bot } = harness;
  const status = { summary: "safe", request: null,
    owner: { current: null, reserved: null, connected: true, transfer: null }, dangers: [], response: null,
    decisions: [], budgets: [], answered: [], observations: { missing: [], stale: [] },
    policy: new SurvivalPolicyState(bot).snapshot(), vitals: { health: 20, food: 20, air: null, inWater: false },
    runtime: { liveness: "observed_in_process", observedAt: 0, physicsObservedAt: null } };
  const unread: unknown[] = [];
  const calls: string[] = [];
  let id = 0;
  for (const [at, end] of options.fights) clock.after(at, () => {
    const scope = new ExecutionScope({ bot: bot.username, operation: "combat", targetId: 7 });
    scope.runSync("swing", () => {});
    clock.after(end - at, () => scope[Symbol.dispose]());
  });
  for (const at of options.limitsAt) clock.after(at, () => unread.push({
    eventId: ++id, botId: bot.username, type: "survival_outcome", observedAt: new Date().toISOString(), summary: "limit",
    payload: { kind: "outcome", source: "hostile_reflex", evidence: { outcome: { kind: "limit", limit: options.limit ?? "no_progress" } }, status },
  }));
  const context = scenarioTestContext({ bot, arena: arenaFrame({ x: 64, z: 1536 }),
    scenario: scenarioDefinitionSchema.parse({ goal: { kind: "completion" } }),
    call: async (action: string) => {
      calls.push(action);
      if (action === "cancel_foreground_action" && options.cancelThrows) throw new Error("cancel refused");
      return { action, durationMs: 0, summary: "trace", result: {
        status: "succeeded", source: { queryIds: ["unread-events-page"] }, events: unread.splice(0), readThroughEventId: id, remainingEventCount: 0,
      } } as ScenarioCall;
    },
  });
  /** The fake time and world age at each poll where the age moved: the driver's own view of the server clock. */
  const advances: { at: number; age: number }[] = [];
  let seenAge = bot.time.age;
  const sleep = (ms: number) => {
    if (bot.time.age !== seenAge) { seenAge = bot.time.age; advances.push({ at: clock.now(), age: seenAge }); }
    return clock.sleep(ms);
  };
  return { clock, installed, harness, bot, context, sleep, advances, calls, startAge: bot.time.age };
}

/** T6: every exit cancels the foreground action once, last, releases the execution observer, and does no more work past the old 150 s wall cap. */
async function assertCleanExit(fixture: ReturnType<typeof pacingFixture>) {
  const calls = [...fixture.calls];
  assert.equal(calls.filter(call => call === "cancel_foreground_action").length, 1, `${calls.length} driver calls, the last is ${calls.at(-1)}`);
  assert.equal(calls.at(-1), "cancel_foreground_action", "the cancel is the last call");
  assert.equal(executionChannel.hasSubscribers, false, "the execution observer is released");
  await fixture.clock.advance(200_000);
  assert.deepEqual(fixture.calls, calls, "no driver call after it settled");
}

test("pacing timing checks run in any lane and reject early retries or missing limits, at both rates, at the third fight's poll", async () => {
  // Fights: [50, 30_050], [firstRetry, secondEnd], [third + 50, third + 100]; each limit is read at its fight's end. Pauses asserted: 10 s, then 20 s.
  for (const rate of RATES) {
    for (const { firstRetry = 40_050, third, secondEnd, limit = "no_progress", reason } of [
      { third: 90_000, secondEnd: 70_050 },
      { third: 90_000, secondEnd: 70_050, firstRetry: 39_950, reason: /"pause":10000/u },
      { third: 80_000, secondEnd: 70_050, reason: /"pause":20000/u },
      { third: 90_000, secondEnd: 70_050, limit: "ceiling", reason: /ceiling/u },
      { third: 90_000, secondEnd: 80_050, reason: /"pause":20000/u },
    ]) {
      const label = `${rate} tps, retry at ${firstRetry}, third at ${third}, second end ${secondEnd}, limit ${limit}`;
      const fixture = pacingFixture({ fights: [[50, 30_050], [firstRetry, secondEnd], [third + 50, third + 100]],
        limitsAt: [30_050, secondEnd], limit, rate });
      using _installed = fixture.installed;
      const completion = fixture.clock.settle(run(fixture.context, fixture.sleep), 100_000);
      const polledAt = third + 100;
      if (reason) await assert.rejects(completion, (error: unknown) => error instanceof assert.AssertionError && reason.test(error.message), label);
      else {
        const result = await completion;
        assert.equal(result.status, "succeeded", label);
        assert.equal((JSON.parse(result.detail) as { ageTicks: number }).ageTicks, ageAt(rate, polledAt), `${label}: world age at fake time ${polledAt} ms`);
      }
      assert.equal(fixture.clock.now(), polledAt, `${label}: the third fight is seen at the poll after its start`);
      assert.equal(fixture.bot.time.age - fixture.startAge, ageAt(rate, polledAt), `${label}: world age`);
      await assertCleanExit(fixture);
    }
  }
});

test("a stopped server clock fails the driver 30 s after its last world-age advance, not at a wall cap, at both rates", async () => {
  for (const rate of RATES) {
    const fixture = pacingFixture({ fights: [[50, 30_050], [40_050, 70_050], [90_050, 90_100]], limitsAt: [30_050, 70_050], rate });
    using _installed = fixture.installed;
    // The server stops at 30 100 ms, after the packet at 30 000 ms (even second: both rates send one there).
    fixture.clock.after(30_100, () => fixture.harness.server.stop());
    await assert.rejects(fixture.clock.settle(run(fixture.context, fixture.sleep), 100_000),
      (error: unknown) => error instanceof assert.AssertionError && /server clock stopped: world age \d+ has not moved for 30000 ms, \d+ ticks after the start/u.test(error.message));
    const last = fixture.advances.at(-1)!;
    assert.equal(last.age - fixture.startAge, ageAt(rate, 30_000), `${rate} tps: the last advance is the packet at 30 000 ms`);
    assert.ok(last.at >= 30_000 && last.at <= 30_100, `${rate} tps: it was polled at fake time ${last.at} ms`);
    assert.equal(fixture.bot.time.age, last.age, `${rate} tps: the age stayed frozen at ${last.age} until the failure`);
    assert.equal(fixture.clock.now(), last.at + DRIVER_CLOCK_STOPPED_MS, `${rate} tps: fails at ${last.at} + ${DRIVER_CLOCK_STOPPED_MS} ms, not at a 150 s wall cap`);
    await assertCleanExit(fixture);
  }
});

test("a world age past MAX_FIGHT_TICKS with two fights fails with the fights, at the fake time the server reaches that age, at both rates", async () => {
  for (const rate of RATES) {
    const fixture = pacingFixture({ fights: [[50, 30_050], [40_050, 70_050]], limitsAt: [30_050, 70_050], rate });
    using _installed = fixture.installed;
    await assert.rejects(fixture.clock.settle(run(fixture.context, fixture.sleep), 500_000), (error: unknown) => {
      assert.ok(error instanceof assert.AssertionError);
      assert.match(error.message, /"fights":\[\{"scope":"[^"]+","target":7,"start":\d+,"end":30\d{3}\},\{"scope":"[^"]+","target":7,"start":40\d{3},"end":70\d{3}\}\]/u);
      return true;
    });
    // The age passes MAX_FIGHT_TICKS (a multiple of 20) at the next 20-tick packet: MAX + 20 ticks after the start, `rate` ticks per second of fake time.
    const age = fixture.bot.time.age - fixture.startAge;
    const expectedMs = (MAX_FIGHT_TICKS + 20) * (1000 / rate);
    assert.equal(age, MAX_FIGHT_TICKS + 20, `${rate} tps: world age ${fixture.bot.time.age} (${age} ticks after the start) at fake time ${fixture.clock.now()} ms`);
    assert.equal(fixture.clock.now(), expectedMs, `${rate} tps: the server reaches that age at ${MAX_FIGHT_TICKS + 20} ticks x ${1000 / rate} ms`);
    await assertCleanExit(fixture);
  }
});

test("a cancel that throws still releases the execution observer and surfaces its error", async () => {
  const fixture = pacingFixture({ fights: [[50, 30_050], [40_050, 70_050], [90_050, 90_100]], limitsAt: [30_050, 70_050], rate: 20, cancelThrows: true });
  using _installed = fixture.installed;
  await assert.rejects(fixture.clock.settle(run(fixture.context, fixture.sleep), 100_000), /cancel refused/u);
  assert.equal(executionChannel.hasSubscribers, false, "the observer is removed before the cancel call");
  assert.equal(fixture.calls.filter(call => call === "cancel_foreground_action").length, 1);
});

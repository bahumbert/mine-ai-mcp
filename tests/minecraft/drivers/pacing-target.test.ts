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
import { type AgedFight, MAX_FIGHT_TICKS, run, spanProblems, spansHold } from "./pacing-target.ts";

/** One fight is a scope of the Collector's `combat` operation opened and closed at fake clock times (ms from the start). */
type Fight = readonly [start: number, end: number];
type Rate = 20 | 10;
const RATES: readonly Rate[] = [20, 10];
/** The fake server sends a 20-tick time packet each second at 20 tps and each 2 s at 10 tps (`fake-server.ts` ticksPerSecond), so the age moves `rate` ticks per second. */
const ageAt = (rate: Rate, ms: number) => rate * Math.floor(ms / 1000);
/** Fake milliseconds of `ticks` server ticks at `rate`: 1000 / rate ms each. */
const msOf = (rate: Rate, ticks: number) => ticks * 1000 / rate;

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

/**
 * The timeline in ticks: fight 0 starts at 100 ms, each gap and span converts at `rate`; the third fight starts at a multiple of 100 ms
 * so the driver sees it at the poll `third + 100`. Every span is a whole number of seconds, so the ages read exactly.
 */
function timeline(rate: Rate, plan: { span1: number; span2: number; gap1: number; gap2: number }) {
  const end0 = 100 + msOf(rate, plan.span1);
  const start1 = end0 + msOf(rate, plan.gap1);
  const end1 = start1 + msOf(rate, plan.span2);
  const third = end1 + msOf(rate, plan.gap2);
  const fights: Fight[] = [[100, end0], [start1, end1], [third + 50, third + 100]];
  return { fights, limitsAt: [end0, end1], polledAt: third + 100 };
}

/** The owner's passing timeline at 20 tps: fights of 620 ticks (31 s), pauses of 220 and 420 ticks (11 s and 21 s). */
const PASSING = { span1: 620, span2: 620, gap1: 220, gap2: 420 };

test("pacing timing checks run in any lane and reject early retries, short fights or missing limits, at both rates, at the third fight's poll", async () => {
  const cases: { plan: typeof PASSING; limit?: string; reason?: RegExp }[] = [
    { plan: PASSING },
    { plan: { ...PASSING, gap1: 200, gap2: 400 } },
    { plan: { ...PASSING, gap1: 180 }, reason: /pause 0 is 180 ticks/u },
    { plan: { ...PASSING, gap2: 380 }, reason: /pause 1 is 380 ticks/u },
    { plan: { ...PASSING, span1: 580 }, reason: /fight 0 spans 580 ticks/u },
    { plan: { ...PASSING, span2: 300 }, reason: /fight 1 spans 300 ticks/u },
    { plan: PASSING, limit: "ceiling", reason: /ceiling/u },
  ];
  for (const rate of RATES) {
    for (const { plan, limit = "no_progress", reason } of cases) {
      const label = `${rate} tps, ${JSON.stringify(plan)}, limit ${limit}`;
      const { fights, limitsAt, polledAt } = timeline(rate, plan);
      const fixture = pacingFixture({ fights, limitsAt, limit, rate });
      using _installed = fixture.installed;
      const completion = fixture.clock.settle(run(fixture.context, fixture.sleep), 300_000);
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

test("spansHold: each no_progress fight spans 581 ticks and each pause 181 and 381, with both sides of each bound", () => {
  const fightsAt = (spans: readonly [number, number], pauses: readonly [number, number]): AgedFight[] => {
    const firstEnd = spans[0];
    const secondStart = firstEnd + pauses[0];
    const secondEnd = secondStart + spans[1];
    return [{ startAge: 0, endAge: firstEnd }, { startAge: secondStart, endAge: secondEnd }, { startAge: secondEnd + pauses[1], endAge: null }];
  };
  assert.equal(spansHold(fightsAt([581, 581], [181, 381])), true);
  const cases = [
    { spans: [580, 581], pauses: [181, 381], reason: /fight 0 spans 580 ticks/u },
    { spans: [581, 580], pauses: [181, 381], reason: /fight 1 spans 580 ticks/u },
    { spans: [581, 581], pauses: [180, 381], reason: /pause 0 is 180 ticks/u },
    { spans: [581, 581], pauses: [181, 380], reason: /pause 1 is 380 ticks/u },
  ] as const;
  for (const { spans, pauses, reason } of cases) {
    const problems = spanProblems(fightsAt(spans, pauses));
    assert.equal(spansHold(fightsAt(spans, pauses)), false, JSON.stringify({ spans, pauses }));
    assert.equal(problems.length, 1, JSON.stringify({ spans, pauses, problems }));
    assert.match(problems[0]!, reason);
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
      // The failure message carries the fights as JSON: each recorded field is checked on its own, not the key order.
      assert.equal(error.message.match(/"target":7/gu)?.length, 2, error.message);
      assert.match(error.message, /"end":30\d{3}/u);
      assert.match(error.message, /"start":40\d{3}/u);
      assert.match(error.message, /"startAge":\d+/u);
      assert.match(error.message, /"endAge":\d+/u);
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

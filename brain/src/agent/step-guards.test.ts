// Tests of the goal-call pacing guard (ADR-011): the wait between own-goal thinking, and what holds it back.
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentOptions } from "../agent.ts";
import { createFakeClock, type FakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { testPersona } from "../testing.ts";
import { StepGuards } from "./step-guards.ts";
import type { Work } from "./work.ts";

type StepGuardHost = ConstructorParameters<typeof StepGuards>[0];

/**
 * The guard reads `performance.now` (`monotonicNow`), which the installed fake clock drives: time moves only by the slices
 * the host waits, never by real time, so a stalled machine cannot shorten or stretch a wait. Each `idle(ms)` records its
 * slice, sleeps `ms` on that clock, then runs the test's `afterSlice` with the slices so far. The persona paces one goal
 * call every 10 s.
 */
function guardFor(clock: FakeClock) {
  const slices: number[] = [];
  const controller = new AbortController();
  const state: { order: boolean; afterSlice: ((sofar: readonly number[]) => void) | undefined } = { order: false, afterSlice: undefined };
  const host: StepGuardHost = {
    options: { persona: testPersona({ settings: { ...testPersona().settings, goalCallsPerMinute: 6 } }) } as AgentOptions,
    pollMs: 1_000,
    runSignal: () => controller.signal,
    top: () => (state.order ? ({ objective: { requester: "Steve" } } as Work) : undefined),
    idle: async (ms) => {
      slices.push(ms);
      await clock.sleep(ms);
      state.afterSlice?.(slices);
    },
  };
  return { guards: new StepGuards(host), slices, controller, state, clockNow: () => clock.now() };
}

test("the first goal call goes at once", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { guards, slices } = guardFor(clock);
  assert.equal(await clock.settle(guards.waitForGoalBudget(), 60_000), true);
  assert.deepEqual(slices, []);
});

test("the next goal call waits the persona's interval, in slices of at most pollMs", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { guards, slices } = guardFor(clock);
  assert.equal(await clock.settle(guards.waitForGoalBudget(), 60_000), true);
  assert.equal(await clock.settle(guards.waitForGoalBudget(), 60_000), true);
  assert.ok(slices.every((ms) => ms <= 1_000), `a slice longer than pollMs: ${slices}`);
  const waited = slices.reduce((sum, ms) => sum + ms, 0);
  assert.equal(waited, 10_000, `waited ${waited} ms of the 10 000 ms interval`);
});

test("an order on top before the call is never held: false at once", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { guards, slices, state } = guardFor(clock);
  state.order = true;
  assert.equal(await clock.settle(guards.waitForGoalBudget(), 60_000), false);
  assert.deepEqual(slices, []);
});

test("an order that arrives during the wait ends it", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { guards, slices, state } = guardFor(clock);
  assert.equal(await clock.settle(guards.waitForGoalBudget(), 60_000), true);
  state.afterSlice = (sofar) => {
    if (sofar.length === 3) state.order = true;
  };
  assert.equal(await clock.settle(guards.waitForGoalBudget(), 60_000), false);
  assert.equal(slices.length, 3);
});

test("an order that arrives on the wait's last slice is not held behind the goal call", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { guards, slices, state, clockNow } = guardFor(clock);
  assert.equal(await clock.settle(guards.waitForGoalBudget(), 60_000), true);
  // The wait ends at the deadline of the first call plus the 10 s interval: the order arrives on the slice that reaches it.
  const deadline = clockNow() + 10_000;
  state.afterSlice = () => {
    if (clockNow() >= deadline) state.order = true;
  };
  assert.equal(await clock.settle(guards.waitForGoalBudget(), 60_000), false);
  assert.equal(clockNow(), deadline, "the refused call waited the whole interval");
  // The refused call spent no budget: once the order is cleared, the next call goes at once.
  state.afterSlice = undefined;
  state.order = false;
  const waitedSoFar = slices.length;
  assert.equal(await clock.settle(guards.waitForGoalBudget(), 60_000), true);
  assert.equal(slices.length, waitedSoFar);
});

test("an aborted run ends the wait with false", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { guards, slices, controller, state } = guardFor(clock);
  assert.equal(await clock.settle(guards.waitForGoalBudget(), 60_000), true);
  state.afterSlice = (sofar) => {
    if (sofar.length === 1) controller.abort();
  };
  assert.equal(await clock.settle(guards.waitForGoalBudget(), 60_000), false);
  assert.equal(slices.length, 1);
});

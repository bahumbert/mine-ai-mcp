// Goal-budget waits admit orders without charging the character another goal call.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock, type FakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { FakeRuntime, steppedClocks, testPersona, until } from "../testing.ts";
import { agentFor, clockedAgentFor, say } from "./agent-fixtures.test.ts";

/** `condition` on the installed clock, checked every 1 ms of clock; fails once `maxMs` of clock pass (the bound of the `until` it replaces). */
async function untilOnClock(clock: FakeClock, condition: () => boolean, maxMs = 2_000): Promise<void> {
  let cancel = () => {};
  try {
    await clock.settle(new Promise<void>((resolve) => { cancel = clock.every(() => { if (condition()) resolve(); }, 1); }), maxMs, 1);
  } finally {
    cancel();
  }
}

test("after a granted goal call the next one is held for 60000 / goalCallsPerMinute ms, not half of it", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runtime = new FakeRuntime();
  const { planner, action, stop } = clockedAgentFor(clock, runtime, { goal: "live well", settings: { ...testPersona().settings, goalCallsPerMinute: 6 } });
  try {
    planner.reply({ objective: "rest a while" });
    action.reply({ done: "rested" });
    await untilOnClock(clock,() => planner.requests.length === 1);
    // The first call was granted (6 a minute: the next is due 10 s later); the objective's first step is the next goal call.
    await clock.advance(6_000);
    assert.equal(action.requests.length, 0, "6 s after a grant at 6 calls a minute the next call is still held");
    await clock.advance(4_000);
    await untilOnClock(clock,() => action.requests.length === 1);
  } finally {
    await stop();
  }
});

test("an order that arrives while the next goal call is held is served at once, not after the hold", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runtime = new FakeRuntime();
  const { agent, chat, planner, action, stop } = clockedAgentFor(clock, runtime, { goal: "live well", settings: { ...testPersona().settings, goalCallsPerMinute: 6 } }, { pollMs: 60_000 });
  try {
    planner.reply({ objective: "rest a while" });
    await untilOnClock(clock,() => planner.requests.length === 1);
    // The goal's first step sleeps for the 10 s hold; the order wakes it and is served well inside it (2 s of clock).
    chat.reply({ say: "On it.", route: "act", request: "mine stone" }, { say: "Done." });
    action.reply({ done: "nothing to mine" }, { done: "rested" });
    await clock.settle(agent.handle(say("Steve", "mine stone")), 10_000);
    await untilOnClock(clock, () => action.requests.length === 1);
    assert.match(action.requests[0]?.[1]?.content ?? "", /Objective \(asked by Steve\): "mine stone"/u);
  } finally {
    await stop();
  }
});

test("an order that arrives as the wait for the next goal call ends does not use up a call: the goal resumes at once after it", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, chat, planner, action } = agentFor(t, runtime, { goal: "live well", settings: { ...testPersona().settings, goalCallsPerMinute: 6 } }, { pollMs: 60_000 });
  planner.reply({ objective: "rest a while" });
  await until(() => planner.requests.length === 1);
  // The goal's first step now sleeps until its 10 s are over. The clock passes them, then the order wakes the sleeper:
  // time is up and an order is on top in the same reading, so the call is not granted and no new 10 s start.
  // (Not on the fake clock yet: its hold timer fires as the clock advances, so the goal would take its call first.)
  const clocks = steppedClocks(t);
  clocks.monotonic(10_000);
  chat.reply({ say: "On it.", route: "act", request: "mine stone" }, { say: "Done." });
  action.reply({ done: "nothing to mine" }, { done: "rested" });
  await agent.handle(say("Steve", "mine stone"));
  await until(() => action.requests.length === 2);
  assert.match(action.requests[1]?.[1]?.content ?? "", /Objective \(your own goal\): "rest a while"/u, "the goal's step came right after the order, not 10 s later");
});


// Work-loop records, abort precedence and recovery when a step ends in death.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { FakeRuntime, steppedClocks, testPersona, until } from "../testing.ts";
import { say, agentFor, steveAt, journaledAgent } from "./agent-fixtures.test.ts";

const COLLECT = { step: { skill: "collect_block", block: "oak_log", count: 16 } };

// Plan 2026-11-07-p4-02c T2: a death during a step ends it at once, recorded as interrupted (not a failure).
/** An agent whose bot has never died (`lastDeath: null`: a runtime that reports deaths), at one `COLLECT` step that runs until something stops it. */
function collectingBot(t: Parameters<typeof agentFor>[0], options: Parameters<typeof journaledAgent>[3] = {}, persona: Parameters<typeof journaledAgent>[2] = {}) {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, lastDeath: null };
  runtime.durations.collect_block = 100_000;
  const tiers = journaledAgent(t, runtime, persona, options);
  tiers.chat.reply({ say: "Okay!", route: "act", request: "collect 16 oak_log" }, { say: "Done." });
  const collecting = () => runtime.submitted.some((call) => call.tool === "collect_block");
  const outcomes = () => tiers.events.flatMap((event) => event.kind === "step" ? [`${event.outcome}: ${event.detail}`] : []);
  return { runtime, collecting, outcomes, ...tiers };
}

const DIED_AT_ORIGIN = "you died during this step at 0 64 0";

for (const tool of ["collect_block", "navigate"] as const) test(`a death during ${tool} is recorded interrupted after a delayed status answer`, async (t) => {
  const { runtime, agent, action, collecting, outcomes } = collectingBot(t);
  runtime.durations.navigate = 100_000;
  action.reply(tool === "collect_block" ? COLLECT : { step: { skill: "go_to", x: 100, y: 64, z: 0 } }, { done: "carry on" }, { give_up: "I died" });
  await agent.handle(say("Steve", "collect logs"));
  await until(tool === "collect_block" ? collecting : () => runtime.submitted.some((call) => call.tool === "navigate"));
  const held = runtime.holdNextStatus();
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  try {
    runtime.die("Zombie");
    await clock.settle(held.started, 2_000, 1);
    assert.deepEqual(outcomes(), []);
    clock.after(20, held.release);
    await clock.advance(19);
    assert.deepEqual(outcomes(), []);
    await clock.advance(1);
    assert.deepEqual(outcomes(), [`interrupted: ${DIED_AT_ORIGIN} (Zombie)`]);
    assert.match(action.requests[2]?.[1]?.content ?? "", /-> interrupted: you died during this step at 0 64 0 \(Zombie\)/u);
  } finally {
    held.release();
  }
});

test("a death status read that never answers releases the step record at the two-second wall", async (t) => {
  const { runtime, agent, action, collecting, outcomes } = collectingBot(t);
  action.reply(COLLECT, { give_up: "the status did not answer" });
  await agent.handle(say("Steve", "collect logs"));
  await until(collecting);
  const held = runtime.holdNextStatus();
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  try {
    runtime.die("Zombie");
    // The real network-yield timer can finish after clock installation (task review 2026-11-09).
    await clock.settle(held.started, 2_000, 1);
    assert.deepEqual(outcomes(), [], "the record waits for the death read");
    await clock.advance(1_000);
    assert.deepEqual(outcomes(), []);
    await clock.advance(1_000);
    assert.deepEqual(outcomes(), ["failed: cancelled by caller"], "an unanswered read cannot confirm a death");
    held.release();
    await clock.advance(0);
    assert.deepEqual(outcomes(), ["failed: cancelled by caller"], "a late answer cannot rewrite a finished step");
  } finally {
    held.release();
  }
});

test("a death between two actions ends the step at the next sample", async (t) => {
  const { runtime, agent, action, collecting, outcomes } = collectingBot(t, { noGain: { minutes: 5, sampleMs: 10 } });
  action.reply(COLLECT, { done: "carry on" }, { give_up: "I died" });
  await agent.handle(say("Steve", "collect logs"));
  await until(collecting);
  runtime.die(null, { cancelRunning: false });
  await until(() => outcomes().length === 1, 5_000);
  assert.deepEqual(outcomes(), [`interrupted: ${DIED_AT_ORIGIN}`], "no cause: no parentheses");
  assert.equal(runtime.cancelled.length, 1, "the brain cancelled the action that kept running");
});

test("a death is not a failure, and the same step runs again to its end from the respawn point (smallest failure limits)", async (t) => {
  const { runtime, agent, action, collecting, outcomes } = collectingBot(t, {}, { settings: { ...testPersona().settings, maxSameStepInARow: 1, maxSkillFailuresInARow: 1 } });
  action.reply(COLLECT, { done: "carry on" }, COLLECT, { done: "got the logs" });
  await agent.handle(say("Steve", "collect logs"));
  await until(collecting);
  runtime.die("Zombie");
  runtime.durations.collect_block = 0;
  runtime.snapshot = { ...runtime.snapshot, position: { x: 100, y: 70, z: 100 } };
  await until(() => outcomes().length === 2, 5_000);
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_block").length, 2, "the second try ran: it was not refused");
  assert.deepEqual(outcomes(), [`interrupted: ${DIED_AT_ORIGIN} (Zombie)`, "done: collected 16 oak_log"]);
  assert.doesNotMatch(action.requests[2]?.[1]?.content ?? "", /failed lately/u, "an interrupted step is not remembered as a failed one");
});

test("a death before the step starts (during the model call) does not fire, even at a sample while the step runs", async (t) => {
  // A baseline taken from the decision's snapshot (no death yet) would fire at the first 5 ms sample of the 150 ms step.
  const { runtime, agent, action, outcomes } = collectingBot(t, { noGain: { minutes: 5, sampleMs: 5 } });
  runtime.durations.collect_block = 150;
  // The death happens once the model has been asked for the step: the decision's own read still shows none.
  const status = runtime.status.bind(runtime);
  let dead = false;
  runtime.status = async () => {
    if (!dead && action.requests.length >= 1) {
      dead = true;
      runtime.die("Zombie", { cancelRunning: false });
    }
    return status();
  };
  action.reply(COLLECT, { done: "carry on" }, { done: "got the logs" });
  await agent.handle(say("Steve", "collect logs"));
  await until(() => outcomes().length === 1, 5_000);
  assert.ok(dead, "the death came during the step's own start");
  assert.deepEqual(outcomes(), ["done: collected 16 oak_log"]);
});

test("the first abort wins: a no-gain stop is not relabelled by a death that comes while it unwinds", async (t) => {
  const { runtime, agent, action, outcomes } = collectingBot(t, { noGain: { minutes: 0.002, sampleMs: 10 } });
  action.reply(COLLECT, { done: "carry on" }, { give_up: "stuck" });
  await agent.handle(say("Steve", "collect logs"));
  await until(() => runtime.cancelled.length === 1, 5_000);
  runtime.die("Zombie");
  await until(() => outcomes().length === 1, 5_000);
  assert.match(outcomes()[0] ?? "", /^failed: the action gave no sign of life for 0\.002 minutes/u);
});

test("the first abort wins: a death is not relabelled nothing-gained while the cancel is slow to settle", async (t) => {
  const clocks = steppedClocks(t);
  const { runtime, agent, action, collecting, outcomes } = collectingBot(t, { noGain: { minutes: 5, sampleMs: 10 } });
  const cancel = runtime.cancel.bind(runtime);
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let cancelSent = false;
  runtime.cancel = async (actionId) => {
    cancelSent = true;
    await released;
    return cancel(actionId);
  };
  action.reply(COLLECT, { done: "carry on" }, { give_up: "I died" });
  await agent.handle(say("Steve", "collect logs"));
  await until(collecting);
  runtime.die("Zombie", { cancelRunning: false });
  // The brain's cancel goes out once the death aborted the step; the 5-minute window then passes while it unwinds.
  await until(() => cancelSent);
  clocks.monotonic(6 * 60_000);
  release();
  await until(() => outcomes().length === 1, 5_000);
  assert.deepEqual(outcomes(), [`interrupted: ${DIED_AT_ORIGIN} (Zombie)`]);
});

test("a follow is cancelled by a death too", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, lastDeath: null, players: [steveAt(30)] };
  runtime.durations.navigate = 100_000;
  const { agent, events, chat, action } = journaledAgent(t, runtime);
  chat.reply({ say: "Coming.", route: "act", request: "follow me" }, { say: "Done." });
  action.reply({ step: { skill: "follow_player", player: "Steve", distance: 3 } }, { done: "carry on" }, { give_up: "I died" });
  await agent.handle(say("Steve", "Ayla, follow me"));
  await until(() => runtime.submitted.some((call) => call.tool === "navigate"));
  runtime.die("Zombie");
  await until(() => events.some((event) => event.kind === "step"), 5_000);
  const step = events.find((event) => event.kind === "step");
  assert.equal(step?.kind === "step" && `${step.outcome}: ${step.detail}`, `interrupted: ${DIED_AT_ORIGIN} (Zombie)`);
});

test("an order cancels as today: interrupted with the old detail, the death watch relabels nothing", async (t) => {
  const { runtime, agent, chat, action, collecting } = collectingBot(t);
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3)] };
  action.reply(COLLECT);
  await agent.handle(say("Steve", "collect logs"));
  await until(collecting);
  chat.reply({ say: "Coming!", route: "act", request: "come to Steve" }, { say: "Here I am." });
  action.reply({ step: { skill: "go_to_player", player: "Steve" } }, { done: "I am next to Steve" }, { done: "enough wood for now" });
  await agent.handle(say("Steve", "come here please"));
  await until(() => action.requests.length === 4, 5_000);
  assert.match(action.requests[3]?.[1]?.content ?? "", /1\. collect 16 oak_log -> interrupted: set aside for something more urgent, or stopped/u);
});

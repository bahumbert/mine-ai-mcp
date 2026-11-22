// Tests of step lifetimes, planned steps and objective stack ordering.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock, type FakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { Agent } from "../agent.ts";
import { INSTANT_TYPING } from "../body.ts";
import type { BrainEvent } from "../brain-log.ts";
import { FakeRuntime, scriptedMind, testPersona } from "../testing.ts";
import { say, others, clockUntil, clockedJournaledAgent } from "./agent-fixtures.test.ts";
import type { Step } from "../actions.ts";
import { newWork, type StepDecision, type Work } from "./work.ts";

/** The agent's objective stack (private): a test puts a Work it built on it, then reads what the loop does to that Work. */
function stackOf(agent: Agent): Work[] {
  return (agent as unknown as { stack: Work[] }).stack;
}

/** The recorded step outcomes, as `outcome: detail`. */
function stepOutcomes(events: BrainEvent[]): string[] {
  return events.flatMap((event) => event.kind === "step" ? [`${event.outcome}: ${event.detail}`] : []);
}

const GO_TO = { skill: "go_to", x: 100, y: 64, z: 0 } as const;

test("an idle respawn situation runs its planned step and is described as an event", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const runtime = new FakeRuntime();
  const { mind, action } = scriptedMind();
  const agent = new Agent({ persona: testPersona({ settings: { ...testPersona().settings, goalCallsPerMinute: 1 } }), runtime, mind, otherAgents: others(), log: () => undefined, typing: INSTANT_TYPING, pollMs: 5, obeyRandom: () => 0 });
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  try {
  const guards = (agent as unknown as { guards: { waitForGoalBudget(): Promise<boolean> } }).guards;
  assert.equal(await clock.settle(guards.waitForGoalBudget(), 10_000), true);
  const planned: StepDecision = { kind: "step", thought: "", step: GO_TO };
  const situation = { info: { kind: "respawn" as const, cause: "respawn", raisedAt: 0 }, order: null, told: false };
  stackOf(agent).push(newWork({ text: "respawn", requester: null, purpose: null }, null, situation, planned));
  assert.match(agent.activity, /an event/u);
  action.reply({ done: "finished" });
  running = agent.run(controller.signal);
  await clockUntil(clock, () => action.requests.length === 1);
  assert.equal(action.requests.length, 1);
  assert.equal(runtime.submitted.filter((call) => call.tool === "navigate").length, 1);
  } finally { controller.abort(); if (running !== undefined) await clock.settle(running, 10_000); }
});

for (const underlying of ["goal", "respawn"] as const) test(`nested situations protect ${underlying} materials from the junk hint`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, health: 7, clock: { timeOfDay: 12_100, phase: "day", minutesUntilChange: 442 / 1_200, sleeping: false }, inventory: [{ name: "oak_planks", count: 256 }, { name: "dirt", count: 128 }] };
  runtime.failures.collect_block = "[INVENTORY_FULL] no free inventory slot";
  const { agent, events, action, stop } = clockedJournaledAgent(clock, runtime);
  try {
    const state = (kind: "respawn" | "night" | "low_health") => ({ info: { kind, cause: kind, raisedAt: 0 }, order: null, told: false });
    const base = newWork({ text: "gather supplies", requester: null, purpose: null }, null, underlying === "respawn" ? state("respawn") : null);
    base.wanted.add("oak_planks");
    const planned: StepDecision = { kind: "step", thought: "", step: { skill: "collect_block", block: "stone", count: 5 } };
    const health = newWork({ text: "health", requester: null, purpose: null }, null, state("low_health"), planned);
    stackOf(agent).push(base, ...(underlying === "goal" ? [newWork({ text: "night", requester: null, purpose: null }, null, state("night"))] : []), health);
    action.reply({ done: "finished" });
    await clockUntil(clock, () => stepOutcomes(events).length > 0);
    const detail = stepOutcomes(events).join(" ");
    assert.match(detail, /128 dirt/u);
    assert.doesNotMatch(detail, /nothing you are doing needs[^;]*oak_planks/u);
  } finally { await stop(); }
});

for (const depth of [1, 2]) test(`later work queues below an order under ${depth} situation(s)`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const runtime = new FakeRuntime();
  const { mind, chat, action } = scriptedMind();
  const agent = new Agent({ persona: testPersona(), runtime, mind, otherAgents: others(), log: () => undefined, typing: INSTANT_TYPING, pollMs: 5, obeyRandom: () => 0 });
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  try {
  const own = newWork({ text: "own", requester: null, purpose: null });
  const order = newWork({ text: "first order", requester: "Steve", purpose: null });
  const event = () => newWork({ text: "event", requester: null, purpose: null }, null, { info: { kind: "night", cause: "night", raisedAt: 0 }, order, told: false });
  stackOf(agent).push(own, order, ...Array.from({ length: depth }, event));
  chat.reply({ say: "Later", route: "later", request: "second order" });
  await clock.settle(agent.handle(say("Bob", "second order")), 10_000);
  assert.deepEqual(stackOf(agent).map((work) => work.objective.text), ["own", "second order", "first order", ...Array(depth).fill("event")]);
  assert.match(chat.requests[0]?.[0]?.content ?? "", /"later" =/u);
  action.reply({ done: "first done" }, { done: "second done" });
  const internals = agent as unknown as { finish(work: Work, outcome: "done", detail: string): void; guards: { waitForGoalBudget(): Promise<boolean> } };
  assert.equal(await clock.settle(internals.guards.waitForGoalBudget(), 10_000), false);
  for (const work of [...stackOf(agent)].reverse()) if (work.situation !== null) internals.finish(work, "done", "ended");
  running = agent.run(controller.signal);
  await clockUntil(clock, () => action.requests.length >= 2);
  assert.match(JSON.stringify(action.requests[0]), /first order/u);
  assert.match(JSON.stringify(action.requests[1]), /second order/u);
  } finally { controller.abort(); if (running !== undefined) await clock.settle(running, 10_000); }
});

test("finishing a failed situation does not record an own-goal outcome", () => {
  const runtime = new FakeRuntime();
  const agent = new Agent({ persona: testPersona(), runtime, mind: scriptedMind().mind, otherAgents: others(), log: () => undefined, typing: INSTANT_TYPING, obeyRandom: () => 0 });
  const situation = newWork({ text: "event", requester: null, purpose: null }, null, { info: { kind: "night", cause: "night", raisedAt: 0 }, order: null, told: false });
  stackOf(agent).push(situation);
  const internals = agent as unknown as { finish(work: Work, outcome: "failed", detail: string): void; lastFailed: unknown; memory: { lately: unknown[] } };
  const previous = { objective: "earlier", reason: "failed" };
  internals.lastFailed = previous;
  internals.finish(situation, "failed", "event ended");
  assert.equal(internals.lastFailed, previous);
  assert.equal(internals.memory.lately.length, 0);
  assert.equal(runtime.notes.length, 0);
});

/** Start a long-running step with the requested runtime arrangement. */
function stepRun(clock: FakeClock, arrange: (runtime: FakeRuntime) => void = () => {}) {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, lastDeath: null };
  runtime.durations.navigate = 100_000;
  arrange(runtime);
  return { runtime, ...clockedJournaledAgent(clock, runtime) };
}

test("the running step is known while it runs and cleared after", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { runtime, agent, action, stop } = stepRun(clock);
  try {
  const work = newWork({ text: "walk to the hill", requester: null, purpose: null });
  stackOf(agent).push(work);
  action.reply({ step: GO_TO }, { give_up: "stopped" });
  await clockUntil(clock, () => runtime.submitted.some((call) => call.tool === "navigate"));
  assert.deepEqual(work.running?.step, GO_TO, "the step is known while it runs");
  work.step?.abort();
  await clockUntil(clock, () => action.requests.length === 2);
  assert.equal(work.running, null, "cleared once the step ended");
  assert.equal(work.step, null);
  } finally { await stop(); }
});

/**
 * The ways a step can end: each clears `running` and `step` and records its own outcome. `arrange` sets the fake
 * before the step starts; `afterStart` ends it while it runs (a death) and is empty for the other two.
 */
const ENDINGS: readonly { how: string; step: Step; arrange: (runtime: FakeRuntime) => void; afterStart: (clock: FakeClock, runtime: FakeRuntime) => Promise<void>; outcome: RegExp }[] = [
  { how: "a normal end", step: { skill: "collect_block", block: "dirt", count: 2 }, arrange: () => {}, afterStart: async () => {}, outcome: /^done: collected 2 dirt$/u },
  { how: "a thrown skill", step: GO_TO, arrange: (runtime) => { runtime.throwNext.navigate = "the link dropped"; }, afterStart: async () => {}, outcome: /^failed: .*the link dropped$/u },
  { how: "a death", step: GO_TO, arrange: () => {}, afterStart: async (clock, runtime) => {
    await clockUntil(clock, () => runtime.submitted.some((call) => call.tool === "navigate"));
    runtime.die("Zombie");
  }, outcome: /^interrupted: you died during this step .*\(Zombie\)$/u },
];

for (const ending of ENDINGS) test(`a step cleared after ${ending.how}, recorded as its outcome`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { runtime, agent, action, events, stop } = stepRun(clock, ending.arrange);
  try {
  const work = newWork({ text: "one step", requester: null, purpose: null });
  stackOf(agent).push(work);
  action.reply({ step: ending.step }, ...(ending.how === "a death" ? [{ done: "carry on" }] : []), { give_up: "the step is over" });
  await ending.afterStart(clock, runtime);
  await clockUntil(clock, () => action.requests.length === (ending.how === "a death" ? 3 : 2));
  assert.equal(work.running, null);
  assert.equal(work.step, null);
  assert.match(stepOutcomes(events)[0] ?? "", ending.outcome);
  } finally { await stop(); }
});

test("a replaced step is not cleared by the old step's finally: neither its controller nor its running record", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { runtime, agent, action, stop } = stepRun(clock);
  try {
  const work = newWork({ text: "walk to the hill", requester: null, purpose: null });
  stackOf(agent).push(work);
  action.reply({ step: GO_TO }, { give_up: "stopped" });
  await clockUntil(clock, () => runtime.submitted.some((call) => call.tool === "navigate"));
  const old = work.step;
  // A newer step replaces both records while the old one unwinds (an order's take starts it on the same work).
  const newerController = new AbortController();
  const newer = { step: { skill: "collect_block", block: "dirt", count: 2 } as const, controller: newerController };
  work.step = newerController;
  work.running = newer;
  old?.abort();
  await clockUntil(clock, () => action.requests.length === 2);
  assert.equal(work.step, newerController, "the old step's finally left the newer controller alone");
  assert.equal(work.running, newer, "the old step's finally left the newer record alone");
  } finally { await stop(); }
});

test("a planned step runs without a model call and counts as one step", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runtime = new FakeRuntime();
  const { agent, action, events, stop } = clockedJournaledAgent(clock, runtime);
  try {
  const planned: StepDecision = { kind: "step", thought: "", step: { skill: "collect_block", block: "dirt", count: 2 } };
  stackOf(agent).push(newWork({ text: "collect 2 dirt", requester: null, purpose: null }, null, null, planned));
  action.reply({ done: "collected 2 dirt" });
  await clockUntil(clock, () => action.requests.length === 1);
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_block").length, 1, "the planned step ran");
  assert.equal(events.filter((event) => event.kind === "step").length, 1, "the planned step is one recorded step");
  assert.match(action.requests[0]?.[1]?.content ?? "", /1\. collect 2 dirt -> done: collected 2 dirt/u, "the next decision sees the planned step");
  } finally { await stop(); }
});

test("a planned step waiting under another objective runs once that objective ends, with no model call for it", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, lastDeath: null };
  const { agent, action, events, stop } = clockedJournaledAgent(clock, runtime);
  try {
  const planned: StepDecision = { kind: "step", thought: "", step: { skill: "collect_block", block: "dirt", count: 2 } };
  // Pushed bottom first: the top objective is worked, the planned one waits below it (set aside, not run).
  stackOf(agent).push(newWork({ text: "collect 2 dirt", requester: null, purpose: null }, null, null, planned), newWork({ text: "rest for a while", requester: null, purpose: null }));
  action.reply({ done: "rested" }, { done: "collected 2 dirt" });
  await clockUntil(clock, () => action.requests.length === 2);
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_block").length, 1, "the waiting planned step ran once");
  assert.deepEqual(stepOutcomes(events), ["done: collected 2 dirt"]);
  assert.match(action.requests[1]?.[1]?.content ?? "", /1\. collect 2 dirt -> done: collected 2 dirt/u, "the decision after the planned step sees it");
  } finally { await stop(); }
});

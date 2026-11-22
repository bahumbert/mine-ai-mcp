// Tests of the body-down state: a body the supervisor keeps down shows in the journal, is not a failed step, and comes back at a known time.
import assert from "node:assert/strict";
import test from "node:test";
import type { BrainEvent } from "../brain-log.ts";
import { BodyDown } from "../runtime-client.ts";
import { FakeRuntime, until } from "../testing.ts";
import { agentFor, bodyDownAt, failStatusReads, journaledAgent, others, say, talkOptions } from "./agent-fixtures.test.ts";

const DIRT = { step: { skill: "collect_block", block: "dirt", count: 2 } };

/** The states the monitor was shown, in order (`null` = nothing running). */
function shownSteps(events: readonly BrainEvent[]): (string | null)[] {
  return events.flatMap((event) => event.kind === "state" ? [event.step] : []);
}

test("a body that is down shows when it comes back and the state clears once a call goes through", async (t) => {
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  const at = new Date(Date.now() + 30_000).toISOString();
  const down = () => new BodyDown({ at, attempt: 2, of: 6 }, new Error("[RUNTIME_UNRESPONSIVE] Runtime event-loop heartbeat absent"));
  failStatusReads(runtime, logs, [down(), down()]);
  const { events, planner, action } = journaledAgent(t, runtime, { goal: "gather dirt" }, { log: (line) => logs.push(line) });
  planner.reply({ objective: "collect 2 dirt" });
  action.reply(DIRT, { done: "collected 2 dirt" });
  await until(() => events.some((event) => event.kind === "objective" && event.event === "finished"));
  const shown = shownSteps(events);
  const downText = `my body is down; it starts again at ${at.slice(11, 16)}Z (try 2 of 6)`;
  const from = shown.indexOf(downText);
  assert.ok(from >= 0, "the monitor was shown when the body comes back");
  const cleared = shown.indexOf(null, from);
  assert.ok(cleared > from, "the state clears once a call goes through");
  assert.ok(shown.slice(from, cleared).every((step) => step === downText), "and stays until then");
});

test("a body down met inside a step is not a failed step", async (t) => {
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  const submit = runtime.submit.bind(runtime);
  let thrown = false;
  runtime.submit = async (tool, input) => {
    if (tool === "collect_block" && !thrown) {
      thrown = true;
      throw bodyDownAt(30_000);
    }
    return submit(tool, input);
  };
  const { events, planner, action } = journaledAgent(t, runtime, { goal: "gather dirt" }, { log: (line) => logs.push(line) });
  planner.reply({ objective: "collect 2 dirt" });
  action.reply(DIRT, DIRT, { done: "collected 2 dirt" });
  await until(() => events.some((event) => event.kind === "objective" && event.event === "finished"));
  assert.deepEqual(events.filter((event) => event.kind === "step" && event.outcome === "failed"), [], "no failed step is recorded");
  assert.ok(shownSteps(events).some((step) => step?.startsWith("my body is down; it starts again at")), "the monitor was shown the body down");
  assert.doesNotMatch(JSON.stringify(action.requests[1]), /RUNTIME_UNRESPONSIVE/u, "the model is not told its step failed");
});

test("a body down met by a dig_shelter step is not a failed step", async (t) => {
  const runtime = new FakeRuntime();
  const submit = runtime.submit.bind(runtime);
  let thrown = false;
  runtime.submit = async (tool, input) => {
    if (tool === "raw_action" && !thrown) {
      thrown = true;
      throw bodyDownAt(30_000);
    }
    return submit(tool, input);
  };
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0, y: 64, z: 0 }, inventory: [{ name: "dirt", count: 4 }], clock: { phase: "night", minutesUntilChange: 5 } };
  runtime.succeedEffects.navigate = (input) => { runtime.snapshot = { ...runtime.snapshot, position: { x: Number(input.x), y: Number(input.y), z: Number(input.z) } }; };
  const { events, agent, chat, action } = journaledAgent(t, runtime);
  chat.reply({ say: "Okay!", route: "act", request: "dig in for the night" }, { say: "Done." });
  action.reply({ step: { skill: "dig_shelter" } }, { done: "dug in" });
  await agent.handle(say("Steve", "Ayla, dig in for the night"));
  await until(() => thrown);
  await until(() => shownSteps(events).some((step) => step?.startsWith("my body is down; it starts again at")));
  assert.deepEqual(events.filter((event) => event.kind === "step" && event.outcome === "failed"), [], "no failed step is recorded");
});

test("a 503 while the body starts leaves the body-down state", async (t) => {
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  const events: BrainEvent[] = [];
  let shownBeforeThirdRead: (string | null)[] = [];
  const reads = failStatusReads(runtime, logs, [bodyDownAt(30_000), new Error("Streamable HTTP error: Error POSTing to endpoint: 503")], (call) => {
    if (call === 3) shownBeforeThirdRead = shownSteps(events);
  });
  const { planner, action } = journaledAgent(t, runtime, { goal: "gather dirt" }, { log: (line) => logs.push(line), journal: (event) => events.push(event) });
  planner.reply({ objective: "collect 2 dirt" });
  action.reply(DIRT, { done: "collected 2 dirt" });
  await until(() => reads.calls >= 3);
  const downAt = shownBeforeThirdRead.findIndex((step) => step?.startsWith("my body is down; it starts again at"));
  assert.ok(downAt >= 0, "the body-down state was shown");
  assert.ok(shownBeforeThirdRead.slice(downAt).every((step) => step !== null), "the 503 that followed did not clear it");
});

test("a body that restarted under a call clears the body-down state, whatever error follows", async (t) => {
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  const events: BrainEvent[] = [];
  let shownAtThirdRead: (string | null)[] = [];
  failStatusReads(runtime, logs, [bodyDownAt(30_000), new Error("[BODY_RESTARTED] the body restarted: view_status was not done"), new Error("Streamable HTTP error: Error POSTing to endpoint: 503")], (call) => {
    if (call === 3) shownAtThirdRead = shownSteps(events);
  });
  const { planner, action } = journaledAgent(t, runtime, { goal: "gather dirt" }, { log: (line) => logs.push(line), journal: (event) => events.push(event) });
  planner.reply({ objective: "collect 2 dirt" });
  action.reply(DIRT, { done: "collected 2 dirt" });
  await until(() => shownAtThirdRead.length > 0);
  const downAt = shownAtThirdRead.findIndex((step) => step?.startsWith("my body is down; it starts again at"));
  assert.ok(downAt >= 0 && shownAtThirdRead.indexOf(null, downAt) > downAt, "the restarted body is no longer shown as down");
});

test("a body down met by a conversation routine is not a failed conversation", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Vex", position: { x: 30, y: 64, z: 0 } }] };
  const submit = runtime.submit.bind(runtime);
  let thrown = false;
  runtime.submit = async (tool, input) => {
    if (tool === "navigate" && !thrown) {
      thrown = true;
      throw bodyDownAt(30_000);
    }
    return submit(tool, input);
  };
  const events: BrainEvent[] = [];
  const { planner, chat } = agentFor(t, runtime, { goal: "Live well and be friendly." }, talkOptions({ journal: (event) => events.push(event), otherAgents: others("Vex") }));
  planner.reply({ objective: "go and chat with Vex", for: "socialising" });
  chat.reply({ open: true, to: ["Vex"], topic: "the village", length: "long", say: "Vex! Walk with me?" });
  await until(() => thrown);
  await until(() => shownSteps(events).some((step) => step?.startsWith("my body is down; it starts again at")));
  assert.deepEqual(events.filter((event) => event.kind === "step" && event.outcome === "failed"), [], "no failed step is recorded");
});

test("a body that comes back at a known time is asked again within a poll of it", async (t) => {
  // The waits the agent asks for are read on a simulated wall clock that moves by exactly each wait: no real time passes,
  // so neither load nor a step of the host's wall clock (WSL's, about 2 s every 30 s) can move the answer (2026-11-12:
  // the version that timed the sixth read in real time against a 2.5 s bound failed once at 2610 ms).
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  let wall = Date.now();
  t.mock.method(Date, "now", () => wall);
  const at = new Date(wall + 2_000).toISOString();
  const errors = Array.from({ length: 5 }, () => new BodyDown({ at, attempt: 2, of: 6 }, new Error("[RUNTIME_UNRESPONSIVE] Runtime event-loop heartbeat absent")));
  const reads = failStatusReads(runtime, logs, errors);
  const waits: number[] = [];
  const { agent } = journaledAgent(t, runtime, { goal: "gather dirt" }, { log: (line) => logs.push(line), pollMs: 100 });
  const idle = agent as unknown as { idle(ms: number): Promise<void> };
  const waitFor = idle.idle.bind(agent);
  t.mock.method(idle, "idle", (ms: number) => {
    // After the sixth read the loop's own errors (no scripted planner reply) wait as the agent asks, so it does not spin.
    if (reads.calls < 1 || reads.calls >= 6) return waitFor(ms);
    // The goal tier's own pacing waits are not the error back-off this test measures.
    if ((new Error().stack ?? "").includes("waitForGoalBudget")) return waitFor(0);
    waits.push(ms);
    wall += ms;
    return waitFor(0);
  });
  await until(() => reads.calls >= 6, 4_000);
  // Without the cap the five failures wait 100, 200, 400, 800 and 1600 ms; the cap cuts the fifth to the 500 ms left.
  assert.deepEqual(waits, [100, 200, 400, 800, 500]);
});

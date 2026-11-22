// Tests of the night shelter and what a stopped agent does while it waits.
import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../agent.ts";
import { INSTANT_TYPING } from "../body.ts";
import { FakeRuntime, scriptedMind, testPersona, until } from "../testing.ts";
import { journaledAgent, others, say } from "./agent-fixtures.test.ts";
import { createFakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";

test("an agent stopped while an ordered dig_shelter waits ends its run within a bound", async (t) => {
  // The night shelter waits for the day in slices of 15 s: the agent's run signal must reach that wait (the shelter's
  // signal is built from it), or a stopped agent hangs until the day comes.
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, clock: { phase: "night", minutesUntilChange: 5 }, inventory: [{ name: "dirt", count: 4 }] };
  const moveTo = (x: number, y: number, z: number) => { runtime.snapshot = { ...runtime.snapshot, position: { x, y, z } }; };
  runtime.succeedEffects.raw_action = (input) => {
    if (input.operation === "dig") moveTo(0, Math.min(runtime.snapshot.position.y, Number(input.y)), 0);
  };
  runtime.succeedEffects.navigate = (input) => moveTo(Number(input.x), Number(input.y), Number(input.z));
  const tiers = scriptedMind();
  tiers.chat.reply({ say: "Okay!", route: "act", request: "dig in" });
  tiers.action.reply({ step: { skill: "dig_shelter" } });
  const agent = new Agent({ persona: testPersona(), runtime, mind: tiers.mind, otherAgents: others("Vex"), log: () => undefined, typing: INSTANT_TYPING, pollMs: 5, obeyRandom: () => 0 });
  const controller = new AbortController();
  const running = agent.run(controller.signal);
  t.after(async () => { controller.abort(); await running; });
  await agent.handle(say("Steve", "dig in"));
  await until(() => runtime.submitted.some((call) => call.tool === "raw_action" && call.input.operation === "place"));
  await until(() => runtime.submitted.some((call) => call.tool === "note_save" && String(call.input.context).startsWith("brain memory: shelter ")));
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  controller.abort();
  await clock.settle(running, 100, 20);
});

test("an idle work-loop turn at night never digs a shelter by itself", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, clock: { phase: "night", minutesUntilChange: 5 } };
  const { planner } = journaledAgent(t, runtime, { goal: "build a base" });
  planner.reply({ objective: "think about my base" });
  await until(() => planner.requests.length > 0);
  assert.equal(runtime.submitted.some((call) => call.tool === "raw_action" && call.input.operation === "dig"), false);
});

test("a model-called dig_shelter with a death mid-wait ends interrupted", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, lastDeath: null, clock: { phase: "night", minutesUntilChange: 5 }, inventory: [{ name: "dirt", count: 4 }] };
  // The shaft fall mirrors shelter/dig-in-and-climb-out; death reporting uses FakeRuntime.die's measured contract.
  runtime.succeedEffects.raw_action = (input) => {
    if (input.operation === "dig") runtime.snapshot = { ...runtime.snapshot, position: { x: 0, y: Number(input.y), z: 0 } };
  };
  const { agent, chat, action, events } = journaledAgent(t, runtime, {}, { noGain: { minutes: 5, sampleMs: 10 } });
  chat.reply({ say: "Okay!", route: "act", request: "dig in" }, { say: "I died." });
  action.reply({ step: { skill: "dig_shelter" } }, { give_up: "I died" });
  await agent.handle(say("Steve", "dig in"));
  await until(() => runtime.submitted.some((call) => call.tool === "raw_action" && call.input.operation === "place"));
  await until(() => runtime.submitted.some((call) => call.tool === "note_save" && String(call.input.context).startsWith("brain memory: shelter ")));
  runtime.die("Zombie", { cancelRunning: false });
  await until(() => events.some((event) => event.kind === "step"));
  const step = events.find((event) => event.kind === "step");
  assert.ok(step?.kind === "step");
  assert.equal(step.outcome, "interrupted");
  assert.equal(step.detail, "you died during this step at 0 61 0 (Zombie)");
});

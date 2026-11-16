// House claims through the step runner's persona-bound model callback.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { Body, INSTANT_TYPING } from "../body.ts";
import { TillFacts } from "../farming/site.ts";
import { FakeRuntime, scriptedMind, SMALL_MEDIEVAL_HOUSE, testPersona } from "../testing.ts";
import { AgentMemory } from "./agent-memory.ts";
import { FailedSteps } from "./failed-steps.ts";
import { GameFacts } from "./game-facts.ts";
import { StepRunner } from "./step-runner.ts";
import { newWork } from "./work.ts";

for (const throws of [false, true]) test(`a house claim uses the persona's sign model${throws ? "; its failure keeps the owner line" : ""}`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: [...SMALL_MEDIEVAL_HOUSE, { name: "oak_sign", count: 1 }] };
  runtime.blockTags = { ...runtime.blockTags, air: ["air", "replaceable"] };
  // Script the later server read: FakeRuntime's synthetic place_sign result does not update its text (T12).
  runtime.succeedEffects.place_sign = (input) => {
    runtime.signs = [{ position: { x: Number(input.x), y: Number(input.y), z: Number(input.z) }, block: "oak_sign", known: true,
      front: ["Ayla", "", "", ""], back: ["", "", "", ""] }];
  };
  runtime.blockTags = { ...runtime.blockTags, oak_sign: ["standing_signs"] };
  const persona = testPersona();
  const mind = scriptedMind().mind;
  let calls = 0;
  mind.signLines = async (input, signal) => {
    assert.equal(input.persona, persona);
    assert.equal(input.occasion, "claim");
    assert.equal(input.owner, "Ayla");
    assert.equal(signal.aborted, false);
    calls += 1;
    if (throws) throw new Error("model unavailable");
    return ["Welcome home"];
  };
  const options = { runtime, persona, mind, otherAgents: { names: () => [] }, log: () => {} };
  const body = new Body(runtime, () => {}, INSTANT_TYPING);
  const memory = new AgentMemory(options, body);
  const runner = new StepRunner({ options, body, memory, facts: new GameFacts(runtime, options.log), failedSteps: new FailedSteps(), soil: new TillFacts(), lastHeard: new Map(), progress: () => {}, journalState: () => {}, runSignal: () => new AbortController().signal });
  const work = newWork({ text: "build a house", requester: null, purpose: "building" });
  const run = await clock.settle(runner.runChosenStep(work, { kind: "step", thought: "", step: { skill: "build", structure: "house", size: "small" } }, await runtime.status()), 1_000);
  assert.equal(run.result.status, "done");
  assert.equal(calls, 1);
  assert.deepEqual(runtime.submitted.find(({ tool }) => tool === "place_sign")?.input.lines, throws ? ["Ayla"] : ["Ayla", "Welcome home"]);
  assert.equal(work.step, null);
  assert.equal(body.onAction, null);
});

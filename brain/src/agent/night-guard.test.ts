// Tests of the night shelter and what a stopped agent does while it waits.
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "../agent.ts";
import { INSTANT_TYPING } from "../body.ts";
import { FakeRuntime, scriptedMind, testPersona, until } from "../testing.ts";
import { others } from "./agent-fixtures.test.ts";

test("an agent stopped while it shelters for the night ends its run within a bound", async () => {
  // The night shelter waits for the day in slices of 15 s: the agent's run signal must reach that wait (the shelter's
  // signal is built from it), or a stopped agent hangs until the day comes.
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, clock: { phase: "night", minutesUntilChange: 5 }, inventory: [{ name: "dirt", count: 4 }] };
  const moveTo = (x: number, y: number, z: number) => { runtime.snapshot = { ...runtime.snapshot, position: { x, y, z } }; };
  runtime.succeedEffects.raw_action = (input) => {
    if (input.operation === "dig") moveTo(0, Math.min(runtime.snapshot.position.y, Number(input.y)), 0);
  };
  runtime.succeedEffects.navigate = (input) => moveTo(Number(input.x), Number(input.y), Number(input.z));
  const agent = new Agent({ persona: testPersona(), runtime, mind: scriptedMind().mind, otherAgents: others("Vex"), log: () => undefined, typing: INSTANT_TYPING, pollMs: 5 });
  const controller = new AbortController();
  const running = agent.run(controller.signal);
  await until(() => runtime.submitted.some((call) => call.tool === "raw_action" && call.input.operation === "place"));
  await sleep(50);
  const stoppedAt = performance.now();
  controller.abort();
  await running;
  assert.ok(performance.now() - stoppedAt < 2_000, `run took ${Math.round(performance.now() - stoppedAt)} ms to end after the abort`);
});

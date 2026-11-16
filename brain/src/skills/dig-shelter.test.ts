// The model's shelter contract and the context passed to the existing shelter flow.
import assert from "node:assert/strict";
import test from "node:test";
import { describeStep, skillUsage, stepSchema } from "../actions.ts";
import { Body, INSTANT_TYPING } from "../body.ts";
import { styleOrDefault } from "../building/plan.ts";
import type { ShelterHole } from "../shelter/dig-in.ts";
import { runStep } from "../skills.ts";
import { FakeRuntime } from "../testing.ts";

test("dig_shelter accepts optional whole minutes from 1 to 15 and describes both forms", () => {
  for (const minutes of [undefined, 1, 5, 15]) {
    const input = { skill: "dig_shelter", ...(minutes !== undefined && { minutes }) };
    const step = stepSchema.parse(input);
    assert.deepEqual(step, input);
    assert.equal(describeStep(step), minutes === undefined ? "dig in and wait for the day" : `dig in for ${minutes} min`);
  }
  for (const minutes of [0, 16, 1.5]) assert.equal(stepSchema.safeParse({ skill: "dig_shelter", minutes }).success, false);
  assert.equal(skillUsage("dig_shelter", styleOrDefault(undefined)), '{"skill":"dig_shelter"}  dig a closed hole near you (about 20 s; not with a monster on you), roof it with a carried block and wait inside until day, then climb out; add "minutes":<1-15> only to come out sooner, or to hide by day');
});

test("the sleep line names the carried bed and the respawn point", () => {
  assert.equal(skillUsage("sleep", styleOrDefault(undefined)), '{"skill":"sleep"}  sleep in a bed, which also makes it your respawn point: a free bed nearby, else the one you carry, placed on flat ground nearby and left there (sleeping at night or in a thunderstorm only; by day it only sets the respawn point)');
  assert.equal(stepSchema.safeParse({ skill: "sleep" }).success, true);
});

test("runStep by day without shelter minutes is done without submitting anything", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, clock: { phase: "day", minutesUntilChange: 5 } };
  const result = await runStep({ skill: "dig_shelter" }, {
    runtime, body: new Body(runtime, () => undefined, INSTANT_TYPING), signal: new AbortController().signal,
  });
  assert.equal(result.status, "done");
  assert.match(result.detail, /give minutes/u);
  assert.deepEqual(runtime.submitted, []);
});

test("daytime shelter minutes dig and remember a roof that spares the objective's needed dirt", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, clock: { phase: "day", minutesUntilChange: 5 }, inventory: [{ name: "dirt", count: 64 }, { name: "cobblestone", count: 4 }] };
  // Falling into a dug shaft is measured by shelter/dig-in-and-climb-out; use the shared runtime's effects.
  runtime.succeedEffects.raw_action = (input) => {
    if (input.operation === "dig") runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: Number(input.y), z: 0.5 } };
  };
  const controller = new AbortController();
  const holes: ShelterHole[] = [];
  const result = await runStep({ skill: "dig_shelter", minutes: 1 }, {
    runtime, body: new Body(runtime, () => undefined, INSTANT_TYPING), signal: controller.signal,
    needed: () => new Set(["dirt"]),
    rememberShelter: (hole) => { holes.push(hole); controller.abort(); },
  });
  assert.equal(result.status, "stopped");
  assert.deepEqual(holes, [{ x: 0, y: 64, z: 0, depth: 3, roofed: true }]);
  assert.equal(runtime.submitted.find((call) => call.tool === "raw_action" && call.input.operation === "place")?.input.block_name, "cobblestone");
});

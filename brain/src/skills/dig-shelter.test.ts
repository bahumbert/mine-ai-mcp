// The model's shelter contract and the context passed to the existing shelter flow.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { dayPhase, ticksToMinutes, ticksUntilDay, ticksUntilNight } from "../../../src/world/daylight.ts";
import { describeStep, skillUsage, stepSchema } from "../actions.ts";
import { Body, INSTANT_TYPING } from "../body.ts";
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
  assert.equal(skillUsage("dig_shelter", "europe"), '{"skill":"dig_shelter"}  dig a closed hole near you (about 20 s; not with a monster on you), roof it with a carried block and wait inside until day, then climb out; add "minutes":<1-15> only to come out sooner, or to hide by day');
});

test("the sleep line names the carried bed and the respawn point", () => {
  assert.equal(skillUsage("sleep", "europe"), '{"skill":"sleep"}  sleep in a bed, which also makes it your respawn point: a free bed nearby, else the one you carry, placed on flat ground nearby and left there (sleeping at night or in a thunderstorm only; by day it only sets the respawn point)');
  assert.equal(stepSchema.safeParse({ skill: "sleep" }).success, true);
});

test("a dig begun by day without minutes still does nothing; older statuses and the Nether at 12200 keep that behaviour", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const setups: readonly ((runtime: FakeRuntime) => void)[] = [
    (runtime) => setShelterTime(runtime, 6_000),
    (runtime) => setShelterTime(runtime, 11_999),
    (runtime) => setShelterTime(runtime, 23_459),
    (runtime) => { runtime.snapshot = { ...runtime.snapshot, clock: { phase: "day", minutesUntilChange: 5 } }; },
    // Off the overworld the runtime sends no phase (view-status.ts:75), so 12200 is not an evening there (2026-11-16, F19).
    (runtime) => { runtime.snapshot = { ...runtime.snapshot, clock: { phase: null, timeOfDay: 12_200, minutesUntilChange: null } }; },
  ];
  for (const setup of setups) {
    const runtime = new FakeRuntime();
    setup(runtime);
    const result = await clock.settle(runStep({ skill: "dig_shelter" }, {
      runtime, body: new Body(runtime, () => undefined, INSTANT_TYPING), signal: new AbortController().signal,
    }), 15_000);
    assert.equal(result.status, "done");
    assert.match(result.detail, /give minutes/u);
    assert.deepEqual(runtime.submitted, []);
  }
});

/** The same clock fields view_status derives through world/daylight.ts. */
function setShelterTime(runtime: FakeRuntime, timeOfDay: number): void {
  const phase = dayPhase(timeOfDay);
  const minutesUntilChange = ticksToMinutes(phase === "night" ? ticksUntilDay(timeOfDay) : ticksUntilNight(timeOfDay));
  runtime.snapshot = { ...runtime.snapshot, clock: { phase, timeOfDay, minutesUntilChange } };
}

/** Reuse the runtime's world; shelter/dig-in-and-climb-out measured the range-1 exit at y=63. */
function shelterRuntime(timeOfDay: number): FakeRuntime {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: [{ name: "dirt", count: 4 }] };
  setShelterTime(runtime, timeOfDay);
  runtime.succeedEffects.raw_action = (input) => {
    if (input.operation === "place") runtime.world.set("0,63,0", String(input.block_name));
    if (input.operation !== "dig") return;
    runtime.world.set(`${String(input.x)},${String(input.y)},${String(input.z)}`, "air");
    if (Number(input.y) < runtime.snapshot.position.y) runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: Number(input.y), z: 0.5 } };
  };
  runtime.succeedEffects.navigate = (input) => {
    runtime.snapshot = { ...runtime.snapshot, position: { x: Number(input.x) + 0.5, y: Number(input.y) - (input.range === 1 ? 1 : 0), z: Number(input.z) + 0.5 } };
  };
  return runtime;
}

for (const row of [
  { name: "a dig begun at 12100 waits until day and climbs out", start: 12_100, end: 23_459 },
  { name: "a sleep skip ends that shelter", start: 12_300, end: 0 },
  { name: "shelter waits at the evening and bedtime boundaries", start: 12_000, end: 23_459 },
  { name: "shelter waits through the final evening tick", start: 12_541, end: 23_459 },
  { name: "shelter still waits from the first night tick", start: 12_542, end: 23_459 },
]) {
  test(row.name, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const runtime = shelterRuntime(row.start);
    const body = new Body(runtime, () => undefined, INSTANT_TYPING);
    let finished = false;
    const running = runStep({ skill: "dig_shelter" }, { runtime, body, signal: new AbortController().signal }).then((result) => { finished = true; return result; });
    await clock.advance(0);
    assert.equal(runtime.snapshot.position.y, 61, "the evening call digs down into shelter");
    assert.equal(finished, false);
    setShelterTime(runtime, 13_000);
    await clock.advance(15_000);
    assert.equal(finished, false, "night does not end the shelter");
    assert.equal(runtime.snapshot.position.y, 61);
    setShelterTime(runtime, 23_458);
    await clock.advance(15_000);
    assert.equal(finished, false, "the last night tick still shelters");
    setShelterTime(runtime, row.end);
    const result = await clock.settle(running, 15_000);
    assert.equal(result.status, "done");
    assert.match(result.detail, /climbed out/u);
    assert.equal(runtime.snapshot.position.y, 63);
    const next = await body.act("navigate", { x: 2, y: 64, z: 0, range: 0 }, "the next order after shelter");
    assert.equal(next.status, "succeeded");
    assert.equal(runtime.snapshot.position.x, 2.5);
    assert.equal(runtime.snapshot.position.y, 64);
  });
}

test("a dig begun by day at 6000 with minutes ends at its deadline", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runtime = shelterRuntime(6_000);
  let finished = false;
  const running = runStep({ skill: "dig_shelter", minutes: 1 }, {
    runtime, body: new Body(runtime, () => undefined, INSTANT_TYPING), signal: new AbortController().signal,
  }).then((result) => { finished = true; return result; });
  await clock.advance(0);
  assert.equal(runtime.snapshot.position.y, 61);
  await clock.advance(59_999, 15_000);
  assert.equal(finished, false, "daytime minutes do not end before their deadline");
  const result = await clock.settle(running, 1, 1);
  assert.equal(result.status, "done");
  assert.match(result.detail, /climbed out/u);
  assert.equal(runtime.snapshot.position.y, 63);
});

test("an older status without timeOfDay keeps sheltering at night", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runtime = shelterRuntime(13_000);
  runtime.snapshot = { ...runtime.snapshot, clock: { phase: "night", minutesUntilChange: 5 } };
  const running = runStep({ skill: "dig_shelter" }, {
    runtime, body: new Body(runtime, () => undefined, INSTANT_TYPING), signal: new AbortController().signal,
  });
  await clock.advance(0);
  assert.equal(runtime.snapshot.position.y, 61);
  runtime.snapshot = { ...runtime.snapshot, clock: { phase: "day", minutesUntilChange: 5 } };
  assert.equal((await clock.settle(running, 15_000)).status, "done");
  assert.equal(runtime.snapshot.position.y, 63);
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

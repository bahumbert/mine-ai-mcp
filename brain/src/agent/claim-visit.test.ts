// Claim visits keep the step's lifetime and consume each arrival even when the claim fails.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { Body, INSTANT_TYPING } from "../body.ts";
import { TillFacts } from "../farming/site.ts";
import type { KnownPlace } from "../mind.ts";
import type { SignReading } from "../runtime-client.ts";
import { FakeRuntime, scriptedMind, testPersona } from "../testing.ts";
import { AgentMemory } from "./agent-memory.ts";
import { FailedSteps } from "./failed-steps.ts";
import { GameFacts } from "./game-facts.ts";
import { StepRunner } from "./step-runner.ts";
import { newWork } from "./work.ts";

const DOOR = { x: 0, y: 64, z: 0 };
const CLAIM = { position: { x: 1, y: 64, z: -1 }, facing: "north", attach: "ground", placed: true } as const;
const HOME: KnownPlace = { name: "home", detail: "my house", own: true, house: { size: "small", style: "medieval", door: DOOR, facing: "north", materials: {}, owner: "Ayla", dimension: "overworld", claim: CLAIM } };
const WALK = { kind: "step", thought: "", step: { skill: "go_to", ...DOOR } } as const;

/** Script the read separately: FakeRuntime's place_sign success does not supply a server text observation. */
function sign(front: SignReading["front"] = ["Ayla", "Welcome", "", ""], known = true): SignReading {
  return { position: CLAIM.position, block: "oak_sign", front, back: ["", "", "", ""], known };
}

/** The real runner, body and memory over the shared brain runtime; every explicit runtime read is counted. */
function fixture() {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, lastDeath: null, inventory: [{ name: "oak_sign", count: 1 }] };
  runtime.blockTags = { ...runtime.blockTags, air: ["air", "replaceable"], oak_sign: ["standing_signs"] };
  runtime.signs = [sign()];
  const calls = { status: 0, readSigns: 0, cellsAt: 0, blockKinds: 0, itemFamily: 0, craftingNeeds: 0 };
  for (const method of Object.keys(calls) as (keyof typeof calls)[]) {
    const original = runtime[method].bind(runtime) as (...args: never[]) => Promise<unknown>;
    Object.assign(runtime, { [method]: (...args: never[]) => { calls[method] += 1; return original(...args); } });
  }
  const mind = scriptedMind().mind;
  const logs: string[] = [];
  const options = { runtime, persona: testPersona(), mind, otherAgents: { names: () => [] }, log: (line: string) => logs.push(line) };
  const body = new Body(runtime, options.log, INSTANT_TYPING);
  const memory = new AgentMemory(options, body);
  memory.places.push(HOME);
  const runner = new StepRunner({ options, body, memory, facts: new GameFacts(runtime, options.log), failedSteps: new FailedSteps(), soil: new TillFacts(), lastHeard: new Map(), progress: () => {}, journalState: () => {}, runSignal: () => new AbortController().signal });
  const work = newWork({ text: "walk home", requester: null, purpose: "travelling" });
  const run = () => runner.runChosenStep(work, WALK, runtime.snapshot);
  return { runtime, calls, mind, logs, body, memory, runner, work, run };
}

for (const location of ["no houses", "far", "standing"] as const) test(`one status read per step end: ${location}`, async () => {
  const f = fixture();
  const near = location === "standing";
  if (location === "no houses") f.memory.places.splice(0);
  if (location === "far") f.runtime.snapshot = { ...f.runtime.snapshot, position: { ...DOOR, x: 13 } };
  const run = await f.run();
  await f.runner.recordStep(f.work, WALK, run, f.runtime.snapshot);
  assert.equal(f.calls.status, 2, "one start baseline plus one end read, reused by activityOf");
  assert.equal(f.calls.readSigns, near ? 1 : 0);
  assert.equal(f.calls.cellsAt + f.calls.blockKinds + f.calls.itemFamily + f.calls.craftingNeeds, 0);
  assert.equal(f.runtime.submitted.length, 1, "standing visit adds only read_signs; no house adds no call");
  if (near) {
    for (let i = 0; i < 20; i += 1) await f.run();
    assert.equal(f.calls.readSigns, 1, "staying near for 20 more step ends never checks again");
    assert.equal(f.calls.status, 42, "no status call inside the standing-sign check");
    assert.equal(f.runtime.submitted.length, 21, "subsequent nearby steps only navigate");
  }
});

test("an unavailable step-end status skips the visit; activityOf retains its fallback read", async () => {
  const f = fixture();
  const status = f.runtime.status.bind(f.runtime);
  let reads = 0;
  f.runtime.status = async () => {
    reads += 1;
    if (reads === 2) throw new Error("end status unavailable");
    return status();
  };
  const run = await f.run();
  assert.equal(run.after, null);
  await f.runner.recordStep(f.work, WALK, run, f.runtime.snapshot);
  assert.equal(reads, 3);
  assert.equal(f.calls.readSigns, 0);
});

test("leaving and coming back puts a lost sign back, only beyond twice the resume range", async () => {
  const f = fixture();
  f.runtime.snapshot = { ...f.runtime.snapshot, position: { ...DOOR, x: 6.001 } };
  await f.run();
  assert.equal(f.calls.readSigns, 0);
  f.runtime.snapshot = { ...f.runtime.snapshot, position: { ...DOOR, x: 6 } };
  await f.run();
  assert.equal(f.calls.readSigns, 1, "an armed arrival outside six did not consume the edge");
  f.runtime.signs = [];
  for (const x of [6.001, 12, 6]) {
    f.runtime.snapshot = { ...f.runtime.snapshot, position: { ...DOOR, x } };
    await f.run();
  }
  assert.equal(f.calls.readSigns, 1, "neither the annulus nor exactly 12 rearms");
  f.runtime.snapshot = { ...f.runtime.snapshot, position: { ...DOOR, x: 12.001 } };
  await f.run();
  f.runtime.snapshot = { ...f.runtime.snapshot, position: { ...DOOR, x: 6 } };
  await f.run();
  assert.equal(f.calls.readSigns, 2);
  assert.equal(f.runtime.submitted.filter(({ tool }) => tool === "place_sign").length, 1);
  assert.equal(f.calls.cellsAt, 1);
  assert.equal(f.calls.blockKinds, 1);
  assert.equal((await f.run()).result.status, "done", "the next action runs after fresh placement");
});

for (const legacy of ["dimension", "owner", "other dimension"] as const) test(`${legacy}: ineligible house is skipped`, async () => {
  const f = fixture();
  const house = { ...HOME.house! };
  if (legacy === "dimension") delete house.dimension;
  if (legacy === "owner") delete house.owner;
  if (legacy === "other dimension") house.dimension = "the_nether";
  f.memory.places.splice(0, 1, { ...HOME, own: false, house });
  await f.run();
  assert.equal(f.calls.readSigns, 0);
  f.memory.places.splice(0, 1, HOME);
  await f.run();
  assert.equal(f.calls.readSigns, 1);
});

test("a legacy own house uses self; only one of two nearby houses is checked per step", async () => {
  const f = fixture();
  f.runtime.signs = [sign(["", "", "", ""])];
  const { owner: _owner, ...house } = HOME.house!;
  f.memory.places.splice(0, 1, { ...HOME, house }, { ...HOME, name: "second", house: { ...HOME.house!, door: { ...DOOR, x: 2 } } });
  await f.run();
  assert.equal(f.calls.readSigns, 1);
  assert.deepEqual(f.runtime.submitted.find(({ tool }) => tool === "place_sign")?.input.lines, ["Ayla"]);
  await f.run();
  assert.equal(f.calls.readSigns, 2);
});

test("the unfinished house is claimed at a visit and keeps the observed claim", async () => {
  const f = fixture();
  f.memory.places.splice(0);
  f.memory.building.unfinished = { kind: "small medieval house", site: { door: DOOR, facing: "north" }, part: 1, owner: "Steve", dimension: "overworld" };
  f.runtime.signs = [sign(["", "", "", ""])];
  await f.run();
  assert.deepEqual(f.runtime.submitted.find(({ tool }) => tool === "place_sign")?.input.lines, ["Steve"]);
  assert.deepEqual(f.memory.building.unfinished?.claim, CLAIM);
});

test("a blank sign at a visit is filled: three runtime calls and one model call", async () => {
  const f = fixture();
  f.runtime.signs = [sign(["", "", "", ""])];
  let models = 0;
  f.mind.signLines = async () => { models += 1; return ["Welcome back"]; };
  await f.run();
  const placed = f.runtime.submitted.filter(({ tool }) => tool === "place_sign");
  assert.equal(placed.length, 1);
  assert.equal(placed[0]?.input.fill_blank, true);
  assert.equal(f.calls.status, 3, "baseline, end, and pre-fill status");
  assert.equal(f.calls.readSigns, 1);
  assert.equal(f.calls.blockKinds + f.calls.cellsAt + f.calls.itemFamily + f.calls.craftingNeeds, 0);
  assert.equal(models, 1);
});

for (const row of [
  { planks: 6, part: 0, unfinished: true, reserved: true },
  { planks: 36, part: 0, unfinished: true, reserved: true },
  { planks: 36, part: 8, unfinished: true, reserved: true },
  { planks: 6, part: 0, unfinished: false, reserved: false },
]) test(`a visit spares unfinished construction stock (${JSON.stringify(row)})`, async () => {
  const f = fixture();
  f.runtime.signs = [];
  f.runtime.snapshot = { ...f.runtime.snapshot, inventory: [{ name: "oak_planks", count: row.planks }, { name: "stick", count: 1 }] };
  f.runtime.itemFamilies = { sign: ["oak_sign"] };
  f.runtime.recipes = { oak_sign: { makes: 3, needs: [{ item: "oak_planks", count: 6 }, { item: "stick", count: 1 }] } };
  if (row.unfinished) f.memory.building.unfinished = { kind: "small medieval house", site: { door: { ...DOOR, x: 100 }, facing: "north" },
    part: row.part, owner: "Steve", dimension: "overworld" };
  await f.run();
  assert.equal(f.runtime.submitted.filter(({ tool }) => tool === "craft_item").length, row.reserved ? 0 : 1);
  assert.equal(f.runtime.submitted.filter(({ tool }) => tool === "place_sign").length, row.reserved ? 0 : 1);
  assert.equal(f.calls.readSigns, 1);
  assert.ok(f.logs.some((line) => line.includes(row.reserved ? "no_sign" : "placed")));
  if (!row.reserved) assert.equal(Object.values(f.calls).reduce((sum, count) => sum + count, 0) - 2 + 2, 11,
    "crafting visit runtime calls: exclude step baseline/end, include craft and placement");
  assert.equal((await f.run()).result.status, "done", "the body remains usable after crafting or no_sign");
  assert.equal(f.calls.readSigns, 1);
});

for (const failure of ["read", "action", "unknown"] as const) test(`${failure} failure consumes the visit through 20 near steps; departure rearms it`, async () => {
  const f = fixture();
  if (failure === "unknown") f.runtime.signs = [sign(["", "", "", ""], false)];
  if (failure === "read") f.runtime.readSigns = async () => { f.calls.readSigns += 1; throw new Error("read unavailable"); };
  if (failure === "action") { f.runtime.signs = [sign(["", "", "", ""])]; f.runtime.throwNext.place_sign = "action unavailable"; }
  const run = await f.run();
  assert.deepEqual(run.result, { status: "done", detail: "reached 0 64 0" });
  for (let i = 0; i < 20; i += 1) await f.run();
  assert.equal(f.calls.readSigns, 1);
  f.runtime.snapshot = { ...f.runtime.snapshot, position: { ...DOOR, z: 13 } };
  await f.run();
  f.runtime.snapshot = { ...f.runtime.snapshot, position: DOOR };
  await f.run();
  assert.equal(f.calls.readSigns, 2);
});

test("the step controller aborts a visit's model call; the next step runs and acts", async () => {
  const f = fixture();
  f.runtime.signs = [sign(["", "", "", ""])];
  f.mind.signLines = async (_input, signal) => {
    assert.notEqual(f.work.step, null);
    // Both Agent.stopWorkOf (owner stop) and Agent.take (a taken objective) abort this controller.
    f.work.step!.abort();
    assert.equal(signal.aborted, true);
    return [];
  };
  const run = await f.run();
  assert.equal(run.result.status, "done", "a visit never rewrites the chosen step's result");
  assert.equal(f.runtime.submitted.filter(({ tool }) => tool === "place_sign").length, 0);
  assert.ok(f.logs.some((line) => line.includes("stopped")));
  assert.equal(f.work.step, null);
  assert.equal(f.body.onAction, null);
  assert.equal((await f.run()).result.status, "done");
  assert.equal(f.runtime.submitted.filter(({ tool }) => tool === "navigate").length, 2);
  assert.equal(f.calls.readSigns, 1, "stopped visit still consumed its edge");
});

for (const reason of ["abort", "death"] as const) test(`a step ended by ${reason} does not visit`, async () => {
  const f = fixture();
  f.runtime.succeedEffects.navigate = () => {
    if (reason === "abort") f.work.step!.abort();
    else f.runtime.die("Zombie", { cancelRunning: false });
  };
  await f.run();
  assert.equal(f.calls.readSigns, 0);
  delete f.runtime.succeedEffects.navigate;
  await f.run();
  assert.equal(f.calls.readSigns, 1);
});

test("death during the visit's place_sign is observed by the step watch and the next step acts", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const f = fixture();
  f.runtime.signs = [sign(["", "", "", ""])];
  f.runtime.durations.place_sign = 100_000;
  const submit = f.runtime.submit.bind(f.runtime);
  f.runtime.submit = async (tool, input) => {
    const state = await submit(tool, input);
    if (tool === "place_sign") f.runtime.die("Zombie");
    return state;
  };
  const run = await clock.settle(f.run(), 2_000);
  assert.match(run.died ?? "", /you died during this step/u);
  assert.equal(run.actions.filter(({ tool }) => tool === "place_sign").length, 1);
  await f.runner.recordStep(f.work, WALK, run, f.runtime.snapshot);
  assert.match(f.work.steps[0]?.detail ?? "", /you died during this step/u);
  assert.equal((await clock.settle(f.run(), 2_000)).result.status, "done");
});

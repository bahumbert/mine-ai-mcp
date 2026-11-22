/**
 * The scenarios of `drivers/template-build.ts` carry their template's bill in YAML (Mine Labs gives the inventory before
 * the driver runs). A template edited since leaves the YAML short or heavy: this test says so, and that every shipped
 * template has its scenario (plan 2026-11-09-house-templates Task 7).
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadScenario } from "mine-labs";
import { planTemplate } from "#brain/building/plan.ts";
import { TEMPLATES, templateFor } from "#brain/building/templates.ts";
import { ZERO_ARENA, arenaFrame } from "../arena/frame.ts";
import { arenaCell } from "../arena/params.ts";
import { DEFAULT_SCAFFOLD_BLOCKS } from "#src/survival/policy/contract.ts";
import { buildInput, flaggedStages, partInputs, scaffoldCarriedMismatch, scaffoldListKeepingBill, stageOfCutCall, templateBuildParams } from "./template-build.ts";

// check-reads: tests/minecraft/scenarios/build/*.yaml, brain/building-templates/*.json
const BUILD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../scenarios/build");
/** Carried besides the bill: the tool that digs the ground under the floor and the dirt the routes' scaffold is made of. */
const EXTRAS = new Set(["iron_shovel", "dirt"]);

const files = readdirSync(BUILD_DIR).filter((name) => /^template-(builds|stages|roof-no-scaffold|roof-stops-for-scaffold|roof-counted-scaffold)-.*\.yaml$/.test(name));

interface Params {
  readonly scaffoldCarried?: number;
  readonly template: string;
  readonly door: { x: number; y: number; z: number };
  readonly facing?: "north" | "south" | "east" | "west";
  readonly interruptAfterBatch?: number;
  readonly interruptStage?: string;
  readonly expectScaffoldStop?: boolean;
}

for (const name of files) {
  test(`${name} carries exactly its template's bill`, async () => {
    const scenario = await loadScenario(path.join(BUILD_DIR, name));
    const params = scenario.params as unknown as Params;
    const template = templateFor(params.template);
    assert.ok(template, `template ${params.template} is not shipped`);
    const door = arenaCell(arenaFrame(ZERO_ARENA)).parse(params.door);
    const plan = planTemplate(template, { door, facing: params.facing ?? "north" });
    const carried = new Map<string, number>();
    for (const { item, count } of scenario.players[0]!.inventory ?? []) carried.set(item, (carried.get(item) ?? 0) + count);
    for (const { item, count } of plan.bill) assert.equal(carried.get(item) ?? 0, count, `${item} carried against ${count} in the bill`);
    const billed = new Set(plan.bill.map(({ item }) => item));
    assert.deepEqual([...carried.keys()].filter((item) => !billed.has(item) && !EXTRAS.has(item)), [], "items carried that the template does not use");
    assert.equal(carried.get("iron_shovel"), 1, "the shovel that digs the ground under the floor");
    // A run with no block to stand on carries no dirt at all (it expects the stop for want of one, or counts 0); a counted run carries exactly the count.
    const dirtCarried = params.expectScaffoldStop === true || params.scaffoldCarried === 0 ? undefined : params.scaffoldCarried ?? 32;
    assert.equal(carried.get("dirt"), dirtCarried, "the dirt the routes' scaffold is made of (none when the run carries no scaffold, the counted scaffold when the run names it)");
    if (params.interruptAfterBatch !== undefined) {
      assert.equal(stageOfCutCall(plan, params.interruptAfterBatch), params.interruptStage, "the cut call lies in the stage the scenario names");
    }
  });
}

// The cut is counted in placed cells and bounded in server ticks, never in wall milliseconds (plan 2026-11-22-phase5-gate-p1 T18; S1).
const interruptFiles = files.filter((name) => name.startsWith("template-stages-interrupted"));

test("a template-stages-interrupted scenario exists", () => {
  assert.ok(interruptFiles.length > 0);
});

for (const name of interruptFiles) {
  test(`${name} cuts the call after its first placed cell within a server-tick bound, not after wall milliseconds`, async () => {
    const scenario = await loadScenario(path.join(BUILD_DIR, name));
    for (const key of ["cancelAfterCells", "cancelWithinTicks"]) assert.ok(key in (scenario.params as object), `${key} is written in the scenario, not left to a default`);
    const params = templateBuildParams(arenaFrame(ZERO_ARENA)).parse(scenario.params);
    assert.equal(params.cancelAfterCells, 1, "the cancel comes once the call's first cell stands");
    assert.ok(params.cancelWithinTicks >= 20 && params.cancelWithinTicks % 20 === 0, "the bound is a whole number of 20-tick steps (P5)");
  });
}

/** The classic houses are live-proven: two of them (a gable and a hip roof) check the driver, the regional ones all have a scenario. */
const CLASSIC_WITH_SCENARIO = ["medieval-small", "japanese-medium"];

test("every regional template and two classic ones have a template-builds scenario", () => {
  const covered = new Set(files.filter((name) => name.startsWith("template-builds-")).map((name) => name.slice("template-builds-".length, -".yaml".length)));
  assert.deepEqual([...TEMPLATES.values()].filter((template) => template.classic === undefined && !covered.has(template.id)).map((template) => template.id), []);
  assert.deepEqual(CLASSIC_WITH_SCENARIO.filter((id) => !covered.has(id)), []);
});

const noScaffoldFiles = files.filter((name) => name.startsWith("template-roof-no-scaffold-"));

/**
 * Bruno's house (medieval-small) and the hanok: since the build works a cell from the eye (plan 2026-11-14-house-build-fixes-2
 * Task 2a) their roofs are within reach from the ground, so the helper counts 0 blocks and a bot that carries no block to
 * stand on builds the whole house (before, the medieval-small roof was the stop this scenario expected).
 */
const NO_SCAFFOLD_TEMPLATES = ["medieval-small", "hanok"];

test("the roof-without-scaffold scenarios exist for the templates the plan names", () => {
  assert.deepEqual(NO_SCAFFOLD_TEMPLATES.filter((id) => !noScaffoldFiles.includes(`template-roof-no-scaffold-${id}.yaml`)), []);
});

for (const name of noScaffoldFiles) {
  test(`${name} is named after its template, counts 0 scaffold and has no block to stand on`, async () => {
    const scenario = await loadScenario(path.join(BUILD_DIR, name));
    const params = scenario.params as unknown as Params;
    assert.equal(name, `template-roof-no-scaffold-${params.template}.yaml`, "the file is named after its template");
    assert.equal(params.scaffoldCarried, 0, "the run builds the whole template with no scaffold carried");
    const door = arenaCell(arenaFrame(ZERO_ARENA)).parse(params.door);
    const plan = planTemplate(templateFor(params.template)!, { door, facing: params.facing ?? "north" });
    assert.deepEqual(flaggedStages(plan, door.y).map(({ stage }) => stage.name), [], "the helper flags no stage of this template");
    // The shovel digs the ground under the floor and picks up what it drops (measured 2026-11-11: 13 dirt carried by the roof, 2 and 4 scaffold placed there).
    assert.deepEqual(groundBlocksAdmittedAsScaffold(scenario), [], "a ground that drops a block the policy admits as scaffold");
  });
}

const stopFiles = files.filter((name) => name.startsWith("template-roof-stops-for-scaffold-"));

test("a roof-stops-for-scaffold scenario exists: the proof that a roof out of reach with no block to stand on still ends for want of one", () => {
  assert.ok(stopFiles.length > 0);
});

for (const name of stopFiles) {
  test(`${name} is named after its template, expects the stop and the helper flags a stage of it`, async () => {
    const scenario = await loadScenario(path.join(BUILD_DIR, name));
    const params = scenario.params as unknown as Params;
    assert.equal(name, `template-roof-stops-for-scaffold-${params.template}.yaml`, "the file is named after its template");
    assert.equal(params.expectScaffoldStop, true);
    assert.equal(params.scaffoldCarried, undefined, "the run carries no scaffold: it is not a counted run");
    const door = arenaCell(arenaFrame(ZERO_ARENA)).parse(params.door);
    const plan = planTemplate(templateFor(params.template)!, { door, facing: params.facing ?? "north" });
    assert.ok(flaggedStages(plan, door.y).length > 0, "the helper flags a stage of this template, else nothing stops");
    assert.deepEqual(groundBlocksAdmittedAsScaffold(scenario), [], "a ground that drops a block the policy admits as scaffold");
  });
}

/** The ground blocks of a scenario's `fill` geometry that the runtime's default policy admits as scaffold: the shovel would pick them up and the run would carry more than its count. */
function groundBlocksAdmittedAsScaffold(scenario: Awaited<ReturnType<typeof loadScenario>>): string[] {
  const ground = (scenario.geometry ?? []).flatMap((entry) => ("fill" in entry ? [entry.fill.block] : []));
  return ground.filter((block) => (DEFAULT_SCAFFOLD_BLOCKS as readonly string[]).includes(block));
}

// The counted-scaffold scenarios (plan 2026-11-12-house-build-fixes Task 6, back on the suite by plan 2026-11-14 Task 3):
// a template whose roof needs blocks by the helper's count (`scaffoldNeed`) carries exactly that many, and the whole
// house must stand with none left.
const countedFiles = files.filter((name) => name.startsWith("template-roof-counted-scaffold-"));

for (const name of countedFiles) {
  test(`${name} carries the counted scaffold and builds the whole template`, async () => {
    const scenario = await loadScenario(path.join(BUILD_DIR, name));
    const params = scenario.params as unknown as Params;
    assert.equal(name, `template-roof-counted-scaffold-${params.template}.yaml`, "the file is named after its template");
    const door = arenaCell(arenaFrame(ZERO_ARENA)).parse(params.door);
    const plan = planTemplate(templateFor(params.template)!, { door, facing: params.facing ?? "north" });
    const first = flaggedStages(plan, door.y)[0];
    assert.ok(first, "the reach rule flags a stage of this template");
    assert.equal(params.scaffoldCarried, first.need.count, "the scenario carries what the helper counts for the first flagged stage");
    assert.deepEqual(groundBlocksAdmittedAsScaffold(scenario), [], "a ground that drops a block the policy admits as scaffold");
  });
}

const DOOR = { x: 0, y: -59, z: 6 } as const;

// Fixtures: the saltbox has a roof out of the eye's reach from the ground (the count is the helper's, read here, not pinned); the
// medieval-small roof is within it (count 0: plan 2026-11-14-house-build-fixes-2 Task 2a and 2c).
test("scaffoldCarriedMismatch is null at the helper's count, else names it; 0 matches a roof the eye reaches, and nothing is flagged from a level that reaches all", () => {
  const high = planTemplate(templateFor("saltbox")!, { door: DOOR, facing: "north" });
  const [first] = flaggedStages(high, DOOR.y);
  assert.ok(first, "the saltbox flags a stage (else this test checks nothing)");
  const count = first.need.count;
  assert.equal(scaffoldCarriedMismatch(high, DOOR.y, count), null);
  assert.match(scaffoldCarriedMismatch(high, DOOR.y, count - 1) ?? "", new RegExp(`carries ${count - 1}.*stage ${first.stage.name}.*is ${count}`, "u"));
  assert.match(scaffoldCarriedMismatch(high, DOOR.y, 0) ?? "", new RegExp(`carries 0.*is ${count}`, "u"));
  assert.match(scaffoldCarriedMismatch(high, 0, count) ?? "", /flags no stage/u);
  const low = planTemplate(templateFor("medieval-small")!, { door: DOOR, facing: "north" });
  assert.equal(scaffoldCarriedMismatch(low, DOOR.y, 0), null);
  assert.match(scaffoldCarriedMismatch(low, DOOR.y, 1) ?? "", /flags no stage/u);
});

test("the counted runs send build_structure with the policy's scaffold list the brain leaves while it builds: the admitted kinds minus the bill's", () => {
  const plan = planTemplate(templateFor("medieval-small")!, { door: DOOR, facing: "north" });
  const billKinds = plan.bill.map((entry) => entry.item);
  const list = scaffoldListKeepingBill(plan);
  assert.ok(billKinds.some((item) => (DEFAULT_SCAFFOLD_BLOCKS as readonly string[]).includes(item)), "the template's bill holds an admitted kind (else this test checks nothing)");
  assert.deepEqual(list, DEFAULT_SCAFFOLD_BLOCKS.filter((block) => !billKinds.includes(block)));
  assert.ok(list.includes("dirt"), "the counted dirt stays admitted");
  assert.equal(list.some((block) => billKinds.includes(block)), false, "no bill kind is scaffold");
});

/** The index of the stage a call (an index of `plan.batches`) belongs to. */
const stageIndexOfCall = (plan: ReturnType<typeof planTemplate>, call: number) => plan.stages.findIndex((stage) => call >= stage.first && call <= stage.last);

test("the walls' calls carry the roof's reserve: the stages before the first one that needs scaffold keep it by count, that stage and the later ones send none (as the brain's buildStages does)", () => {
  const plan = planTemplate(templateFor("saltbox")!, { door: DOOR, facing: "north" });
  const flaggedStage = plan.stages.indexOf(flaggedStages(plan, DOOR.y)[0]!.stage);
  assert.ok(flaggedStage > 0, "the saltbox has stages before the one that needs scaffold (else this test checks nothing)");
  // The counts are the brain's own (`scaffoldReserve` over the later stages' cells, none built: the floor's covers the walls too),
  // so the test holds their shape: one entry per kind of the scaffold list, each positive.
  const kinds = scaffoldListKeepingBill(plan);
  partInputs(plan, true).forEach((call, index) => {
    if (call === null) return;
    const stage = stageIndexOfCall(plan, index);
    if (stage >= flaggedStage) return assert.deepEqual(call.reserve, [], `call ${index + 1} (${plan.stages[stage]!.name}) needs scaffold itself or is later`);
    assert.deepEqual(call.reserve.map((entry) => entry.item), kinds, `call ${index + 1} (${plan.stages[stage]!.name}) keeps one entry per kind`);
    assert.ok(call.reserve.every((entry) => entry.count > 0));
  });
});

test("a run with no scaffold carried sends no reserve, and the final check never sends one", () => {
  const plan = planTemplate(templateFor("saltbox")!, { door: DOOR, facing: "north" });
  assert.ok(partInputs(plan, false).every((call) => call === null || call.reserve.length === 0));
  const reserving = partInputs(plan, true).find((call) => call !== null && call.reserve.length > 0)!;
  assert.ok(reserving, "a call reserves (else this test checks nothing)");
  assert.deepEqual(buildInput(reserving, false).reserve_items, reserving.reserve);
  assert.equal("reserve_items" in buildInput(reserving, true), false, "the audit pass sends none");
  assert.equal("reserve_items" in buildInput(partInputs(plan, false).find((call) => call !== null)!, false), false, "an empty reserve is not sent");
});

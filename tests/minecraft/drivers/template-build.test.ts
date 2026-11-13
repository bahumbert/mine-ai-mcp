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
import { flaggedStages, scaffoldCarriedMismatch, scaffoldListKeepingBill, stageOfCutCall } from "./template-build.ts";

// check-reads: tests/minecraft/scenarios/build/*.yaml, brain/building-templates/*.json
const BUILD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../scenarios/build");
/** Carried besides the bill: the tool that digs the ground under the floor and the dirt the routes' scaffold is made of. */
const EXTRAS = new Set(["iron_shovel", "dirt"]);

const files = readdirSync(BUILD_DIR).filter((name) => /^template-(builds|stages|roof-no-scaffold|roof-counted-scaffold)-.*\.yaml$/.test(name));

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
    // A run with no block to stand on carries no dirt at all: the stop it expects is for want of one; a counted run carries exactly the count.
    const dirtCarried = params.expectScaffoldStop === true ? undefined : params.scaffoldCarried ?? 32;
    assert.equal(carried.get("dirt"), dirtCarried, "the dirt the routes' scaffold is made of (none when the run expects the scaffold stop, the counted scaffold when the run names it)");
    if (params.interruptAfterBatch !== undefined) {
      assert.equal(stageOfCutCall(plan, params.interruptAfterBatch), params.interruptStage, "the cut call lies in the stage the scenario names");
    }
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

/** Bruno's house: a roof out of reach. (The saltbox's flagged walls build by its inner ladder, an overflag the spec accepts: no scenario expects a stop there.) */
const NO_SCAFFOLD_TEMPLATES = ["medieval-small"];

test("the roof-without-scaffold scenarios exist for the templates the plan names", () => {
  assert.deepEqual(NO_SCAFFOLD_TEMPLATES.filter((id) => !noScaffoldFiles.includes(`template-roof-no-scaffold-${id}.yaml`)), []);
});

for (const name of noScaffoldFiles) {
  test(`${name} is named after its template, expects the stop and has no block to stand on`, async () => {
    const scenario = await loadScenario(path.join(BUILD_DIR, name));
    const params = scenario.params as unknown as Params;
    assert.equal(name, `template-roof-no-scaffold-${params.template}.yaml`, "the file is named after its template");
    assert.equal(params.expectScaffoldStop, true);
    // The shovel digs the ground under the floor and picks up what it drops (measured 2026-11-11: 13 dirt carried by the roof, 2 and 4 scaffold placed there).
    assert.deepEqual(groundBlocksAdmittedAsScaffold(scenario), [], "a ground that drops a block the policy admits as scaffold");
  });
}

/** The ground blocks of a scenario's `fill` geometry that the runtime's default policy admits as scaffold: the shovel would pick them up and the run would carry more than its count. */
function groundBlocksAdmittedAsScaffold(scenario: Awaited<ReturnType<typeof loadScenario>>): string[] {
  const ground = (scenario.geometry ?? []).flatMap((entry) => ("fill" in entry ? [entry.fill.block] : []));
  return ground.filter((block) => (DEFAULT_SCAFFOLD_BLOCKS as readonly string[]).includes(block));
}

// The counted-scaffold scenarios (medieval-small h = 5, hanok h = 6; plan 2026-11-12-house-build-fixes Task 6) are kept
// off the suite while the route spends more scaffold than scaffoldNeed counts (owner 2026-11-12; backlog "the route lays
// scaffold at ground level"): their YAMLs are on branch claude/hf-w4 (a952f3b). A counted YAML added back is checked here.
const countedFiles = files.filter((name) => name.startsWith("template-roof-counted-scaffold-"));

for (const name of countedFiles) {
  test(`${name} carries the counted scaffold and builds the whole template`, async () => {
    const scenario = await loadScenario(path.join(BUILD_DIR, name));
    const params = scenario.params as unknown as Params;
    assert.equal(name, `template-roof-counted-scaffold-${params.template}.yaml`, "the file is named after its template");
    assert.notEqual(params.expectScaffoldStop, true, "the run builds the whole template, it does not expect a stop");
    assert.equal(params.interruptAfterBatch, undefined, "no cut and resume: the count is measured in one pass");
    const door = arenaCell(arenaFrame(ZERO_ARENA)).parse(params.door);
    const plan = planTemplate(templateFor(params.template)!, { door, facing: params.facing ?? "north" });
    const first = flaggedStages(plan, door.y)[0];
    assert.ok(first, "the reach rule flags a stage of this template");
    assert.equal(params.scaffoldCarried, first.need.count, "the scenario carries what the helper counts for the first flagged stage");
    assert.deepEqual(groundBlocksAdmittedAsScaffold(scenario), [], "a ground that drops a block the policy admits as scaffold");
  });
}

test("scaffoldCarriedMismatch names the helper's count when the carried count differs, and a template with no flagged stage", () => {
  const plan = planTemplate(templateFor("medieval-small")!, { door: { x: 0, y: -59, z: 6 }, facing: "north" });
  assert.equal(scaffoldCarriedMismatch(plan, -59, 4), null);
  assert.match(scaffoldCarriedMismatch(plan, -59, 3) ?? "", /carries 3.*stage roof.*is 4/u);
  // Standing at y 0 the whole house is below reach: no stage is flagged.
  assert.match(scaffoldCarriedMismatch(plan, 0, 4) ?? "", /flags no stage/u);
});

test("the counted runs send build_structure with the policy's scaffold list the brain leaves while it builds: the admitted kinds minus the bill's", () => {
  const plan = planTemplate(templateFor("medieval-small")!, { door: { x: 0, y: -59, z: 6 }, facing: "north" });
  const billKinds = plan.bill.map((entry) => entry.item);
  const list = scaffoldListKeepingBill(plan);
  assert.ok(billKinds.some((item) => (DEFAULT_SCAFFOLD_BLOCKS as readonly string[]).includes(item)), "the template's bill holds an admitted kind (else this test checks nothing)");
  assert.deepEqual(list, DEFAULT_SCAFFOLD_BLOCKS.filter((block) => !billKinds.includes(block)));
  assert.ok(list.includes("dirt"), "the counted dirt stays admitted");
  assert.equal(list.some((block) => billKinds.includes(block)), false, "no bill kind is scaffold");
});

test("the reach rule flags only the roof of the medieval-small house, with the helper's count of 4", () => {
  const plan = planTemplate(templateFor("medieval-small")!, { door: { x: 0, y: -59, z: 6 }, facing: "north" });
  const flagged = flaggedStages(plan, -59);
  assert.deepEqual(flagged.map(({ stage }) => stage.name), ["roof"]);
  assert.equal(flagged[0]!.need.count, 4);
});

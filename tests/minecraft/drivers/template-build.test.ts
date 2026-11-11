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
import { flaggedStages, stageOfCutCall } from "./template-build.ts";

// check-reads: tests/minecraft/scenarios/build/*.yaml, brain/building-templates/*.json
const BUILD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../scenarios/build");
/** Carried besides the bill: the tool that digs the ground under the floor and the dirt the routes' scaffold is made of. */
const EXTRAS = new Set(["iron_shovel", "dirt"]);

const files = readdirSync(BUILD_DIR).filter((name) => /^template-(builds|stages|roof-no-scaffold)-.*\.yaml$/.test(name));

interface Params {
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
    // A run with no block to stand on carries no dirt at all: the stop it expects is for want of one.
    assert.equal(carried.get("dirt"), params.expectScaffoldStop === true ? undefined : 32, "the dirt the routes' scaffold is made of (none when the run expects the scaffold stop)");
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
    const ground = (scenario.geometry ?? []).flatMap((entry) => ("fill" in entry ? [entry.fill.block] : []));
    assert.deepEqual(ground.filter((block) => (DEFAULT_SCAFFOLD_BLOCKS as readonly string[]).includes(block)), [], "a ground that drops a block the policy admits as scaffold");
  });
}

test("the reach rule flags only the roof of the medieval-small house, with the helper's count of 3", () => {
  const plan = planTemplate(templateFor("medieval-small")!, { door: { x: 0, y: -59, z: 6 }, facing: "north" });
  const flagged = flaggedStages(plan, -59);
  assert.deepEqual(flagged.map(({ stage }) => stage.name), ["roof"]);
  assert.equal(flagged[0]!.need.count, 3);
});

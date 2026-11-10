// `build` by template and stage (plan 2026-11-09-house-templates Task 4b): a house is built stage after stage, a stage only
// when its blocks are carried, and the step that stops between stages is gone on with by the same step again.
import assert from "node:assert/strict";
import test from "node:test";
import { stepSchema } from "./actions.ts";
import { Body } from "./body.ts";
import { billOfMaterials, cellsCountedOnce } from "./building/blueprint.ts";
import { houseBox } from "./building/house-site.ts";
import { planTemplate } from "./building/plan.ts";
import { TEMPLATES, templateFor, type Template } from "./building/templates.ts";
import type { KnownPlace } from "./mind.ts";
import { BodyDown, type BotSnapshot } from "./runtime-client.ts";
import { runStep, type SkillContext, type UnfinishedHouse } from "./skills.ts";
import { FakeRuntime, SMALL_MEDIEVAL_HOUSE as SMALL_MEDIEVAL } from "./testing.ts";

const medievalSmall = templateFor("medieval-small")!;
const { classic: _classic, ...medievalShape } = medievalSmall;
/** A house of another family than the shipped ones (Task 6 ships the regional files): the small medieval house's shape under its own name. */
const RONDAVEL: Template = { ...medievalShape, id: "rondavel", family: "africa", name: "rondavel", kind: "rondavel", description: "a round hut" };
const FIXTURES = new Map([...TEMPLATES, [RONDAVEL.id, RONDAVEL]]);

function contextFor(runtime: FakeRuntime, extra: Partial<SkillContext> = {}): SkillContext {
  return { runtime, body: new Body(runtime, () => undefined), signal: new AbortController().signal, style: "medieval", templates: FIXTURES, ...extra };
}

const builds = (runtime: FakeRuntime) => runtime.submitted.filter((call) => call.tool === "build_structure").map((call) => call.input as { blocks: { x: number; y: number; z: number; block_name: string }[] });
const rondavel = () => stepSchema.parse({ skill: "build", template: "rondavel" });
const detailOf = (result: Awaited<ReturnType<typeof runStep>>) => (result.status === "stopped" ? "stopped" : result.detail);

/** The bot stands by the origin with `inventory`; the game consumes one item per block placed that is not already there (a cell right is skipped). */
function standingWith(runtime: FakeRuntime, inventory: BotSnapshot["inventory"]): void {
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory };
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    const settled = await submit(tool, input, ...rest);
    if (tool !== "build_structure" || settled.state !== "settled" || settled.status !== "succeeded") return settled;
    for (const { x, y, z, block_name: block } of (input as { blocks: { x: number; y: number; z: number; block_name: string }[] }).blocks) {
      const key = `${x},${y},${z}`;
      if (runtime.world.get(key) === block) continue;
      runtime.world.set(key, block);
      if (block === "air") continue;
      runtime.snapshot = { ...runtime.snapshot, inventory: runtime.snapshot.inventory.map((stack) => (stack.name === block ? { ...stack, count: stack.count - 1 } : stack)) };
    }
    return settled;
  };
}

const carried = (runtime: FakeRuntime, item: string) => runtime.snapshot.inventory.find((stack) => stack.name === item)?.count ?? 0;
const FLOOR_BILL = [{ name: "cobblestone", count: 15 }, { name: "oak_planks", count: 9 }];

test("a build by template builds that template and remembers it by id and family (a classic file keeps its size and style: skills.test.ts)", async () => {
  const places: KnownPlace[] = [];
  const runtime = new FakeRuntime();
  standingWith(runtime, SMALL_MEDIEVAL);
  const result = await runStep(rondavel(), contextFor(runtime, { remember: (place) => places.push(place) }));
  assert.match(detailOf(result), /^built a rondavel, door at -?\d+ 64 -?\d+ facing north$/u);
  assert.deepEqual(places[0]!.house, { template: "rondavel", family: "africa", door: { x: 0, y: 64, z: 2 }, facing: "north", materials: {} });
});

test("a build stops between stages for materials and goes on at the next stage when they are carried", async () => {
  const runtime = new FakeRuntime();
  standingWith(runtime, FLOOR_BILL);
  const building: { unfinished: UnfinishedHouse | null } = { unfinished: null };
  const context = contextFor(runtime, { building });
  const first = await runStep(rondavel(), context);
  assert.equal(first.status, "done");
  assert.match(detailOf(first), /^stages 1-1 of \d+ of the rondavel are built .*: the walls \(stage 2\) needs .*: fetch exactly those with get_items, then \{"skill":"build","template":"rondavel"\} again to go on/u);
  assert.equal(builds(runtime).length, 1, "the floor is one call");
  assert.deepEqual({ template: building.unfinished?.template, family: building.unfinished?.family, stage: building.unfinished?.stage, stages: building.unfinished?.stages, stageName: building.unfinished?.stageName, part: building.unfinished?.part, prepared: building.unfinished?.prepared },
    { template: "rondavel", family: "africa", stage: 1, stages: 4, stageName: "walls", part: 1, prepared: true });
  // The next action from that state: the walls are carried, so the same step goes on at stage 2 and ends the house.
  const rest = SMALL_MEDIEVAL.map((stack) => ({ ...stack, count: stack.name === "cobblestone" ? 1 : stack.name === "oak_planks" ? 27 : stack.count }));
  runtime.snapshot = { ...runtime.snapshot, inventory: rest };
  const second = await runStep(rondavel(), context);
  assert.match(detailOf(second), /^built a rondavel/u);
  const calls = builds(runtime);
  assert.notDeepEqual(calls[1]!.blocks, calls[0]!.blocks, "the floor is not built again before the walls");
  assert.ok(calls.length > 4, "walls, roof and finish followed");
  assert.equal(building.unfinished, null);
});

/** A rondavel whose floor stands (the first step, floor blocks only), and the cells of its walls stage, in call order. */
async function floorBuilt(runtime: FakeRuntime) {
  standingWith(runtime, FLOOR_BILL);
  const building: { unfinished: UnfinishedHouse | null } = { unfinished: null };
  const context = contextFor(runtime, { building });
  await runStep(rondavel(), context);
  const plan = planTemplate(RONDAVEL, building.unfinished!.site);
  const walls = plan.stages[1]!;
  return { context, plan, building, wallCells: cellsCountedOnce(plan.batches).slice(walls.first, walls.last + 1).flat().filter((cell) => cell.block !== "air") };
}

test("a resumed stage bills the cells not yet right; a failed read bills the whole stage; a body that is down is thrown, not a failed read", async () => {
  const bodyDown = () => new BodyDown({ at: new Date(Date.now() + 30_000).toISOString(), attempt: 1, of: 6 }, new Error("[RUNTIME_UNRESPONSIVE] gone"));
  const cases: { name: string; read: "world" | Error; says: RegExp | null }[] = [
    { name: "half of the walls stand", read: "world", says: /^stages 2-2 of 4 of the rondavel are built .*: the roof \(stage 3\) needs/u },
    { name: "the read fails", read: new Error("the box could not be read"), says: /^missing .* for stage 2 of 4 \(walls\) of a rondavel/u },
    { name: "the body is down", read: bodyDown(), says: null },
  ];
  for (const { name, read, says } of cases) {
    const runtime = new FakeRuntime();
    const { context, wallCells } = await floorBuilt(runtime);
    // Half of the walls already stand (a stop in the middle of the stage); the carried blocks are the other half's.
    for (const cell of wallCells.filter((_, index) => index % 2 === 0)) runtime.world.set(`${cell.x},${cell.y},${cell.z}`, cell.block);
    runtime.snapshot = { ...runtime.snapshot, inventory: billOfMaterials(wallCells.filter((_, index) => index % 2 === 1)).map(({ item, count }) => ({ name: item, count })) };
    if (read !== "world") runtime.blocksIn = async () => { throw read; };
    if (says === null) await assert.rejects(runStep(rondavel(), context), (thrown: unknown) => thrown instanceof BodyDown, name);
    else assert.match(detailOf(await runStep(rondavel(), context)), says, name);
  }
});

test("an old note resumes its classic house: no template in it, its kind names medieval-small", async () => {
  const runtime = new FakeRuntime();
  standingWith(runtime, SMALL_MEDIEVAL);
  const site = { door: { x: 5, y: 64, z: 0 }, facing: "north" as const };
  const building: { unfinished: UnfinishedHouse | null } = { unfinished: { kind: "small medieval house", site, part: 3, prepared: true, materials: {} } };
  const result = await runStep(stepSchema.parse({ skill: "build", size: "small" }), contextFor(runtime, { building }));
  assert.match(detailOf(result), /^built a small medieval house, door at 5 64 0 facing north$/u, "at its own door, not a new site behind the bot");
  assert.equal(building.unfinished, null);
});

test("a bot standing inside a big house far from its door resumes it", async () => {
  const medium = templateFor("medieval-medium")!;
  const site = { door: { x: 0, y: 64, z: 0 }, facing: "north" as const };
  const box = houseBox(planTemplate(medium, site).batches.flat());
  const far = { x: box.max.x, y: 64, z: box.max.z };
  assert.ok(Math.hypot(far.x - site.door.x, far.z - site.door.z) > 6, "the fixture: a spot of the house box beyond the resume range");
  const runtime = new FakeRuntime();
  standingWith(runtime, [...SMALL_MEDIEVAL.map((stack) => ({ ...stack, count: stack.count * 3 }))]);
  runtime.snapshot = { ...runtime.snapshot, position: { x: far.x + 0.5, y: 64, z: far.z + 0.5 } };
  const building: { unfinished: UnfinishedHouse | null } = { unfinished: { kind: "medium medieval house", site, part: 1, prepared: true, materials: {} } };
  const result = await runStep(stepSchema.parse({ skill: "build", size: "medium" }), contextFor(runtime, { building }));
  assert.match(detailOf(result), /door at 0 64 0 facing north/u, `resumed where it stands: ${detailOf(result)}`);
});

test("a new house over an unfinished record says the old one is no longer tracked and where its area stays, whichever way the step ends; a gone template is no house to go on with", async () => {
  const door = { x: 40, y: 64, z: 40 };
  const around = { regionId: 5, owner: "self", label: "rondavel", min: { x: door.x - 3, y: 63, z: door.z - 3 }, max: { x: door.x + 3, y: 72, z: door.z + 3 } };
  const cases = [
    { name: "built", unfinished: { kind: "rondavel", template: "rondavel", site: { door, facing: "north" as const }, part: 1, prepared: true, materials: {} }, area: true, failBuild: false, status: "done", says: /^built a small medieval house.*your unfinished rondavel at 40 64 40 is no longer tracked; its area #5 stays protected until released/u },
    { name: "a part fails", unfinished: { kind: "rondavel", template: "rondavel", site: { door, facing: "north" as const }, part: 1, prepared: true, materials: {} }, area: true, failBuild: true, status: "failed", says: /stopped at part 1\/\d+.*your unfinished rondavel at 40 64 40 is no longer tracked; its area #5 stays protected/u },
    { name: "its template is gone", unfinished: { kind: "gone house", template: "gone", site: { door: { x: 0, y: 64, z: 2 }, facing: "north" as const }, part: 3, prepared: true, materials: {} }, area: false, failBuild: false, status: "done", says: /your unfinished gone house at 0 64 2 is no longer tracked$/u },
  ] as const;
  for (const { name, unfinished, area, failBuild, status, says } of cases) {
    const runtime = new FakeRuntime();
    standingWith(runtime, SMALL_MEDIEVAL);
    if (area) runtime.areas.push(around);
    if (failBuild) runtime.failNext.build_structure = { error: "[BUILD_INCOMPLETE] 1 cell still wrong" };
    const building: { unfinished: UnfinishedHouse | null } = { unfinished };
    const result = await runStep(stepSchema.parse({ skill: "build", template: "medieval-small" }), contextFor(runtime, { building, self: "self" }));
    assert.equal(result.status, status, `${name}: ${detailOf(result)}`);
    assert.match(detailOf(result), says, name);
  }
});

test("an own area of an unfinished house whose template is gone is named, with no step to go on with it", async () => {
  const runtime = new FakeRuntime();
  standingWith(runtime, SMALL_MEDIEVAL);
  const door = { x: 0, y: 64, z: 2 };
  runtime.areas.push({ regionId: 5, owner: "self", label: "gone house", min: { x: -3, y: 63, z: -1 }, max: { x: 3, y: 72, z: 5 } });
  const building: { unfinished: UnfinishedHouse | null } = { unfinished: { kind: "gone house", template: "gone", site: { door, facing: "north" }, part: 1, prepared: true, materials: {} } };
  const result = await runStep(stepSchema.parse({ skill: "build", template: "medieval-small" }), contextFor(runtime, { building, self: "self" }));
  assert.equal(result.status, "failed");
  assert.match(detailOf(result), /that is your unfinished gone house \(area #5/u);
  assert.doesNotMatch(detailOf(result), /"template":"medieval-small"\} within/u, "it is not the step that goes on with that house");
  assert.match(detailOf(result), /abandon_house/u);
});

test("a template the context does not hold fails with the known ones, before anything is touched", async () => {
  const runtime = new FakeRuntime();
  standingWith(runtime, SMALL_MEDIEVAL);
  // The step schema only knows the shipped ids: an id the running context lacks (a fixture registry) is the case left.
  const result = await runStep(stepSchema.parse({ skill: "build", template: "medieval-small" }), contextFor(runtime, { templates: new Map([["rondavel", RONDAVEL]]) }));
  assert.equal(result.status, "failed");
  assert.match(detailOf(result), /no house template "medieval-small": the ones you know are rondavel/u);
  assert.equal(runtime.submitted.length, 0);
});

test("a house built from exactly its bill reaches its door: the cell under the door is billed once", async () => {
  const runtime = new FakeRuntime();
  standingWith(runtime, SMALL_MEDIEVAL);
  const result = await runStep(stepSchema.parse({ skill: "build", template: "medieval-small" }), contextFor(runtime));
  assert.equal(result.status, "done", detailOf(result));
  assert.match(detailOf(result), /^built a small medieval house/u);
  const last = builds(runtime).at(-1)!.blocks;
  assert.equal(last.at(-1)!.block_name, "oak_door", "the door is placed");
  assert.equal(carried(runtime, "cobblestone"), 0, "all 16 cobblestone were used, none short");
});

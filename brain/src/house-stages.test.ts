// `build` by template and stage (plan 2026-11-09-house-templates Task 4b): a house is built stage after stage, a stage only
// when its blocks are carried, and the step that stops between stages is gone on with by the same step again.
import assert from "node:assert/strict";
import test from "node:test";
import { stepSchema } from "./actions.ts";
import { Body } from "./body.ts";
import { billOfMaterials, cellsCountedOnce } from "./building/blueprint.ts";
import { houseBox } from "./building/house-site.ts";
import { builderStand, planTemplate, type HousePlan } from "./building/plan.ts";
import { billFrom } from "./building/stage-progress.ts";
import { outOfReachFromGround } from "./building/stand-columns.ts";
import { describeWay } from "./gathering/fetch-farther.ts";
import { TEMPLATES, templateFor, type Template } from "./building/templates.ts";
import type { KnownPlace } from "./mind.ts";
import { BodyDown, type BotSnapshot } from "./runtime-client.ts";
import { runStep, type SkillContext, type UnfinishedHouse } from "./skills.ts";
import { DEFAULT_POLICY, FakeRuntime, MEDIEVAL_SMALL_HIGH_ROOF, SMALL_MEDIEVAL_HOUSE as SMALL_MEDIEVAL, TEMPLATES_WITH_HIGH_ROOF } from "./testing.ts";

/** A template with its claim sign cell taken out: these tests are about stages and fetches, so the houses they build make no claim (claims: skills/build-house-claim.test.ts). */
function withoutSign(template: Template): Template {
  const { sign: _sign, ...blueprint } = template.blueprint;
  return { ...template, blueprint };
}

/** The small medieval house with its roof raised (`MEDIEVAL_SMALL_HIGH_ROOF`): the real roof is within the eye's reach from the door's level and needs no block to stand on. */
const medievalSmall = withoutSign(MEDIEVAL_SMALL_HIGH_ROOF);
const { classic: _classic, ...medievalShape } = medievalSmall;
/** A house of another family than the shipped ones (Task 6 ships the regional files): the small medieval house's shape under its own name. */
const RONDAVEL: Template = { ...medievalShape, id: "rondavel", family: "africa", name: "rondavel", kind: "rondavel", description: "a round hut" };
const FIXTURES = new Map([...[...TEMPLATES_WITH_HIGH_ROOF].map(([id, template]): [string, Template] => [id, withoutSign(template)]), [RONDAVEL.id, RONDAVEL]]);

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
  assert.deepEqual(places[0]!.house, { template: "rondavel", family: "africa", door: { x: 0, y: 64, z: 2 }, facing: "north", materials: {}, dimension: "minecraft:overworld" });
});

test("a build stops between stages for materials and goes on at the next stage when they are carried", async () => {
  const runtime = new FakeRuntime();
  standingWith(runtime, FLOOR_BILL);
  const building: { unfinished: UnfinishedHouse | null } = { unfinished: null };
  const context = contextFor(runtime, { building });
  const first = await runStep(rondavel(), context);
  assert.equal(first.status, "done");
  assert.match(detailOf(first), /^stages 1-1 of \d+ of the rondavel are built .*: the walls \(stage 2\) needs .*: fetch exactly the missing items with get_items, then \{"skill":"build","template":"rondavel","x":0,"y":64,"z":2\} again to go on; or choose another house \(\{"skill":"abandon_house"\} gives this one up\)$/u);
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

test("a new house's stage-1 refusal names the other ways (materials, another house), and the step it gives builds the floor once its blocks are carried", async () => {
  const runtime = new FakeRuntime();
  standingWith(runtime, []);
  const building: { unfinished: UnfinishedHouse | null } = { unfinished: null };
  const context = contextFor(runtime, { building });
  const refused = await runStep(rondavel(), context);
  assert.equal(refused.status, "failed");
  assert.match(detailOf(refused), /^missing .* for stage 1 of 4 \(floor\) of a rondavel .*; or build that stage from blocks you carry with "materials", or choose another house$/u);
  assert.deepEqual(builds(runtime), [], "nothing was built");
  // The next action from it: the step the refusal gives, as the model would send it, with the floor's blocks carried.
  const given = /\{"skill":"build"[^}]*\}/u.exec(detailOf(refused))?.[0] ?? "";
  runtime.snapshot = { ...runtime.snapshot, inventory: FLOOR_BILL };
  const next = await runStep(stepSchema.parse(JSON.parse(given)), context);
  assert.equal(next.status, "done", detailOf(next));
  assert.match(detailOf(next), /^stages 1-1 of 4 of the rondavel are built .*: the walls \(stage 2\) needs/u);
  assert.equal(builds(runtime).length, 1, "the floor is one call");
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
    { name: "half of the walls stand", read: "world", says: /^stages 2-2 of 4 of the rondavel are built .*: the roof \(stage 3\) needs.*; or choose another house \(\{"skill":"abandon_house"\} gives this one up\)$/u },
    { name: "the read fails", read: new Error("the box could not be read"), says: /^missing .* for stage 2 of 4 \(walls\) of a rondavel .*; or choose another house \(\{"skill":"abandon_house"\} gives this one up\)$/u },
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
    else {
      const detail = detailOf(await runStep(rondavel(), context));
      assert.match(detail, says, name);
      assert.doesNotMatch(detail, /materials/u, `${name}: a resumed house ignores the step's materials, so no stop offers them`);
    }
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

const JAPANESE = templateFor("japanese-medium")!;
const FAR_DOOR = { x: -18, y: 76, z: -7 };
const FAR_AWAY = { x: 251.5, y: 62, z: -274.5 };
const asInventory = (bill: readonly { item: string; count: number }[]) => bill.map(({ item, count }) => ({ name: item, count }));
const firstStep = (detail: string) => stepSchema.parse(JSON.parse(/\{"skill":"build"[^}]*\}/u.exec(detail)?.[0] ?? "null"));

/** A medium japanese house whose floor stands at FAR_DOOR (a step that stopped after stage 1: Kenji's), the bot now 380 blocks away carrying `inventory`. */
async function unfinishedFar(runtime: FakeRuntime, extra: Partial<SkillContext> = {}, inventory: BotSnapshot["inventory"] = []) {
  const site = { door: FAR_DOOR, facing: "north" as const };
  const plan = planTemplate(JAPANESE, site);
  runtime.groundTop = FAR_DOOR.y - 1;
  standingWith(runtime, asInventory(plan.stageBill(plan.stages[0]!)));
  runtime.snapshot = { ...runtime.snapshot, position: { x: -17.5, y: 76, z: -8.5 } };
  const building: { unfinished: UnfinishedHouse | null } = { unfinished: null };
  const context = contextFor(runtime, { building, self: "self", ...extra });
  const stopped = await runStep(stepSchema.parse({ skill: "build", template: "japanese-medium" }), context);
  assert.equal(stopped.status, "done", detailOf(stopped));
  const record = building.unfinished!;
  runtime.snapshot = { ...runtime.snapshot, inventory, position: FAR_AWAY };
  runtime.walkOnNavigate = true;
  /** The x of the min corner of every protection box asked so far. */
  const protections = () => runtime.submitted.filter((call) => call.tool === "protect_region").map((call) => (call.input as { min: { x: number } }).min.x);
  return { context, building, stopped, plan, record, protections };
}
/** The kinds the bill holds from stage `stage` on: what a walk to the site keeps (`keep_items`). */
const itemsFrom = (plan: HousePlan, stage: number) => billFrom(plan, plan.stages[stage]!.first).map(({ item }) => item);
const navigations = (runtime: FakeRuntime) => runtime.submitted.filter((call) => call.tool === "navigate").map((call) => call.input);

test("the step a stop gives carries the door: copied 380 blocks away it still resumes that house, no new site", async () => {
  const runtime = new FakeRuntime();
  const { context, building, stopped, plan, protections } = await unfinishedFar(runtime);
  const text = detailOf(stopped);
  assert.match(text, /\{"skill":"build","template":"japanese-medium","x":-18,"y":76,"z":-7\} again to go on/u);
  runtime.snapshot = { ...runtime.snapshot, inventory: asInventory(plan.stageBill(plan.stages[1]!)) };
  const before = protections().length;
  const result = await runStep(firstStep(text), context);
  const stand = builderStand(plan.site);
  assert.deepEqual(navigations(runtime)[0], { x: stand.x, y: stand.y, z: stand.z, range: 1, keep_items: itemsFrom(plan, 1) }, `she walks to the old site herself, keeping the bill: ${detailOf(result)}`);
  assert.deepEqual(building.unfinished?.site.door ?? FAR_DOOR, FAR_DOOR, "the same house: its door unchanged");
  const boxes = protections().slice(before);
  assert.ok(boxes.length > 0 && boxes.every((x) => x < 0), "no protection box at the far place: the old house's box again");
});

test("a far build without coordinates names the unfinished house and its step before anything is replaced; the step it gives resumes that house", async () => {
  const runtime = new FakeRuntime();
  const { context, building, record, plan } = await unfinishedFar(runtime);
  const bare = stepSchema.parse({ skill: "build", template: "japanese-medium" });
  const refused = await runStep(bare, context);
  assert.equal(refused.status, "failed");
  const text = detailOf(refused);
  const newDoor = { x: 251, y: 62, z: -273 };
  assert.ok(text.includes(`this would be a new house here: your unfinished ${JAPANESE.kind} is ${describeWay(newDoor, FAR_DOOR)} (door -18 76 -7), and {"skill":"build","template":"japanese-medium","x":-18,"y":76,"z":-7} goes on with it; a new house here leaves it untracked`), text);
  assert.ok(text.indexOf('"x":-18') < text.indexOf('"x":251'), "the old house's step comes before the new site's");
  assert.match(text, /^missing .* \(the rest is carried\); this would be a new house here: .*: fetch exactly the missing items with get_items, then \{"skill":"build","template":"japanese-medium","x":251,"y":62,"z":-273\} again/u);
  assert.equal(building.unfinished, record, "the old record is not replaced");
  // The next action from it: the step the note gives resumes the old house (the walls' blocks carried).
  runtime.snapshot = { ...runtime.snapshot, inventory: asInventory(plan.stageBill(plan.stages[1]!)) };
  await runStep(firstStep(text), context);
  const stand = builderStand(plan.site);
  assert.deepEqual(navigations(runtime)[0], { x: stand.x, y: stand.y, z: stand.z, range: 1, keep_items: itemsFrom(plan, 1) });
  assert.equal(building.unfinished?.site.door.x ?? FAR_DOOR.x, FAR_DOOR.x, "still the old door");
});

test("a far build with the first stage's blocks carried starts the new house: the choice stays the model's", async () => {
  const runtime = new FakeRuntime();
  const { context, building } = await unfinishedFar(runtime);
  const newPlan = planTemplate(JAPANESE, { door: { x: 251, y: 62, z: -273 }, facing: "north" });
  runtime.groundTop = 61;
  runtime.snapshot = { ...runtime.snapshot, inventory: asInventory(newPlan.stageBill(newPlan.stages[0]!)) };
  const result = await runStep(stepSchema.parse({ skill: "build", template: "japanese-medium" }), context);
  assert.equal(result.status, "done", detailOf(result));
  assert.match(detailOf(result), new RegExp(`your unfinished ${JAPANESE.kind} at -18 76 -7 is no longer tracked$|is no longer tracked; its area #\\d+ stays protected`, "u"));
  assert.equal(building.unfinished?.site.door.x, 251, "the record is the new house's");
});

test("a different template's unfinished house is named too, and a build with no unfinished house adds no note", async () => {
  const runtime = new FakeRuntime();
  const { context } = await unfinishedFar(runtime);
  const other = await runStep(stepSchema.parse({ skill: "build", template: "medieval-small" }), context);
  assert.match(detailOf(other), new RegExp(`this would be a new house here: your unfinished ${JAPANESE.kind} is `, "u"));
  const none = new FakeRuntime();
  standingWith(none, []);
  const plain = await runStep(rondavel(), contextFor(none, { building: { unfinished: null } }));
  assert.equal(plain.status, "failed");
  assert.doesNotMatch(detailOf(plain), /this would be a new house/u);
});

test("a site refusal far from the unfinished house names it before the nearest clear site, unless the refusal is that house's own area", async () => {
  const runtime = new FakeRuntime();
  const { context, record } = await unfinishedFar(runtime);
  const newDoor = { x: 251, y: 62, z: -273 };
  runtime.areas.push({ regionId: 9, owner: "Steve", label: "garden", min: { x: newDoor.x - 4, y: 61, z: newDoor.z - 8 }, max: { x: newDoor.x + 4, y: 70, z: newDoor.z + 4 } });
  const refused = await runStep(stepSchema.parse({ skill: "build", template: "japanese-medium" }), context);
  assert.equal(refused.status, "failed");
  const text = detailOf(refused);
  assert.match(text, /overlaps .*garden.*; this would be a new house here: your unfinished .* a new house here leaves it untracked; the nearest site clear of them/u);
  assert.equal(context.building?.unfinished, record);
  // The unfinished house's own area in the way: described once by its blocker, no second note.
  // (the old house's own protected area is in the fake already: the step that built its floor protected it)
  const own = new FakeRuntime();
  const second = await unfinishedFar(own);
  const near = await runStep(stepSchema.parse({ skill: "build", template: "medieval-small", x: FAR_DOOR.x + 2, y: FAR_DOOR.y, z: FAR_DOOR.z }), second.context);
  assert.equal(near.status, "failed");
  assert.equal(detailOf(near).split("this would be a new house here").length, 1, `no second note: ${detailOf(near)}`);
  assert.match(detailOf(near), /that is your unfinished .* goes on with it/u);
});

test("a site that cannot be reached or prepared ends with the step that tries again", async () => {
  const unreached = new FakeRuntime();
  standingWith(unreached, FLOOR_BILL);
  unreached.failNext.navigate = { error: "no route" };
  const reach = await runStep(stepSchema.parse({ skill: "build", template: "rondavel", x: 5, y: 64, z: 5 }), contextFor(unreached, { building: { unfinished: null } }));
  assert.equal(reach.status, "failed");
  assert.match(detailOf(reach), /^could not reach the site of a rondavel at 5 64 5: no route; \{"skill":"build","template":"rondavel","x":5,"y":64,"z":5\} tries again$/u);
  const unprepared = new FakeRuntime();
  standingWith(unprepared, FLOOR_BILL);
  unprepared.world.set("-4,64,0", "grass_block");
  unprepared.failNext.build_structure = { error: "[BUILD_STOPPED] A fight interrupted the build." };
  const prepare = await runStep(rondavel(), contextFor(unprepared, { building: { unfinished: null } }));
  assert.equal(prepare.status, "failed");
  assert.match(detailOf(prepare), /^could not prepare the site of a rondavel: .*; \{"skill":"build","template":"rondavel","x":0,"y":64,"z":2\} tries again$/u);
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

/** The small medieval house's roof stage at the origin (the raised-roof fixture), and the cells of it the eye cannot reach from the door's level. */
function roofOf(site = { door: { x: 0, y: 64, z: 2 }, facing: "north" as const }) {
  const plan = planTemplate(medievalSmall, site);
  const roof = plan.stages.findIndex((stage) => stage.name === "roof");
  const cells = cellsCountedOnce(plan.batches).slice(plan.stages[roof]!.first, plan.stages[roof]!.last + 1).flat().filter((cell) => cell.block !== "air");
  return { plan, roof, cells, high: cells.filter((cell) => outOfReachFromGround(cell, site.door.y)), low: cells.filter((cell) => !outOfReachFromGround(cell, site.door.y)) };
}

/** The bot stands at the origin with `inventory` and a policy admitting the runtime's default scaffold blocks. */
function standingWithPolicy(runtime: FakeRuntime, inventory: BotSnapshot["inventory"]): void {
  standingWith(runtime, inventory);
  runtime.snapshot = { ...runtime.snapshot, policy: DEFAULT_POLICY };
}
/** The raised roof's stand columns (`MEDIEVAL_SMALL_HIGH_ROOF`): 3 blocks, the busiest roof call's (planned a call at a time, the earlier calls standing: Task 2d), its highest cell 8 above the door. */
const ROOF_DIRT = 3;
const PLANTED = /about 3 blocks to stand on for its cells 8 above the ground \(scaffold the build lays and takes back: one of dirt, cobbled_deepslate, netherrack, basalt, end_stone\)/u;
const medievalStep = () => stepSchema.parse({ skill: "build", template: "medieval-small" });

test("a roof with no block to stand on stops before the roof, not halfway, and names an item short as well", async () => {
  const stopped = new FakeRuntime();
  standingWithPolicy(stopped, SMALL_MEDIEVAL);
  const result = await runStep(medievalStep(), contextFor(stopped, { building: { unfinished: null } }));
  assert.equal(result.status, "done", detailOf(result));
  assert.match(detailOf(result), /^stages 1-2 of 4 of the small medieval house are built .*: the roof \(stage 3\) needs about 3 blocks to stand on/u);
  assert.match(detailOf(result), PLANTED);
  assert.match(detailOf(result), /fetch 3 or more blocks to stand on with get_items, then \{"skill":"build","template":"medieval-small","x":0,"y":64,"z":2\} again to go on/u);
  assert.equal(builds(stopped).length, 4, "the floor and the walls are sent, no call of the roof");
  // An item short as well: both are named, in one list.
  const short = new FakeRuntime();
  standingWithPolicy(short, SMALL_MEDIEVAL.filter((stack) => stack.name !== "spruce_slab"));
  const both = await runStep(medievalStep(), contextFor(short, { building: { unfinished: null } }));
  assert.match(detailOf(both), /the roof \(stage 3\) needs 7 spruce_slab and about 3 blocks to stand on for its cells 8 above the ground/u);
  assert.match(detailOf(both), /fetch exactly the missing items and 3 or more blocks to stand on with get_items, then/u);
});

test("the stop before the roof, the scaffold fetched, the step it gave sends the roof", async () => {
  const runtime = new FakeRuntime();
  standingWithPolicy(runtime, SMALL_MEDIEVAL);
  const building: { unfinished: UnfinishedHouse | null } = { unfinished: null };
  const context = contextFor(runtime, { building });
  const stop = await runStep(medievalStep(), context);
  assert.match(detailOf(stop), PLANTED);
  // The next action from it: get_items brought the counted dirt, then the step the stop gave.
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, { name: "dirt", count: ROOF_DIRT }] };
  const next = await runStep(firstStep(detailOf(stop)), context);
  assert.match(detailOf(next), /^built a small medieval house/u);
  assert.ok(builds(runtime).length > 4, "the roof calls were sent");
});

test("a resumed house whose next stage is the roof fails before it for want of blocks to stand on", async () => {
  const runtime = new FakeRuntime();
  standingWithPolicy(runtime, SMALL_MEDIEVAL);
  const context = contextFor(runtime, { building: { unfinished: null } });
  await runStep(medievalStep(), context);
  const calls = builds(runtime).length;
  const resumed = await runStep(medievalStep(), context);
  assert.equal(resumed.status, "failed");
  assert.match(detailOf(resumed), /^missing about 3 blocks to stand on for its cells 8 above the ground \(scaffold .*\) for stage 3 of 4 \(roof\) of a small medieval house \(the rest is carried\): fetch 3 or more blocks to stand on with get_items, then /u);
  assert.equal(builds(runtime).length, calls, "nothing of the roof was sent");
});

test("a resumed roof whose high cells already stand asks no scaffold: only the cells within reach are left", async () => {
  const runtime = new FakeRuntime();
  standingWithPolicy(runtime, SMALL_MEDIEVAL);
  const context = contextFor(runtime, { building: { unfinished: null } });
  await runStep(medievalStep(), context);
  const { high, low } = roofOf();
  assert.ok(high.length > 0 && low.length > 0, "the fixture: a roof with cells on both sides of the reach");
  for (const cell of high) runtime.world.set(`${cell.x},${cell.y},${cell.z}`, cell.block);
  runtime.snapshot = { ...runtime.snapshot, inventory: billOfMaterials(low).map(({ item, count }) => ({ name: item, count })) };
  const calls = builds(runtime).length;
  const resumed = await runStep(medievalStep(), context);
  assert.doesNotMatch(detailOf(resumed), /stand on/u, detailOf(resumed));
  assert.ok(builds(runtime).length > calls, "the roof calls were sent");
});

/** What a `navigate` of the walks below kept: the names (`keep_items`) and the counts (`reserve_items`). */
interface WalkKept {
  readonly keep: string[];
  readonly reserve: { item: string; count: number }[];
}

/**
 * `navigate` as the runtime answers it with `keep_items` and `reserve_items` (plan 2026-11-12-house-build-fixes Task 0, plan
 * 2026-11-14 Task 4): a walk over a drop lays up to `spend` dirt, but only what it may place (none of a kept name, only the
 * carried above a reserve's count: the fallback scaffold included), and arrives at `stand`. `noPathWhileKept`: the route has
 * no way when the dirt it may place is less than `spend` (`[NAVIGATION_STOPPED]`); `failure`: another failure, whatever is kept.
 */
function walkingOverADrop(runtime: FakeRuntime, stand: { x: number; y: number; z: number }, options: { spend: number; noPathWhileKept?: true; failure?: string }) {
  const kept: WalkKept[] = [];
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    if (tool !== "navigate") return submit(tool, input, ...rest);
    const walk: WalkKept = { keep: (input.keep_items as string[] | undefined) ?? [], reserve: (input.reserve_items as WalkKept["reserve"] | undefined) ?? [] };
    kept.push(walk);
    const reserved = Math.max(0, ...walk.reserve.filter((entry) => entry.item === "dirt").map((entry) => entry.count));
    const placeable = walk.keep.includes("dirt") ? 0 : Math.max(0, carried(runtime, "dirt") - reserved);
    if (options.failure !== undefined) runtime.failNext.navigate = { error: options.failure };
    else if (options.noPathWhileKept === true && placeable < options.spend) runtime.failNext.navigate = { error: "[NAVIGATION_STOPPED] Pathfinder stopped: no path." };
    else {
      runtime.addItem("dirt", -Math.min(options.spend, placeable));
      runtime.snapshot = { ...runtime.snapshot, position: stand };
    }
    return submit(tool, input, ...rest);
  };
  return kept;
}

/** A small medieval house stopped before its roof for want of dirt, the bot then 30 blocks off carrying `dirt` dirt, and the step the stop gave. */
async function roofStoppedFar(runtime: FakeRuntime, dirt: number) {
  standingWithPolicy(runtime, SMALL_MEDIEVAL);
  const context = contextFor(runtime, { building: { unfinished: null } });
  const stop = await runStep(medievalStep(), context);
  assert.match(detailOf(stop), PLANTED);
  runtime.snapshot = { ...runtime.snapshot, position: { x: 30.5, y: 64, z: 0.5 } };
  if (dirt > 0) runtime.addItem("dirt", dirt);
  return { context, step: firstStep(detailOf(stop)), stand: builderStand(roofOf().plan.site) };
}
/** What the bill holds from the roof stage on (the roof and the finish): what a walk resumed at the roof keeps. */
const ROOF_BILL = itemsFrom(roofOf().plan, roofOf().roof);

/** Every admitted kind at the count of the roof's stand columns (`ROOF_DIRT`): what a walk resumed at the roof reserves. */
const ROOF_RESERVE = DEFAULT_POLICY.scaffoldBlocks!.filter((kind) => !ROOF_BILL.includes(kind)).map((item) => ({ item, count: ROOF_DIRT }));

test("a resumed roof walked to with the counted dirt keeps it by count: the roof is sent, and a spare dirt may bridge but never the 3 the roof needs", async () => {
  for (const { dirt, left } of [{ dirt: ROOF_DIRT, left: ROOF_DIRT }, { dirt: ROOF_DIRT + 1, left: ROOF_DIRT }, { dirt: 64, left: 62 }]) {
    const runtime = new FakeRuntime();
    const { context, step, stand } = await roofStoppedFar(runtime, dirt);
    const walks = walkingOverADrop(runtime, stand, { spend: 2 });
    const result = await runStep(step, context);
    assert.match(detailOf(result), /^built a small medieval house/u, `${dirt} dirt`);
    assert.deepEqual(new Set(walks[0]!.keep), new Set(ROOF_BILL), `${dirt} dirt: the bill kept by name, never a scaffold kind`);
    assert.deepEqual(walks[0]!.reserve, ROOF_RESERVE, `${dirt} dirt: every admitted kind reserved at the roof's count`);
    assert.equal(carried(runtime, "dirt"), left, `${dirt} dirt: what reached the roof (4 dirt for a need of 3: the walk spends 1, never 2)`);
  }
});

test("a no-path walk is walked again only when a scaffold block was carried to keep, and never after a stop", async () => {
  // None carried: the second walk would be the same walk.
  const bare = new FakeRuntime();
  standingWithPolicy(bare, SMALL_MEDIEVAL);
  const bareKeeps = walkingOverADrop(bare, builderStand(roofOf().plan.site), { spend: 0, failure: "[NAVIGATION_STOPPED] Pathfinder stopped: no path." });
  const refused = await runStep(stepSchema.parse({ skill: "build", template: "medieval-small", x: 0, y: 64, z: 2 }), contextFor(bare, { building: { unfinished: null } }));
  assert.equal(bareKeeps.length, 1);
  assert.match(detailOf(refused), /^could not reach the site of a small medieval house/u);
  // Dirt carried but the stop signal given during the first walk: no second walk.
  const runtime = new FakeRuntime();
  const { context, step, stand } = await roofStoppedFar(runtime, ROOF_DIRT);
  const controller = new AbortController();
  const keeps = walkingOverADrop(runtime, stand, { spend: 2, noPathWhileKept: true });
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    if (tool === "navigate") controller.abort();
    return submit(tool, input, ...rest);
  };
  const stopped = await runStep(step, { ...context, signal: controller.signal });
  assert.equal(stopped.status, "stopped");
  assert.equal(keeps.length, 1);
});

test("the walk falls back when the reserve leaves no way: the second walk keeps only the bill at its need, and the stop that follows names the count", async () => {
  const runtime = new FakeRuntime();
  const { context, step, stand } = await roofStoppedFar(runtime, ROOF_DIRT);
  const walks = walkingOverADrop(runtime, stand, { spend: 2, noPathWhileKept: true });
  const stopped = await runStep(step, context);
  assert.equal(walks.length, 2, "two walks");
  assert.deepEqual(walks[0]!.reserve, ROOF_RESERVE, "the first walk reserves the roof's dirt");
  assert.deepEqual(walks[1]!.keep, [], "the second walk keeps no name");
  assert.deepEqual(walks[1]!.reserve, billFrom(roofOf().plan, roofOf().plan.stages[roofOf().roof]!.first).map(({ item, count }) => ({ item, count })), "only the bill at its need: no dirt");
  assert.match(detailOf(stopped), PLANTED, "the walk spent 2 of the 3: the stop names the count again (about 3 blocks to stand on)");
  // The next action from it: 4 more dirt, the step it gave builds the roof (5 carried: a spare of 2 over the reserve of 3, the walk's spend).
  runtime.addItem("dirt", ROOF_DIRT + 1);
  const next = await runStep(firstStep(detailOf(stopped)), context);
  assert.match(detailOf(next), /^built a small medieval house/u);
});

test("a walk that fails in deep water is not walked again", async () => {
  const runtime = new FakeRuntime();
  const { context, step, stand } = await roofStoppedFar(runtime, 4);
  const keeps = walkingOverADrop(runtime, stand, { spend: 2, failure: "[NAVIGATION_DEEP_WATER] Deep open water ahead" });
  const result = await runStep(step, context);
  assert.equal(keeps.length, 1);
  assert.equal(result.status, "failed");
  assert.match(detailOf(result), /^could not reach the site of a small medieval house at 0 64 2: \[NAVIGATION_DEEP_WATER\]/u);
});

/**
 * A bot with the small medieval house unfinished at its roof (floor and walls built) 30 blocks off carrying 5 dirt, its `get_items`
 * of gravel (not a bill item) going 150 blocks out to a seen place and back: the walks it makes. The place is `seen`, the bot walks.
 */
async function gravelFetchedFar(runtime: FakeRuntime, context: SkillContext) {
  runtime.walkOnNavigate = true;
  runtime.simulateInventory = true;
  runtime.failNext.collect_block = { error: "[NO_TARGET_IN_RANGE] No gravel block left within 64 blocks of where the run started; none is loaded farther either." };
  runtime.seen = { gravel: { dimension: "overworld", x: 150, z: 8 } };
  const fetched = await runStep({ skill: "get_items", items: [{ item: "gravel", count: 4 }] }, context);
  assert.equal(fetched.status, "done", detailOf(fetched));
  return runtime.submitted.filter((call) => call.tool === "navigate").map((call) => call.input);
}

/** The bill counts of the roof stage on, minus the cells already in `placed` (`x,y,z` keys): what the cells still wrong take. */
function billStillWrong(placed: ReadonlySet<string> = new Set()) {
  const { plan, roof } = roofOf();
  const wrong = cellsCountedOnce(plan.batches).slice(plan.stages[roof]!.first).flat().filter((cell) => cell.block !== "air" && !placed.has(`${cell.x},${cell.y},${cell.z}`));
  return billOfMaterials(wrong).map(({ item, count }) => ({ item, count }));
}

test("a plain get_items with an unfinished house keeps the house's blocks on its walks, out and back", async () => {
  const runtime = new FakeRuntime();
  const { context } = await roofStoppedFar(runtime, 5);
  const walks = await gravelFetchedFar(runtime, context);
  assert.equal(walks.length, 2, "out to the place and back");
  for (const walk of walks) {
    assert.deepEqual(walk.keep_items, ["gravel"], "the fetched item by name, no bill kind by name");
    assert.deepEqual(walk.reserve_items, [...billStillWrong(), ...ROOF_RESERVE], "the bill's still-wrong counts, and every other admitted kind at the roof's count (dirt 5)");
  }
});

test("a half-built stage reserves only its cells still wrong", async () => {
  const runtime = new FakeRuntime();
  const { context } = await roofStoppedFar(runtime, 5);
  // The roof's first 12 cells stand already (the record's part is the roof's first call).
  const standing = roofOf().cells.slice(0, 12);
  for (const cell of standing) runtime.world.set(`${cell.x},${cell.y},${cell.z}`, cell.block);
  const placed = new Set(standing.map((cell) => `${cell.x},${cell.y},${cell.z}`));
  const [first] = await gravelFetchedFar(runtime, context);
  const reserved = first!.reserve_items as { item: string; count: number }[];
  assert.deepEqual(reserved.filter((entry) => !ROOF_RESERVE.some((own) => own.item === entry.item)), billStillWrong(placed), "the bill of the cells not yet placed");
  assert.notDeepEqual(billStillWrong(placed), billStillWrong(), "some cells were standing: the bill is smaller");
});

test("without an unfinished house a get_items keeps what it fetched and nothing else", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "dirt", count: 5 }], policy: DEFAULT_POLICY };
  const walks = await gravelFetchedFar(runtime, contextFor(runtime, { building: { unfinished: null } }));
  assert.equal(walks.length, 2);
  for (const walk of walks) {
    assert.deepEqual(walk.keep_items, ["gravel"]);
    assert.equal(walk.reserve_items, undefined);
  }
});

test("craft_item's walk to a table keeps the house's blocks", async () => {
  const runtime = new FakeRuntime();
  const { context } = await roofStoppedFar(runtime, 5);
  runtime.recipes = { oak_door: { makes: 3, needs: [{ item: "oak_planks", count: 6 }] } };
  runtime.world.set("36,64,3", "crafting_table");
  await runStep({ skill: "craft_item", item: "oak_door", count: 3 }, context);
  const [walk] = runtime.submitted.filter((call) => call.tool === "navigate").map((call) => call.input);
  assert.equal(walk!.x, 36, "the table is walked to");
  assert.equal(walk!.keep_items, undefined, "no name");
  assert.deepEqual(walk!.reserve_items, [...billStillWrong(), ...ROOF_RESERVE]);
});

// Plan 2026-11-14-house-build-fixes-2 Task 11 (live 2026-11-17, Bruno): a fetch that makes the means of the work in hand (a lost
// tool, the table of a craft, the levelling's tools and fill) keeps no bill, but its walks keep the unfinished house's whole scaffold.
const MEANS_RECIPES = {
  oak_planks: { makes: 4, needs: [{ item: "oak_log", count: 1 }] },
  stick: { makes: 4, needs: [{ item: "oak_planks", count: 2 }] },
  crafting_table: { makes: 1, needs: [{ item: "oak_planks", count: 4 }] },
  wooden_pickaxe: { makes: 1, needs: [{ item: "oak_planks", count: 3 }, { item: "stick", count: 2 }] },
  wooden_shovel: { makes: 1, needs: [{ item: "oak_planks", count: 1 }, { item: "stick", count: 2 }] },
  oak_door: { makes: 3, needs: [{ item: "oak_planks", count: 6 }] },
};
const TABLE_AT = { x: 6, z: 3 };
const PICKAXE_LOST = { error: "[TOOL_TIER_LOST] wooden_pickaxe was lost; family: pickaxe; no pickaxe remains." };
const navigatesOf = (runtime: FakeRuntime) => runtime.submitted.filter((call) => call.tool === "navigate").map((call) => call.input);
const walksToTable = (runtime: FakeRuntime) => navigatesOf(runtime).filter((walk) => walk.x === TABLE_AT.x && walk.z === TABLE_AT.z);

/** The small medieval house with a pickaxe lost at the call `lostAt` says (the first one it sees), a spare 10 planks and 10 logs and a table 6 blocks off: the refetch makes the pickaxe at the table. */
async function pickaxeLostWhile(lostAt: (blocks: readonly { x: number; y: number; z: number }[]) => boolean) {
  const runtime = new FakeRuntime();
  runtime.recipes = MEANS_RECIPES;
  runtime.simulateInventory = true;
  standingWithPolicy(runtime, [...SMALL_MEDIEVAL.map((stack) => (stack.name === "oak_planks" || stack.name === "oak_log" ? { ...stack, count: stack.count + 10 } : stack)), { name: "dirt", count: ROOF_DIRT }]);
  runtime.world.set(`${TABLE_AT.x},64,${TABLE_AT.z}`, "crafting_table");
  let lost = false;
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    if (tool === "build_structure" && !lost && lostAt((input as BuildCall).blocks)) {
      lost = true;
      runtime.failNext.build_structure = PICKAXE_LOST;
    }
    return submit(tool, input, ...rest);
  };
  const result = await runStep(medievalStep(), contextFor(runtime, { building: { unfinished: null } }));
  return { runtime, result };
}

test("a tool lost in the floor stage is remade with the roof's scaffold kept by the refetch's walks", async () => {
  const { runtime, result } = await pickaxeLostWhile(() => true);
  assert.match(detailOf(result), /^built a small medieval house/u);
  const walks = walksToTable(runtime);
  assert.ok(walks.length > 0, "the refetch walked to the table");
  for (const walk of walks) assert.deepEqual(walk.reserve_items, ROOF_RESERVE, "the roof's dirt by count, though the floor needs none");
});

test("a tool lost in the roof stage keeps the roof's own remaining count", async () => {
  const roofKeys = new Set(roofOf().cells.map((cell) => `${cell.x},${cell.y},${cell.z}`));
  const { runtime, result } = await pickaxeLostWhile((blocks) => blocks.some((block) => roofKeys.has(`${block.x},${block.y},${block.z}`)));
  assert.match(detailOf(result), /^built a small medieval house/u);
  const walks = walksToTable(runtime);
  assert.ok(walks.length > 0, "the refetch walked to the table");
  for (const walk of walks) assert.deepEqual(walk.reserve_items, ROOF_RESERVE, "the roof's dirt by count (unchanged)");
});

/** The log fetch of a means fetch with nothing to make it from carried: out 150 blocks to a seen place and back (`gravelFetchedFar`'s walks). `house`: an unfinished house at its roof, else none. */
async function bareBotFar(runtime: FakeRuntime, house: boolean): Promise<SkillContext> {
  const context = house ? (await roofStoppedFar(runtime, 5)).context : contextFor(runtime, { building: { unfinished: null } });
  runtime.snapshot = { ...runtime.snapshot, position: { x: 30.5, y: 64, z: 0.5 }, inventory: [{ name: "dirt", count: 5 }], policy: DEFAULT_POLICY };
  runtime.recipes = MEANS_RECIPES;
  runtime.simulateInventory = true;
  runtime.walkOnNavigate = true;
  runtime.seen = { oak_log: { dimension: "overworld", x: 150, z: 8 }, dirt: { dimension: "overworld", x: 150, z: 8 } };
  return { ...context, areas: [] };
}
const noneNear = (block: string) => ({ error: `[NO_TARGET_IN_RANGE] No ${block} block left within 64 blocks of where the run started; none is loaded farther either.` });

/** The walks of the table fetch of a craft whose table is not carried. */
async function tableFetchWalks(house: boolean) {
  const runtime = new FakeRuntime();
  const context = await bareBotFar(runtime, house);
  runtime.failNext.craft_item = { error: "[WORKSTATION_NOT_CARRIED] crafting_table is not carried" };
  runtime.failNext.collect_block = noneNear("oak_log");
  const result = await runStep({ skill: "craft_item", item: "oak_door", count: 3 }, context);
  assert.equal(result.status, "done", detailOf(result));
  return navigatesOf(runtime);
}

/** The walks of the levelling a bot makes 30 blocks from its house: `tools` (a shovel to make, for a grass block to dig) or `fill` (a hole to fill, the fill fetched). */
async function levelingFetchWalks(house: boolean, fetch: "tools" | "fill") {
  const runtime = new FakeRuntime();
  const context = await bareBotFar(runtime, house);
  runtime.world.set("20,64,20", "gold_block");
  runtime.world.set("24,64,23", "gold_block");
  if (fetch === "tools") runtime.world.set("22,64,21", "grass_block");
  else runtime.world.set("22,63,21", "air");
  runtime.snapshot = { ...runtime.snapshot, inventory: [] };
  runtime.failNext.collect_block = noneNear(fetch === "tools" ? "oak_log" : "dirt");
  const result = await runStep(stepSchema.parse({ skill: "level_area", markers: "gold_block" }), context);
  assert.equal(result.status, "done", detailOf(result));
  return navigatesOf(runtime);
}

/** The walk to a table of the levelling's tool refetch: a shovel lost on the way, a table 3 blocks from where the bot stands. */
async function levelingToolLossWalks(house: boolean) {
  const runtime = new FakeRuntime();
  const context = await bareBotFar(runtime, house);
  runtime.world.set("20,64,20", "gold_block");
  runtime.world.set("24,64,23", "gold_block");
  runtime.world.set("22,64,21", "grass_block");
  runtime.world.set("33,64,3", "crafting_table");
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_shovel", count: 1 }, { name: "oak_planks", count: 8 }] };
  runtime.failNext.build_structure = { error: "[TOOL_TIER_LOST] wooden_shovel was lost at 22,64,21; family: shovel; no shovel remains.", effect: () => runtime.addItem("wooden_shovel", -1) };
  const result = await runStep(stepSchema.parse({ skill: "level_area", markers: "gold_block" }), context);
  assert.equal(result.status, "done", detailOf(result));
  return navigatesOf(runtime).filter((walk) => walk.x === 33 && walk.z === 3);
}

test("craft_item's table fetch keeps the unfinished house's scaffold on its walks, and no bill", async () => {
  const walks = await tableFetchWalks(true);
  assert.ok(walks.length >= 2, "out to the seen log and back");
  for (const walk of walks) assert.deepEqual(walk.reserve_items, ROOF_RESERVE, "the roof's dirt by count; the means fetch keeps no bill");
});

test("a levelling fetch (its tools, its hole fill) keeps the unfinished house's scaffold on its walks", async () => {
  // The house is on record from its first dig (skills.ts: `leaveUnfinished(0, false)` before `prepareSite`), so a build's own levelling is in this case too.
  for (const fetch of ["tools", "fill"] as const) {
    const walks = await levelingFetchWalks(true, fetch);
    assert.ok(walks.length >= 2, `${fetch}: out to the seen block and back`);
    for (const walk of walks) assert.deepEqual(walk.reserve_items, ROOF_RESERVE, `${fetch}: the roof's dirt by count`);
  }
  // The tool lost while levelling is made again by the same kind of fetch.
  const toTable = await levelingToolLossWalks(true);
  assert.ok(toTable.length > 0, "tool loss: the refetch walked to the table");
  for (const walk of toTable) assert.deepEqual(walk.reserve_items, ROOF_RESERVE, "tool loss: the roof's dirt by count");
});

test("with no unfinished house the means fetches send no reserve_items", async () => {
  for (const walks of [await tableFetchWalks(false), await levelingFetchWalks(false, "tools"), await levelingFetchWalks(false, "fill"), await levelingToolLossWalks(false)]) {
    assert.ok(walks.length >= 1, "walked");
    for (const walk of walks) assert.equal(walk.reserve_items, undefined);
  }
});

test("a resumed roof already standing keeps no scaffold: only the bill", async () => {
  const runtime = new FakeRuntime();
  const { context, step, stand } = await roofStoppedFar(runtime, 0);
  const { high, plan, roof } = roofOf();
  for (const cell of high) runtime.world.set(`${cell.x},${cell.y},${cell.z}`, cell.block);
  runtime.snapshot = { ...runtime.snapshot, inventory: billFrom(plan, plan.stages[roof]!.first).map(({ item, count }) => ({ name: item, count })) };
  const walks = walkingOverADrop(runtime, stand, { spend: 2 });
  const result = await runStep(step, context);
  assert.match(detailOf(result), /^built a small medieval house/u);
  assert.deepEqual(new Set(walks[0]!.keep), new Set(ROOF_BILL), "the roof's bill, and no scaffold kind");
  assert.deepEqual(walks[0]!.reserve, [], "no scaffold reserve");
});

test("a new house's walk keeps its bill by name, and reserves the admitted kinds at the count while a later stage is out of reach (none carried: nothing to keep)", async () => {
  const runtime = new FakeRuntime();
  standingWithPolicy(runtime, SMALL_MEDIEVAL);
  const stand = builderStand(roofOf().plan.site);
  const walks = walkingOverADrop(runtime, stand, { spend: 2 });
  await runStep(stepSchema.parse({ skill: "build", template: "medieval-small", x: 0, y: 64, z: 2 }), contextFor(runtime, { building: { unfinished: null } }));
  assert.deepEqual(new Set(walks[0]!.keep), new Set(roofOf().plan.bill.map(({ item }) => item)));
  assert.deepEqual(walks[0]!.reserve, ROOF_RESERVE);
});

type BuildCall = { blocks: { x: number; y: number; z: number; block_name: string }[]; reserve_items?: { item: string; count: number }[] };
const buildCalls = (runtime: FakeRuntime) => runtime.submitted.filter((call) => call.tool === "build_structure").map((call) => call.input as BuildCall);
/** The calls placing a block of `cells` (a call of the final check holds them too, with no reserve). */
const callsHolding = (calls: readonly BuildCall[], cells: readonly { x: number; y: number; z: number }[]) => {
  const keys = new Set(cells.map((cell) => `${cell.x},${cell.y},${cell.z}`));
  return calls.filter((call) => call.blocks.some((block) => block.block_name !== "air" && keys.has(`${block.x},${block.y},${block.z}`)));
};

test("the walls' calls reserve the roof's scaffold; the roof's own calls reserve none (plan 2026-11-14 Task 7b)", async () => {
  const runtime = new FakeRuntime();
  standingWithPolicy(runtime, [...SMALL_MEDIEVAL, { name: "dirt", count: ROOF_DIRT }]);
  const result = await runStep(medievalStep(), contextFor(runtime, { building: { unfinished: null } }));
  assert.match(detailOf(result), /^built a small medieval house/u);
  const { plan, cells: roofCells } = roofOf();
  const calls = buildCalls(runtime);
  const walls = callsHolding(calls, stageCellsOf(plan, "walls")).filter((call) => call.reserve_items !== undefined);
  assert.ok(walls.length > 0, "a walls call carries the reserve");
  for (const call of calls.filter((entry) => entry.reserve_items !== undefined)) assert.deepEqual(call.reserve_items, ROOF_RESERVE, "every kind the roof stands on, at its count (dirt 5)");
  assert.deepEqual(callsHolding(calls, roofCells).filter((call) => call.reserve_items !== undefined), [], "no roof call, no call of the final check");
});

/** The cells (not air) of the stage named `name`. */
const stageCellsOf = (plan: HousePlan, name: string) => cellsCountedOnce(plan.batches).slice(plan.stages.find((stage) => stage.name === name)!.first, plan.stages.find((stage) => stage.name === name)!.last + 1).flat().filter((cell) => cell.block !== "air");

test("a stage that needs scaffold itself sends no reserve (the saltbox's roof stands past the eye's reach; its next stage's check says what is short)", async () => {
  const saltbox = withoutSign(templateFor("saltbox")!);
  const site = { door: { x: 0, y: 64, z: 2 }, facing: "north" as const };
  const plan = planTemplate(saltbox, site);
  const runtime = new FakeRuntime();
  standingWithPolicy(runtime, [...billFrom(plan, 0).map(({ item, count }) => ({ name: item, count })), { name: "dirt", count: 64 }]);
  await runStep(stepSchema.parse({ skill: "build", template: "saltbox" }), contextFor(runtime, { building: { unfinished: null }, templates: new Map([...TEMPLATES, [saltbox.id, saltbox]]) }));
  const calls = buildCalls(runtime);
  const roof = stageCellsOf(plan, "roof");
  const high = roof.filter((cell) => outOfReachFromGround(cell, site.door.y));
  assert.ok(high.length > 0, "the saltbox's roof holds cells the eye cannot reach from the door's level");
  assert.deepEqual(callsHolding(calls, high).filter((call) => call.reserve_items !== undefined), [], "the roof's calls: no reserve, they lay their own scaffold");
  assert.ok(calls.some((call) => call.reserve_items !== undefined), "a stage before them does reserve (the control)");
});

/** A `build_structure` answer that did not finish: `left` the audit's groups, `error` its text. */
const unfinishedBuild = (error: string, left: unknown[]) => ({ error, result: { status: "failed", error, structure: { placed: 0, dug: 0, wrong: 1, left, missing: [] } } });
const NO_ROUTE_REFUSED = [{ reason: "refused", count: 1, named: [{ x: 1, y: 64, z: 1, detail: "no path", cause: "route" }] }];
const ROUTE_STOP = [{ reason: "not_reached", count: 1, named: [{ x: 1, y: 64, z: 1 }] }];

test("a call refused or stopped for want of a route with the reserve is sent again once without it, and the roof's check then names the count", async () => {
  for (const { name, failure } of [
    { name: "refused for a route", failure: unfinishedBuild("[BUILD_INCOMPLETE] 1 cell still wrong: 1 were refused (1,64,1: no path).", NO_ROUTE_REFUSED) },
    { name: "stopped on a route", failure: unfinishedBuild("[BUILD_STOPPED] The build stopped: 2 passes changed nothing; last route stopped.", ROUTE_STOP) },
  ]) {
    const runtime = new FakeRuntime();
    standingWithPolicy(runtime, [...SMALL_MEDIEVAL, { name: "dirt", count: ROOF_DIRT }]);
    // The call sent without the reserve spends 3 of the dirt on its route (what the reserve was keeping).
    const submit = runtime.submit.bind(runtime);
    runtime.submit = async (tool, input, ...rest) => {
      if (tool === "build_structure" && (input as BuildCall).reserve_items === undefined) runtime.snapshot = { ...runtime.snapshot, inventory: runtime.snapshot.inventory.map((stack) => (stack.name === "dirt" ? { ...stack, count: ROOF_DIRT - 3 } : stack)) };
      return submit(tool, input, ...rest);
    };
    runtime.failNext.build_structure = failure;
    const result = await runStep(medievalStep(), contextFor(runtime, { building: { unfinished: null } }));
    const [first, second, third] = buildCalls(runtime);
    assert.deepEqual(first!.reserve_items, ROOF_RESERVE, `${name}: the first call carries the reserve`);
    assert.equal(second!.reserve_items, undefined, `${name}: sent again without it`);
    assert.deepEqual(second!.blocks, first!.blocks, `${name}: the same cells`);
    assert.deepEqual(third!.reserve_items, ROOF_RESERVE, `${name}: the next call reserves again (once per call)`);
    assert.match(detailOf(result), PLANTED, `${name}: the stage went on, and the roof's check says the count`);
  }
});

test("a call that fails for another reason with the reserve is not sent again", async () => {
  const runtime = new FakeRuntime();
  standingWithPolicy(runtime, [...SMALL_MEDIEVAL, { name: "dirt", count: ROOF_DIRT }]);
  runtime.failNext.build_structure = unfinishedBuild("[BUILD_INCOMPLETE] 1 cell still wrong: 1 were refused (1,64,1: cow stands in the cell).", [{ reason: "refused", count: 1, named: [{ x: 1, y: 64, z: 1, detail: "cow stands in the cell", cause: "entity" }] }]);
  const result = await runStep(medievalStep(), contextFor(runtime, { building: { unfinished: null } }));
  assert.equal(result.status, "failed");
  assert.equal(buildCalls(runtime).length, 1, "one call: no second try for a stop that is no want of a route");
});

test("the model's go_to with an unfinished house keeps its blocks, and is walked once more without the scaffold when that leaves no path (open choice 4)", async () => {
  const runtime = new FakeRuntime();
  const { context } = await roofStoppedFar(runtime, ROOF_DIRT);
  const walks = walkingOverADrop(runtime, builderStand(roofOf().plan.site), { spend: 2, noPathWhileKept: true });
  const result = await runStep(stepSchema.parse({ skill: "go_to", x: 30, y: 64, z: 3 }), context);
  assert.equal(result.status, "done", detailOf(result));
  assert.equal(walks.length, 2, "the keep left no path: one more walk");
  assert.deepEqual(walks[0]!.reserve, [...billStillWrong(), ...ROOF_RESERVE], "the bill still wrong and the roof's dirt");
  assert.deepEqual(walks[0]!.keep, [], "no name");
  assert.ok(!walks[1]!.reserve.some((entry: { item: string }) => entry.item === "dirt"), "the second walk may bridge with the dirt");
});

test("the model's explore with an unfinished house keeps its blocks on every leg", async () => {
  const runtime = new FakeRuntime();
  const { context } = await roofStoppedFar(runtime, 5);
  runtime.walkOnNavigate = true;
  runtime.explored = new Set([...Array.from({ length: 20 }, (_, i) => `${i},0`), ...Array.from({ length: 40 }, (_, i) => `0,${-i}`)]);
  await runStep(stepSchema.parse({ skill: "explore", toward: "east", chunks: 1 }), context);
  const legs = runtime.submitted.filter((call) => call.tool === "navigate").map((call) => call.input);
  assert.ok(legs.length > 0, "the bot walked");
  for (const leg of legs) assert.deepEqual(leg.reserve_items, [...billStillWrong(), ...ROOF_RESERVE]);
});

test("a go_to and an explore with no unfinished house keep nothing", async () => {
  const runtime = new FakeRuntime();
  runtime.walkOnNavigate = true;
  runtime.explored = new Set(Array.from({ length: 20 }, (_, i) => `${i},0`));
  const context = contextFor(runtime, { building: { unfinished: null } });
  await runStep(stepSchema.parse({ skill: "go_to", x: 5, y: 64, z: 5 }), context);
  await runStep(stepSchema.parse({ skill: "explore", toward: "east", chunks: 1 }), context);
  const walks = runtime.submitted.filter((call) => call.tool === "navigate").map((call) => call.input);
  assert.ok(walks.length >= 2);
  for (const walk of walks) assert.deepEqual([walk.keep_items, walk.reserve_items], [undefined, undefined]);
});

/** A runtime carrying 26 oak_log (the walls take `billLogs`) and a table, crafting planks from logs, the logs near. */
function carryingLogs(): FakeRuntime {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.recipes = { oak_planks: { makes: 4, needs: [{ item: "oak_log", count: 1 }] } };
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: [{ name: "oak_log", count: 26 }, { name: "crafting_table", count: 1 }] };
  return runtime;
}
const UNFINISHED_FROM_START = { kind: "small medieval house", template: "medieval-small", site: { door: { x: 0, y: 64, z: 2 }, facing: "north" as const }, part: 0, prepared: true, materials: {} };
const planksAsked = stepSchema.parse({ skill: "get_items", items: [{ item: "oak_planks", count: 18 }] });

test("the get_items step passes the unfinished house's bill as reserve: the logs its walls take are fetched again before the planks use them (plan 2026-11-14 Task 8)", async () => {
  const runtime = carryingLogs();
  const billLogs = billFrom(roofOf().plan, 0).find((entry) => entry.item === "oak_log")!.count;
  assert.ok(billLogs > 21 && billLogs <= 26, `the bill takes ${billLogs} logs: 5 of the 26 for 18 planks would leave 21`);
  const result = await runStep(planksAsked, contextFor(runtime, { building: { unfinished: UNFINISHED_FROM_START } }));
  assert.equal(result.status, "done", detailOf(result));
  assert.ok(carried(runtime, "oak_log") >= billLogs, `logs carried after: ${carried(runtime, "oak_log")}, the bill takes ${billLogs}`);
  const tools = runtime.submitted.map((call) => call.tool);
  assert.ok(tools.indexOf("collect_block") >= 0 && tools.indexOf("collect_block") < tools.indexOf("craft_item"), `the logs are fetched before the planks are crafted: ${tools.join(", ")}`);
});

test("without an unfinished house the get_items step keeps no raw item: the logs are crafting stock", async () => {
  const runtime = carryingLogs();
  const result = await runStep(planksAsked, contextFor(runtime, { building: { unfinished: null } }));
  assert.equal(result.status, "done", detailOf(result));
  assert.equal(carried(runtime, "oak_log"), 21);
  assert.ok(!runtime.submitted.some((call) => call.tool === "collect_block"), "nothing fetched");
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

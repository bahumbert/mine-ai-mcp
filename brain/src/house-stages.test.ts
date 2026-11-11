// `build` by template and stage (plan 2026-11-09-house-templates Task 4b): a house is built stage after stage, a stage only
// when its blocks are carried, and the step that stops between stages is gone on with by the same step again.
import assert from "node:assert/strict";
import test from "node:test";
import { stepSchema } from "./actions.ts";
import { Body } from "./body.ts";
import { billOfMaterials, cellsCountedOnce } from "./building/blueprint.ts";
import { houseBox } from "./building/house-site.ts";
import { builderStand, planTemplate } from "./building/plan.ts";
import { describeWay } from "./gathering.ts";
import { TEMPLATES, templateFor, type Template } from "./building/templates.ts";
import type { KnownPlace } from "./mind.ts";
import { BodyDown, type BotSnapshot } from "./runtime-client.ts";
import { runStep, type SkillContext, type UnfinishedHouse } from "./skills.ts";
import { DEFAULT_POLICY, FakeRuntime, SMALL_MEDIEVAL_HOUSE as SMALL_MEDIEVAL } from "./testing.ts";

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
  assert.match(detailOf(first), /^stages 1-1 of \d+ of the rondavel are built .*: the walls \(stage 2\) needs .*: fetch exactly those with get_items, then \{"skill":"build","template":"rondavel","x":0,"y":64,"z":2\} again to go on; or choose another house \(\{"skill":"abandon_house"\} gives this one up\)$/u);
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
  assert.deepEqual(navigations(runtime)[0], { x: stand.x, y: stand.y, z: stand.z, range: 1 }, `she walks to the old site herself: ${detailOf(result)}`);
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
  assert.deepEqual(navigations(runtime)[0], { x: stand.x, y: stand.y, z: stand.z, range: 1 });
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

/** The small medieval house's roof stage at the origin, and the cells of it BUILD_REACH or more above the door. */
function roofOf(site = { door: { x: 0, y: 64, z: 2 }, facing: "north" as const }) {
  const plan = planTemplate(medievalSmall, site);
  const roof = plan.stages.findIndex((stage) => stage.name === "roof");
  const cells = cellsCountedOnce(plan.batches).slice(plan.stages[roof]!.first, plan.stages[roof]!.last + 1).flat().filter((cell) => cell.block !== "air");
  return { plan, roof, cells, high: cells.filter((cell) => cell.y - site.door.y >= 4), low: cells.filter((cell) => cell.y - site.door.y < 4) };
}

/** The bot stands at the origin with `inventory` and a policy admitting the runtime's default scaffold blocks. */
function standingWithPolicy(runtime: FakeRuntime, inventory: BotSnapshot["inventory"]): void {
  standingWith(runtime, inventory);
  runtime.snapshot = { ...runtime.snapshot, policy: DEFAULT_POLICY };
}
const PLANTED = /about 3 blocks to stand on for its cells 5 above the ground \(scaffold the build lays and takes back: one of dirt, cobbled_deepslate, netherrack, basalt, end_stone\)/u;
const medievalStep = () => stepSchema.parse({ skill: "build", template: "medieval-small" });

test("a roof with no block to stand on stops before the roof, not halfway, and names an item short as well", async () => {
  const stopped = new FakeRuntime();
  standingWithPolicy(stopped, SMALL_MEDIEVAL);
  const result = await runStep(medievalStep(), contextFor(stopped, { building: { unfinished: null } }));
  assert.equal(result.status, "done", detailOf(result));
  assert.match(detailOf(result), /^stages 1-2 of 4 of the small medieval house are built .*: the roof \(stage 3\) needs about 3 blocks to stand on/u);
  assert.match(detailOf(result), PLANTED);
  assert.match(detailOf(result), /fetch exactly those with get_items, then \{"skill":"build","template":"medieval-small","x":0,"y":64,"z":2\} again to go on/u);
  assert.equal(builds(stopped).length, 4, "the floor and the walls are sent, no call of the roof");
  // An item short as well: both are named, in one list.
  const short = new FakeRuntime();
  standingWithPolicy(short, SMALL_MEDIEVAL.filter((stack) => stack.name !== "spruce_slab"));
  const both = await runStep(medievalStep(), contextFor(short, { building: { unfinished: null } }));
  assert.match(detailOf(both), /the roof \(stage 3\) needs 7 spruce_slab and about 3 blocks to stand on for its cells 5 above the ground/u);
});

test("the stop before the roof, the scaffold fetched, the step it gave sends the roof", async () => {
  const runtime = new FakeRuntime();
  standingWithPolicy(runtime, SMALL_MEDIEVAL);
  const building: { unfinished: UnfinishedHouse | null } = { unfinished: null };
  const context = contextFor(runtime, { building });
  const stop = await runStep(medievalStep(), context);
  assert.match(detailOf(stop), PLANTED);
  // The next action from it: get_items brought 3 dirt, then the step the stop gave.
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, { name: "dirt", count: 3 }] };
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
  assert.match(detailOf(resumed), /^missing about 3 blocks to stand on for its cells 5 above the ground \(scaffold .*\) for stage 3 of 4 \(roof\) of a small medieval house \(the rest is carried\): fetch exactly the missing items with get_items, then /u);
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

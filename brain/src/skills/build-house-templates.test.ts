// Building a house from a template: the default house, the first stage's shortfall, resuming by stage, the record kept at once, and the trades' owed blocks.
import assert from "node:assert/strict";
import test from "node:test";
import { stepSchema } from "../actions.ts";
import { runStep, type SkillContext, type UnfinishedHouse } from "../skills.ts";
import { resumeStep } from "../building/templates.ts";
import { listHouses } from "./list-houses.ts";
import { catalogueLine } from "../building/plan.ts";
import { TEMPLATES, templateFor, type Template } from "../building/templates.ts";
import { type BotSnapshot } from "../runtime-client.ts";
import type { KnownPlace } from "../mind.ts";
import { FakeRuntime, SMALL_MEDIEVAL_HOUSE as SMALL_MEDIEVAL } from "../testing.ts";
import { bodyDownError, builds, contextFor, MEDIEVAL_SMALL_RECORD, ownAreaAround, STEVE_IN_OVERWORLD } from "./skill-fixtures.test.ts";

const owedSlabs = (count: number) => [{ item: "spruce_slab", count, partner: "Ayla", tradeId: "t1" }];

/** The `nth` (1-based) `build_structure` call of the runtime throws `error`, as a runtime that dies under the call does; the others go on. */
function dieOnBuildCall(runtime: FakeRuntime, nth: number, error: Error): void {
  const submit = runtime.submit.bind(runtime);
  let calls = 0;
  runtime.submit = async (tool, input, ...rest) => {
    if (tool === "build_structure" && (calls += 1) === nth) throw error;
    return submit(tool, input, ...rest);
  };
}

const bodyRestartedError = () => new Error("[BODY_RESTARTED] the body restarted: build_structure was not done");

const SMALL_HOUSE_STEP = { skill: "build", structure: "house", size: "small" } as const;

/** What the record of a small medieval house names besides its site, part and materials: its template and its first stage (the plan cuts it into 4). */
const LEVELED_SITE_TOOLS = [...SMALL_MEDIEVAL, { name: "wooden_shovel", count: 1 }];

/** A build whose records are kept, so a test sees what `saveBuilding` was asked to save, in order, with what the other events were. */
function recordingContext(runtime: FakeRuntime, extra: Partial<SkillContext> = {}) {
  const building: { unfinished: UnfinishedHouse | null } = { unfinished: null };
  const saved: (UnfinishedHouse | null)[] = [];
  const events: string[] = [];
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    if (tool === "build_structure") events.push(`build_structure@${String(building.unfinished?.prepared)}`);
    return submit(tool, input, ...rest);
  };
  const saveBuilding = () => {
    saved.push(building.unfinished === null ? null : { ...building.unfinished });
    events.push(`save prepared=${String(building.unfinished?.prepared)}`);
  };
  const context = contextFor(runtime, { style: "medieval", building, saveBuilding, ...extra });
  return { building, saved, events, context };
}

function standingBy(runtime: FakeRuntime, inventory: BotSnapshot["inventory"] = SMALL_MEDIEVAL): void {
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory };
}

/** A site with a tree-like cell to dig, so the leveling is one `build_structure` call before the parts, and Steve to face. */
function sitePlantedWithGrass(runtime: FakeRuntime): void {
  standingBy(runtime, LEVELED_SITE_TOOLS);
  runtime.world.set("-4,64,0", "grass_block");
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Steve", position: { x: 8, y: 64, z: 1 } }] };
}

const levelingCalls = (runtime: FakeRuntime) => builds(runtime).filter((call) => call.blocks.length === 1 && call.blocks[0]!.block_name === "air" && call.blocks[0]!.x === -4).length;

test("a build step with no template and no size is the persona's small house; the style is always the persona's, never the model's", () => {
  // The small is the build skill's: the schema keeps size absent so that a template and a size can be told apart.
  assert.deepEqual(stepSchema.parse({ skill: "build" }), { skill: "build", structure: "house" });
  assert.equal(stepSchema.safeParse({ skill: "build", style: "japanese" }).success, false);
  assert.equal(stepSchema.safeParse({ skill: "build", structure: "castle" }).success, false);
});

test("list_houses shows a family's houses: done at once, no body call, the catalogue lines as the detail", async () => {
  const runtime = new FakeRuntime();
  const result = await runStep(stepSchema.parse({ skill: "list_houses", family: "east-asia" }), contextFor(runtime));
  assert.equal(result.status, "done");
  const detail = result.status === "done" ? result.detail : "";
  const eastAsia = [...TEMPLATES.values()].filter((template) => template.family === "east-asia");
  assert.ok(eastAsia.length >= 2, "the classic japanese houses at least");
  assert.equal(detail, eastAsia.map((template) => `${catalogueLine(template)}: {"skill":"build","template":"${template.id}"}`).join("\n"), "the registry's order: its files by name, each line ending with the step that builds it");
  for (const line of detail.split("\n")) assert.ok(stepSchema.safeParse(JSON.parse(line.slice(line.lastIndexOf(': {"skill"') + 2))).success, `${line}: its step parses`);
  assert.doesNotMatch(detail, /^built/u, "a result starting with built counts as a house in the run analysis");
  assert.deepEqual(runtime.submitted, [], "no call to the body");
  // a fixture registry: its family's lines, and the known families named for an unknown one
  const rondavel: Template = { ...templateFor("japanese-small")!, id: "rondavel", family: "africa", name: "rondavel", kind: "rondavel", description: "Round hut." };
  const templates = new Map([["rondavel", rondavel]]);
  const found = listHouses({ skill: "list_houses", family: "africa" }, templates);
  assert.equal(found.status === "done" && found.detail, `${catalogueLine(rondavel)}: {"skill":"build","template":"rondavel"}`);
  // The character's own family is read the same way: the build line names only its ids, the details come from here.
  const medievalSmall = templateFor("medieval-small")!;
  const own = listHouses({ skill: "list_houses", family: "europe" });
  assert.ok(own.status === "done" && own.detail.includes(`${catalogueLine(medievalSmall)}: {"skill":"build","template":"medieval-small"}`), "the own family's lines, each with its step");
  const unknown = listHouses({ skill: "list_houses", family: "atlantis" }, templates);
  assert.equal(unknown.status, "failed");
  assert.match(unknown.status === "failed" ? unknown.detail : "", /no houses of the family "atlantis";the families you know: africa/u);
});

test("the step that resumes an unfinished house names its template and its door, an old note's template by its kind", () => {
  const site = { door: { x: 4, y: 70, z: -9 } };
  assert.equal(resumeStep({ kind: "rondavel", template: "rondavel", site }), '{"skill":"build","template":"rondavel","x":4,"y":70,"z":-9}', "the record's own id: recall dropped the ones whose template is gone");
  assert.equal(resumeStep({ kind: "small medieval house", site }), '{"skill":"build","template":"medieval-small","x":4,"y":70,"z":-9}');
  assert.equal(resumeStep({ kind: "gone house", site }), '{"skill":"abandon_house"}', "a house nobody knows how to finish can only be given up");
  assert.deepEqual(stepSchema.parse(JSON.parse(resumeStep({ kind: "rondavel", template: "rondavel", site }))), { skill: "build", structure: "house", template: "rondavel", x: 4, y: 70, z: -9 }, "the model's step parses with its coordinates");
});

test("a house without the blocks of its first stage is refused with the exact shortfall, before any block is touched", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 30 }, { name: "cobblestone", count: 4 }] };
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval" }));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /^missing 11 cobblestone for stage 1 of 4 \(floor\) of a small medieval house \(the rest is carried\): fetch exactly the missing items with get_items, then \{"skill":"build","template":"medieval-small","x":0,"y":64,"z":2\} again; or build that stage from blocks you carry with "materials", or choose another house$/u);
  assert.equal(runtime.submitted.length, 0);
});

test("an unfinished house goes on from the first part of its stage and is checked again part by part at the end, so what was dug out since is put back", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  const building = { unfinished: null };
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    if (tool === "build_structure" && builds(runtime).length === 2) runtime.failNext.build_structure = { error: "[BUILD_INCOMPLETE] 1 cell still wrong" };
    return submit(tool, input, ...rest);
  };
  const context = contextFor(runtime, { style: "medieval", building });
  const first = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.match(first.status === "failed" ? first.detail : "", /stopped at part 3\/\d+/u);
  const second = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.equal(second.status, "done");
  const calls = builds(runtime);
  // The third part of nine is in the walls stage (parts 2-4): the floor stage is not built again, the walls are, from their first part.
  assert.deepEqual(calls[3]!.blocks, calls[1]!.blocks, "the second build starts again at the first part of its stage");
  assert.ok(calls.slice(11).some((call) => JSON.stringify(call.blocks) === JSON.stringify(calls[0]!.blocks)), "the final check sends the floor again");
});

test("a missing material names only what is missing, as the get_items step to take, when the stage that needs it comes", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: SMALL_MEDIEVAL.filter((stack) => stack.name !== "spruce_slab") };
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval" }));
  assert.deepEqual(result, { status: "done", detail: "stages 1-2 of 4 of the small medieval house are built (door at 0 64 2): the roof (stage 3) needs 7 spruce_slab: fetch exactly the missing items with get_items, then {\"skill\":\"build\",\"template\":\"medieval-small\",\"x\":0,\"y\":64,\"z\":2} again to go on; or choose another house ({\"skill\":\"abandon_house\"} gives this one up)" });
});

test("a build whose bill blocks are owed to a trade stops before the stage that needs them, with the owed count", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: SMALL_MEDIEVAL };
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval", owed: () => owedSlabs(7) }));
  assert.deepEqual(result, { status: "done", detail: "stages 1-2 of 4 of the small medieval house are built (door at 0 64 2): the roof (stage 3) needs 7 spruce_slab (7 spruce_slab you carry are owed: 7 spruce_slab to Ayla (trade)): fetch exactly the missing items with get_items, then {\"skill\":\"build\",\"template\":\"medieval-small\",\"x\":0,\"y\":64,\"z\":2} again to go on; or choose another house ({\"skill\":\"abandon_house\"} gives this one up)" });
  assert.equal(runtime.submitted.filter((call) => call.tool === "build_structure").length, 4, "the floor and the walls were built, not the roof");
  const free = new FakeRuntime();
  free.snapshot = { ...free.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: [...SMALL_MEDIEVAL, { name: "spruce_slab", count: 7 }] };
  assert.equal((await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(free, { style: "medieval", owed: () => owedSlabs(7) }))).status, "done", "7 more carried than the bill: the owed ones stay and the house is built");
});

test("a body that dies mid-part keeps the unfinished house, saved after it is set, and the next build resumes it", async () => {
  for (const error of [bodyDownError, bodyRestartedError]) {
    const runtime = new FakeRuntime();
    standingBy(runtime);
    dieOnBuildCall(runtime, 2, error());
    const { building, saved, context } = recordingContext(runtime, { self: "self" });
    await assert.rejects(runStep(SMALL_HOUSE_STEP, context), (thrown: unknown) => thrown instanceof Error && thrown.message.includes("RUNTIME_UNRESPONSIVE") === (error === bodyDownError));
    const { site, ...record } = building.unfinished ?? ({} as UnfinishedHouse);
    assert.deepEqual(record, { ...MEDIEVAL_SMALL_RECORD, stage: 1, stageName: "walls", part: 1, prepared: true, materials: {}, owner: "self", dimension: "minecraft:overworld" });
    assert.ok(site !== undefined, "with its site");
    assert.deepEqual(saved.at(-1), building.unfinished, "the saved record is the one the throw left");
    // The next action from that state: no overlap with her own half-built house (run 17b), parts from the first, wrong blocks removed.
    const before = builds(runtime).length;
    const second = await runStep(SMALL_HOUSE_STEP, context);
    assert.equal(second.status, "done", second.status === "failed" ? second.detail : "");
    const calls = builds(runtime);
    assert.deepEqual(calls[before]!.blocks, calls[1]!.blocks, "the parts start again from the first part of the stage that was cut (the floor stage stands)");
    assert.ok(calls.slice(before).every((call) => call.remove_wrong_blocks), "wrong blocks are removed");
    assert.equal(building.unfinished, null);
    assert.equal(saved.at(-1), null, "the finished house is saved as no unfinished house at once, not only after the step");
  }
});

test("a body down after leveling never levels again", async () => {
  const runtime = new FakeRuntime();
  sitePlantedWithGrass(runtime);
  dieOnBuildCall(runtime, 2, bodyDownError());
  const { saved, events, context } = recordingContext(runtime, { requester: "steve" });
  await assert.rejects(runStep(SMALL_HOUSE_STEP, context));
  assert.equal(events[0], "save prepared=false", "a new house is saved, unprepared, before the first dig");
  const prepared = events.indexOf("save prepared=true");
  assert.ok(prepared >= 0, "saved as prepared once the leveling was done");
  assert.ok(events.indexOf("build_structure@false") < prepared && prepared < events.lastIndexOf("build_structure@true"), "after the leveling call, before the first part");
  assert.equal(saved.at(-1)?.prepared, true);
  assert.equal(levelingCalls(runtime), 1);
  const again = await runStep(SMALL_HOUSE_STEP, context);
  assert.equal(again.status, "done", again.status === "failed" ? again.detail : "");
  assert.equal(levelingCalls(runtime), 1, "the second build makes no leveling call");
});

test("a body that dies while leveling keeps the house, unprepared, and its protected area", async () => {
  const runtime = new FakeRuntime();
  sitePlantedWithGrass(runtime);
  dieOnBuildCall(runtime, 1, bodyDownError());
  const { building, context } = recordingContext(runtime, { requester: "steve" });
  await assert.rejects(runStep(SMALL_HOUSE_STEP, context));
  assert.deepEqual(building.unfinished, { ...MEDIEVAL_SMALL_RECORD, site: { door: { x: -2, y: 64, z: 0 }, facing: "east" }, part: 0, prepared: false, materials: {}, ...STEVE_IN_OVERWORLD });
  assert.ok(runtime.areas.some((area) => area.label === "small medieval house"), "the house's area is not released");
});

test("an own area in the way of a new house is named as the unfinished or the finished house it holds", async () => {
  const door = { x: 10, y: 64, z: 10 };
  const place: KnownPlace = { name: "the small medieval house you built", detail: "door 10 64 10 facing east", house: { size: "small", style: "medieval", door, facing: "east", materials: {} } };
  const unfinished = { kind: "small medieval house", site: { door, facing: "east" as const }, part: 1, prepared: true, materials: {} };
  const cases = [
    { name: "unfinished", building: { unfinished }, places: [] as KnownPlace[], says: [/that is your unfinished small medieval house \(area #5/u, /\{"skill":"build","template":"medieval-small","x":10,"y":64,"z":10\} goes on with it/u, /abandon_house/u, /door at 10 64 10/u], never: /this would be a new house here/u },
    { name: "finished", building: { unfinished: null }, places: [place], says: [/your small medieval house, door at 10 64 10/u, /build somewhere else/u], never: /unfinished|this would be a new house here/u },
  ];
  for (const { name, building, places, says, never } of cases) {
    const runtime = new FakeRuntime();
    standingBy(runtime);
    ownAreaAround(runtime, 5, "small medieval house", door);
    const result = await runStep(stepSchema.parse({ skill: "build", size: "medium", x: 13, y: 64, z: 10 }), contextFor(runtime, { style: "medieval", building, self: "self", places: () => places }));
    const detail = result.status === "failed" ? result.detail : "";
    for (const pattern of says) assert.match(detail, pattern, name);
    if (never !== null) assert.doesNotMatch(detail, never, name);
  }
});

test("a stale leveling region of mine is released by the next leveling", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_shovel", count: 1 }] };
  runtime.world.set("1,64,1", "dirt");
  runtime.areas.push({ regionId: 7, owner: "self", label: "leveling 14x14", min: { x: -4, y: 56, z: -4 }, max: { x: 9, y: 70, z: 9 } });
  await runStep(stepSchema.parse({ skill: "level_area", x1: 0, z1: 0, x2: 5, z2: 5, y: 64 }), contextFor(runtime, { self: "self" }));
  const released = runtime.submitted.filter((call) => call.tool === "unprotect_region").map((call) => call.input.region_id);
  assert.ok(released.includes(7), "the stale region is released");
  assert.ok(runtime.submitted.findIndex((call) => call.tool === "unprotect_region" && call.input.region_id === 7) < runtime.submitted.findIndex((call) => call.tool === "build_structure"), "before the leveling digs");
});

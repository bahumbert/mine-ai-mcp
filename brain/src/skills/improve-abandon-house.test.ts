// improve_house and abandon_house on a template house.
import assert from "node:assert/strict";
import test from "node:test";
import { stepSchema } from "../actions.ts";
import { runStep, type UnfinishedHouse } from "../skills.ts";
import { templateFor, type Template } from "../building/templates.ts";
import { BodyDown } from "../runtime-client.ts";
import type { KnownPlace } from "../mind.ts";
import { DEFAULT_POLICY, FakeRuntime, SMALL_MEDIEVAL_HOUSE as SMALL_MEDIEVAL, TEMPLATES_WITH_HIGH_ROOF } from "../testing.ts";
import { bodyDownError, builds, contextFor, ownAreaAround } from "./skill-fixtures.test.ts";

/** A small medieval house at door 0 64 2 facing north, temporary in wall and roof, as `build` remembers it. */
const TEMPORARY_HOUSE: KnownPlace = {
  name: "the small medieval house you built",
  detail: "door 0 64 2 facing north; stand on its roof at 0 70 0",
  own: true,
  house: { size: "small", style: "medieval", door: { x: 0, y: 64, z: 2 }, facing: "north", materials: { wall: "dirt", roof: "dirt" } },
};

/** A house the context's registry holds and the shipped one does not: the swap must read the template through the context. */
const TEST_HUT: Template = { ...templateFor("japanese-small")!, id: "test-hut", family: "test", name: "test hut", kind: "test hut", description: "A hut of the test registry." };

const HUT_DOOR = { x: 0, y: 64, z: 2 };

/** An unfinished house at door 0 64 2, with its record and the area it protects; `leaves` counts the saves. */
function unfinishedAt(kind: string, template?: string): { building: { unfinished: UnfinishedHouse | null }; leaves: { count: number } } {
  const unfinished: UnfinishedHouse = { kind, ...(template !== undefined && { template }), site: { door: HUT_DOOR, facing: "north" }, part: 2, prepared: true, materials: {} };
  return { building: { unfinished }, leaves: { count: 0 } };
}

test("improving the roof stops for want of blocks to stand on when its cells are out of reach, and goes on once they are carried", async () => {
  const roofStep = { skill: "improve_house" as const, roles: ["roof" as const] };
  // The roof's blocks only: the cobblestone of the rest of the bill would be a block to stand on here, the bill being the roof's.
  const roofBlocks = SMALL_MEDIEVAL.filter((stack) => stack.name.startsWith("spruce"));
  const bare = new FakeRuntime();
  bare.snapshot = { ...bare.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: roofBlocks, policy: DEFAULT_POLICY };
  // The raised-roof fixture: the real roof is within the eye's reach from the door's level and asks no block to stand on.
  const refused = await runStep(roofStep, contextFor(bare, { style: "medieval", ownHouse: () => TEMPORARY_HOUSE, templates: TEMPLATES_WITH_HIGH_ROOF }));
  assert.equal(refused.status, "failed");
  assert.match(refused.status === "failed" ? refused.detail : "", /^missing about 3 blocks to stand on for its cells 8 above the ground \(scaffold the build lays and takes back: one of dirt, .*\) to improve your small medieval house \(the rest is carried\): fetch 3 or more blocks to stand on with get_items, then improve again$/u);
  assert.equal(bare.submitted.length, 0, "nothing was sent");
  const carrying = new FakeRuntime();
  carrying.snapshot = { ...carrying.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: [...roofBlocks, { name: "dirt", count: 5 }], policy: DEFAULT_POLICY };
  const done = await runStep(roofStep, contextFor(carrying, { style: "medieval", ownHouse: () => TEMPORARY_HOUSE, templates: TEMPLATES_WITH_HIGH_ROOF }));
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.ok(builds(carrying).length > 0, "the roof calls were sent");
});

test("improve_house keeps its bill and the roof's scaffold on its walk to the house", async () => {
  const roofBlocks = SMALL_MEDIEVAL.filter((stack) => stack.name.startsWith("spruce"));
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 30.5, y: 64, z: 0.5 }, inventory: [...roofBlocks, { name: "dirt", count: 5 }], policy: DEFAULT_POLICY };
  const done = await runStep({ skill: "improve_house" as const, roles: ["roof" as const] }, contextFor(runtime, { style: "medieval", ownHouse: () => TEMPORARY_HOUSE, templates: TEMPLATES_WITH_HIGH_ROOF }));
  assert.equal(done.status, "done", JSON.stringify(done));
  const walks = runtime.submitted.filter((call) => call.tool === "navigate");
  assert.equal(walks.length, 1);
  const keep = walks[0]!.input.keep_items as string[];
  assert.ok(keep.includes("spruce_slab"), `the bill's kinds (${keep.join(", ")})`);
  // Plan 2026-11-14 Task 6: the scaffold is kept by count (the raised roof's stand columns: 3), not by name.
  assert.deepEqual(walks[0]!.input.reserve_items, DEFAULT_POLICY.scaffoldBlocks!.map((item) => ({ item, count: 3 })), "every admitted kind at the roof's count of 3");
  assert.ok(DEFAULT_POLICY.scaffoldBlocks!.every((kind) => !keep.includes(kind)), "no admitted kind is kept by name");
});

test("improve_house swaps a house's temporary parts for its own template's blocks: a template of the context's registry, an old classic note", async () => {
  const classicWall = templateFor("rustic-small")!.palette.wall!;
  for (const { name, kind, house, templates, wall } of [
    { name: "a template house", kind: "test hut", house: { template: "test-hut", family: "test" }, templates: new Map([["test-hut", TEST_HUT]]), wall: TEST_HUT.palette.wall! },
    { name: "an old classic note (size and style, no template)", kind: "small rustic house", house: { size: "small" as const, style: "rustic" }, templates: undefined, wall: classicWall },
  ]) {
    const runtime = new FakeRuntime();
    runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: [{ name: wall, count: 400 }] };
    const place: KnownPlace = { name: `the ${kind} you built`, detail: "door 0 64 2 facing north; stand on its roof at 0 70 0", own: true, house: { ...house, door: HUT_DOOR, facing: "north", materials: { wall: "dirt" } } };
    const places: KnownPlace[] = [];
    const result = await runStep({ skill: "improve_house" }, contextFor(runtime, { ...(templates !== undefined && { templates }), ownHouse: () => place, remember: (next) => places.push(next) }));
    assert.deepEqual(result, { status: "done", detail: `improved your ${kind}: wall now ${wall}` }, name);
    assert.ok(builds(runtime).flatMap((call) => call.blocks.map((cell) => cell.block_name)).includes(wall), `${name}: the template's wall block is sent`);
    assert.deepEqual(places.at(-1)!.house, { ...house, door: HUT_DOOR, facing: "north", materials: {} }, `${name}: the record keeps how the house is known and has no temporary part left`);
  }
});

test("improve_house on a house whose template is gone fails, saying its temporary parts stay, and sends nothing", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: SMALL_MEDIEVAL };
  const place: KnownPlace = { name: "the gone hut you built", detail: "door 0 64 2 facing north; stand on its roof at 0 70 0", own: true, house: { template: "gone-hut", family: "test", door: HUT_DOOR, facing: "north", materials: { wall: "dirt" } } };
  const result = await runStep({ skill: "improve_house" }, contextFor(runtime, { ownHouse: () => place }));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /^the gone hut you built is no longer a house you know how to build: its temporary parts stay as they are$/u);
  assert.equal(runtime.submitted.length, 0);
});

test("abandon_house forgets the house and releases its areas, and only hers: the house region and a stale leveling region over it", async () => {
  for (const { name, kind, template } of [{ name: "a classic house of an old note", kind: "small medieval house", template: undefined }, { name: "a house whose template is gone", kind: "gone hut", template: "gone-hut" }]) {
    const runtime = new FakeRuntime();
    ownAreaAround(runtime, 5, kind, HUT_DOOR);
    runtime.areas.push({ regionId: 7, owner: "self", label: "leveling 9x9", min: { x: -6, y: 56, z: -4 }, max: { x: 6, y: 70, z: 8 } });
    runtime.areas.push({ regionId: 8, owner: "self", label: "farm", min: { x: 40, y: 60, z: 40 }, max: { x: 48, y: 70, z: 48 } });
    runtime.areas.push({ regionId: 9, owner: "Tom", label: kind, min: { x: -3, y: 63, z: -1 }, max: { x: 3, y: 72, z: 5 } });
    const { building, leaves } = unfinishedAt(kind, template);
    const result = await runStep({ skill: "abandon_house" }, contextFor(runtime, { self: "self", building, saveBuilding: () => { leaves.count += 1; } }));
    assert.equal(result.status, "done", `${name}: ${JSON.stringify(result)}`);
    assert.match(result.status === "done" ? result.detail : "", new RegExp(`^gave up your unfinished ${kind} at 0 64 2: it is no longer tracked and its areas #5, #7 are released; what stands stays$`, "u"), name);
    assert.deepEqual(runtime.submitted.filter((call) => call.tool === "unprotect_region").map((call) => call.input.region_id), [7, 5], `${name}: the leveling region first, so a retry still finds it through the house region`);
    assert.deepEqual(runtime.areas.map((area) => area.regionId), [8, 9], `${name}: another area of hers and Tom's stay`);
    assert.equal(building.unfinished, null, name);
    assert.equal(leaves.count, 1, `${name}: the empty record is saved`);
  }
});

test("abandon_house without an unfinished house fails and touches nothing", async () => {
  const runtime = new FakeRuntime();
  ownAreaAround(runtime, 5, "small medieval house", HUT_DOOR);
  for (const building of [{ unfinished: null as UnfinishedHouse | null }, undefined]) {
    const result = await runStep({ skill: "abandon_house" }, contextFor(runtime, { self: "self", ...(building !== undefined && { building }) }));
    assert.deepEqual(result, { status: "failed", detail: "you have no unfinished house to give up" });
  }
  assert.deepEqual(runtime.submitted, []);
  assert.equal(runtime.areas.length, 1, "a finished house's area is not an unfinished house's");
});

test("abandon_house that is cut short keeps the record, and the same step again releases what is left, the leveling region included", async () => {
  // Each case: which call goes wrong on the first ask (the retry has the runtime back).
  for (const { name, breaks, says } of [
    { name: "the house region cannot be released", breaks: "unprotectRegion:5", says: /could not release area #5: \[REGION_BUSY\] try later; your unfinished small medieval house is still on record: abandon_house again/u },
    { name: "the leveling region cannot be released", breaks: "unprotectRegion:7", says: /could not release area #7: \[REGION_BUSY\] try later/u },
    { name: "the body is down when the areas are read", breaks: "protectedRegions", says: null },
  ]) {
    const runtime = new FakeRuntime();
    ownAreaAround(runtime, 5, "small medieval house", HUT_DOOR);
    runtime.areas.push({ regionId: 7, owner: "self", label: "leveling 9x9", min: { x: -6, y: 56, z: -4 }, max: { x: 6, y: 70, z: 8 } });
    const unprotect = runtime.unprotectRegion.bind(runtime);
    const regions = runtime.protectedRegions.bind(runtime);
    let broken = true;
    runtime.unprotectRegion = async (regionId) => (broken && breaks === `unprotectRegion:${regionId}` ? { status: "failed", error: "[REGION_BUSY] try later" } : unprotect(regionId));
    runtime.protectedRegions = async () => { if (broken && breaks === "protectedRegions") throw bodyDownError(); return regions(); };
    const { building, leaves } = unfinishedAt("small medieval house");
    const context = contextFor(runtime, { self: "self", building, saveBuilding: () => { leaves.count += 1; } });
    if (says === null) await assert.rejects(runStep({ skill: "abandon_house" }, context), (thrown: unknown) => thrown instanceof BodyDown, name);
    else {
      const first = await runStep({ skill: "abandon_house" }, context);
      assert.equal(first.status, "failed", name);
      assert.match(first.status === "failed" ? first.detail : "", says, name);
    }
    assert.notEqual(building.unfinished, null, `${name}: the record stays`);
    assert.equal(leaves.count, 0, `${name}: nothing saved`);
    broken = false;
    assert.equal((await runStep({ skill: "abandon_house" }, context)).status, "done", name);
    assert.deepEqual(runtime.areas, [], `${name}: no area of the house is left behind`);
    assert.equal(building.unfinished, null, name);
  }
});

test("after abandon_house a new house goes up on the same site: its area is free and nothing says an old house is lost", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  ownAreaAround(runtime, 5, "small medieval house", HUT_DOOR);
  const { building } = unfinishedAt("small medieval house", "medieval-small");
  const context = contextFor(runtime, { style: "medieval", self: "self", building });
  assert.equal((await runStep({ skill: "abandon_house" }, context)).status, "done");
  const result = await runStep(stepSchema.parse({ skill: "build", template: "medieval-small" }), context);
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.doesNotMatch(result.status === "done" ? result.detail : "", /no longer tracked/u);
});

test("improving a house with its blocks owed fails with the owed count", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 10 }] };
  const owed = [{ item: "oak_planks", count: 10, partner: "Ayla", tradeId: "t1" }];
  const result = await runStep({ skill: "improve_house", roles: ["wall"] }, contextFor(runtime, { style: "medieval", ownHouse: () => TEMPORARY_HOUSE, owed: () => owed }));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /^missing \d+ oak_planks to improve your small medieval house \(the rest is carried; 10 oak_planks you carry are owed: 10 oak_planks to Ayla \(trade\)\): fetch exactly/u);
  assert.equal(runtime.submitted.length, 0);
});

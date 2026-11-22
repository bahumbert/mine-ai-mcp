// Tests of the build and improve_house skills: bills, batches, unfinished houses, refused cells and sites.
import assert from "node:assert/strict";
import test from "node:test";
import { describeStep, stepSchema } from "../actions.ts";
import { runStep, type UnfinishedHouse } from "../skills.ts";
import { houseBox } from "../building/house-site.ts";
import type { ProtectedArea } from "../runtime-client.ts";
import type { KnownPlace } from "../mind.ts";
import { FakeRuntime, SMALL_MEDIEVAL_HOUSE as SMALL_MEDIEVAL } from "../testing.ts";
import { contextFor, GLASS_RECIPES, MEDIEVAL_SMALL_RECORD, SIGNED_TEMPLATES, STEVE_IN_OVERWORLD, builds, refusedBuild } from "./skill-fixtures.test.ts";

/** A small medieval house at door 0 64 2 facing north, temporary in wall and roof, as `build` remembers it. */
const TEMPORARY_HOUSE: KnownPlace = {
  name: "the small medieval house you built",
  detail: "door 0 64 2 facing north; stand on its roof at 0 70 0",
  own: true,
  house: { size: "small", style: "medieval", door: { x: 0, y: 64, z: 2 }, facing: "north", materials: { wall: "dirt", roof: "dirt" } },
};

const OAK_ROOF = { roof: { stairs: "oak_stairs", slab: "oak_slab" } };
const OAK_BILL = [...SMALL_MEDIEVAL.filter((stack) => !["spruce_stairs", "spruce_slab"].includes(stack.name)), { name: "oak_stairs", count: 42 }, { name: "oak_slab", count: 7 }];

test("a roof of another wood is built with its stairs and can then be improved", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: OAK_BILL };
  const places: KnownPlace[] = [];
  const context = contextFor(runtime, { style: "medieval", ownHouse: () => places.at(-1) ?? null, remember: (next) => places.push(next) });
  const result = await runStep({ skill: "build", structure: "house", size: "small", materials: { roof: "oak_planks" }, own: true }, context);
  assert.equal(result.status, "done", JSON.stringify(result));
  const blocks = builds(runtime).flatMap((call) => call.blocks);
  assert.ok(blocks.some((cell) => cell.block_name === "oak_stairs" && cell.facing !== undefined));
  assert.ok(blocks.some((cell) => cell.block_name === "oak_slab"));
  assert.ok(blocks.every((cell) => !cell.block_name.startsWith("spruce_")));
  assert.deepEqual(places.at(-1)?.house?.materials, { roof: "oak_planks" });
  assert.deepEqual(places.at(-1)?.house?.shapes, OAK_ROOF);
  runtime.submitted.length = 0;
  runtime.snapshot = { ...runtime.snapshot, inventory: SMALL_MEDIEVAL };
  const improved = await runStep({ skill: "improve_house", roles: ["roof"] }, context);
  assert.equal(improved.status, "done", JSON.stringify(improved));
  assert.ok(builds(runtime).some((call) => call.blocks.some((cell) => cell.block_name === "spruce_stairs")));
  assert.deepEqual(places.at(-1)?.house?.materials, {});
});

test("an interrupted house goes on from the first part of its stage and keeps its saved materials and shapes despite a conflicting resume choice", async () => {
  for (const row of [
    { materials: {}, inventory: SMALL_MEDIEVAL, shapes: undefined, next: undefined, block: "spruce_stairs" },
    { materials: { roof: "oak_planks" }, inventory: OAK_BILL, shapes: OAK_ROOF, next: { roof: "dirt" }, block: "oak_stairs" },
    { materials: { roof: "dirt" }, inventory: [...SMALL_MEDIEVAL, { name: "dirt", count: 300 }], shapes: undefined, next: { roof: "cobblestone" }, block: "dirt" },
  ]) {
    const runtime = new FakeRuntime();
    runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: row.inventory };
    const building: { unfinished: UnfinishedHouse | null } = { unfinished: null };
    const submit = runtime.submit.bind(runtime);
    runtime.submit = async (tool, input, ...rest) => {
      if (tool === "build_structure" && builds(runtime).length === 2) runtime.failNext.build_structure = { error: "[BUILD_INCOMPLETE] 1 cell still wrong" };
      return submit(tool, input, ...rest);
    };
    const context = contextFor(runtime, { style: "medieval", building });
    const first = await runStep({ skill: "build", structure: "house", size: "small", materials: row.materials }, context);
    assert.match(first.status === "failed" ? first.detail : "", /stopped at part 3\/\d+/u);
    assert.deepEqual(building.unfinished?.materials, row.materials);
    assert.deepEqual(building.unfinished?.shapes, row.shapes);
    const sentBefore = builds(runtime).map((call) => call.blocks);
    runtime.submitted.length = 0;
    runtime.submit = submit;
    const second = await runStep({ skill: "build", structure: "house", size: "small", materials: row.next }, context);
    assert.equal(second.status, "done", JSON.stringify(second));
    assert.ok(sentBefore.some((part) => JSON.stringify(part) === JSON.stringify(builds(runtime)[0]!.blocks)), "the resume goes on from the first part of its stage, a part sent before");
    const blocks = builds(runtime).flatMap((call) => call.blocks.map((cell) => cell.block_name));
    assert.ok(blocks.includes(row.block));
    if (row.next !== undefined) assert.ok(!blocks.includes("spruce_stairs"));
    assert.equal(building.unfinished, null);
  }
});

test("a pre-a3 unfinished house resumes with full blocks", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [...SMALL_MEDIEVAL, { name: "oak_planks", count: 49 }] };
  const building = { unfinished: { kind: "small medieval house", site: { door: { x: 0, y: 64, z: 2 }, facing: "north" as const }, part: 2, prepared: true, materials: { roof: "oak_planks" } } };
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval", building }));
  assert.equal(result.status, "done", JSON.stringify(result));
  const blocks = builds(runtime).flatMap((call) => call.blocks);
  assert.ok(blocks.some((cell) => cell.block_name === "oak_planks" && cell.y > 67));
  assert.ok(blocks.every((cell) => !["oak_stairs", "oak_slab", "spruce_stairs", "spruce_slab"].includes(cell.block_name)));
});

test("a build names the substitute items a stage still misses, as the fetch step, before touching its blocks", async () => {
  // The roof of another wood asks its own stairs and slabs (the shipped template's are spruce): named at the stage that holds them.
  const inventory = [...SMALL_MEDIEVAL.filter((stack) => !["spruce_stairs", "spruce_slab"].includes(stack.name)), { name: "oak_planks", count: 49 }];
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory };
  const result = await runStep({ skill: "build", structure: "house", size: "small", materials: { roof: "oak_planks" } }, contextFor(runtime, { style: "medieval" }));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.match(result.status === "done" ? result.detail : "", /the walls \(stage 2\) needs 14 oak_stairs: fetch exactly the missing items with get_items, then \{"skill":"build"/u);
  assert.ok(builds(runtime).length > 0 && builds(runtime).length < 4, "only the first stage's parts were sent");
});

test("a house is built behind the bot in batches facing the requester, the door hung last", async () => {
  const places: KnownPlace[] = [];
  const runtime = new FakeRuntime();
  runtime.snapshot = {
    ...runtime.snapshot,
    position: { x: 0.5, y: 64, z: 0.5 },
    inventory: SMALL_MEDIEVAL,
    players: [{ username: "Steve", position: { x: 8, y: 64, z: 1 } }],
  };
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { requester: "steve", style: "unknown-style", templates: SIGNED_TEMPLATES, remember: (place) => places.push(place) }));
  assert.equal(result.status, "done");
  assert.match(result.status === "done" ? result.detail : "", /^built a small medieval house, door at -2 64 0 facing east; no claim sign yet:/u);
  // The gable ridge runs across the door's axis, two blocks behind it; its centre is straight behind the door.
  assert.deepEqual(places, [{ name: "the small medieval house you built for steve", detail: "door -2 64 0 facing east; stand on its roof at -4 70 0", house: { size: "small", style: "medieval", door: { x: -2, y: 64, z: 0 }, facing: "east", materials: {}, owner: "steve", dimension: "minecraft:overworld" } }]);
  const calls = builds(runtime);
  assert.ok(calls.length > 2);
  assert.ok(calls.every((call) => call.remove_wrong_blocks && call.blocks.length <= 256));
  // Hung from the doorstep, facing into the house, so it swings along the doorway.
  assert.deepEqual(calls.at(-1)!.blocks.at(-1), { x: -2, y: 64, z: 0, block_name: "oak_door", facing: "west" });
  assert.deepEqual(calls.at(-1)!.blocks.at(0), { x: -2, y: 63, z: 0, block_name: "cobblestone" }, "with the block it stands on");
  assert.ok(calls.slice(0, -1).flatMap((call) => call.blocks).every((cell) => cell.x <= -1), "the house stands behind the bot, away from Steve");
});

test("a batch that does not finish stops the build and says where", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: SMALL_MEDIEVAL };
  runtime.failures.build_structure = "3 cells left: nothing_to_place_against";
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval" }));
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /^a small medieval house stopped at part 1\/\d+: 3 cells left: nothing_to_place_against$/);
  assert.equal(builds(runtime).length, 1);
});

test("building again resumes an unfinished house at the same site and part, without asking for the whole bill", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  const building = { unfinished: null };
  runtime.failNext.build_structure = { error: "[BUILD_INCOMPLETE] 1 cell still wrong" };
  const context = contextFor(runtime, { style: "medieval", building });
  const first = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.match(first.status === "failed" ? first.detail : "", /stopped at part 1\/\d+: .*; \{"skill":"build","template":"medieval-small","x":-?\d+,"y":64,"z":-?\d+\} resumes it$/u);
  // Back near the site (get_items walks back to where it started), it resumes there.
  // The stage it stopped in is billed again (nothing of it stands in the fake world): the blocks are carried.
  runtime.snapshot = { ...runtime.snapshot, position: { x: 3.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  const second = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.equal(second.status, "done");
  const calls = builds(runtime);
  assert.deepEqual(calls[1]!.blocks, calls[0]!.blocks, "the refused part is built again where it was");
  assert.equal(building.unfinished, null);
});

test("one refused cell keeps the unfinished house and records the cell (run 13 review R1: a transient refusal forgot the house)", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  const building = { unfinished: null as UnfinishedHouse | null };
  runtime.failNext.build_structure = refusedBuild([{ x: 1, y: 64, z: 1, detail: "route timed out" }]);
  const first = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval", building }));
  const detail = first.status === "failed" ? first.detail : "";
  assert.match(detail, /"template":"medieval-small","x":-?\d+,"y":64,"z":-?\d+\} resumes it$/u);
  assert.doesNotMatch(detail, /build somewhere else/u);
  assert.ok(building.unfinished !== null, "the house is kept");
  assert.deepEqual(building.unfinished.refused, [{ x: 1, y: 64, z: 1 }], "with the cell that was refused");
  // Resumed, the cell is built this time: the house is done (the stage it stopped in is billed again: its blocks are carried).
  runtime.snapshot = { ...runtime.snapshot, inventory: SMALL_MEDIEVAL };
  assert.equal((await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval", building }))).status, "done");
  assert.equal(building.unfinished, null);
});

test("a cell refused again on the resume gives the house up (live 2026-10-14: Oskar, four times)", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  const building = { unfinished: null as UnfinishedHouse | null };
  const refusal = refusedBuild([{ x: 1, y: 64, z: 1, detail: "crafting_table there could not be cleared: movement policy prohibits breaking this block" }]);
  runtime.failNext.build_structure = refusal;
  const context = contextFor(runtime, { style: "medieval", building });
  await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.ok(building.unfinished !== null);
  runtime.failNext.build_structure = refusal;
  const second = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  const detail = second.status === "failed" ? second.detail : "";
  assert.doesNotMatch(detail, /\} resumes it$/u);
  assert.match(detail, /would be refused at the same cell: build somewhere else/u);
  assert.equal(building.unfinished, null, "the site is given up, so the next build picks another");
});

test("a different cell refused on the resume keeps the house, and remembers only the latest refusals", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  const building = { unfinished: null as UnfinishedHouse | null };
  const context = contextFor(runtime, { style: "medieval", building });
  runtime.failNext.build_structure = refusedBuild([{ x: 1, y: 64, z: 1, detail: "no route" }]);
  await runStep({ skill: "build", structure: "house", size: "small" }, context);
  runtime.failNext.build_structure = refusedBuild([{ x: 2, y: 64, z: 1, detail: "no route" }]);
  await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.deepEqual(building.unfinished?.refused, [{ x: 2, y: 64, z: 1 }]);
});

test("an entity standing in the cell does not give the house up", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  const building = { unfinished: null as UnfinishedHouse | null };
  const context = contextFor(runtime, { style: "medieval", building });
  runtime.failNext.build_structure = {
    error: "[BUILD_INCOMPLETE] 1 cell still wrong: 1 were refused (1,64,1: cow stands in the cell).",
    result: refusedBuild([{ x: 1, y: 64, z: 1, detail: "cow stands in the cell", cause: "entity" }]).result,
  };
  const first = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.match(first.status === "failed" ? first.detail : "", /"template":"medieval-small","x":-?\d+,"y":64,"z":-?\d+\} resumes it$/u);
  assert.ok(building.unfinished !== null);
  // The bot itself in the cell is not a refusal at all.
  runtime.failNext.build_structure = {
    error: "[BUILD_INCOMPLETE] 1 cell still wrong: 1 are where the bot stands (1,64,1).",
    result: { status: "failed", error: "x", structure: { placed: 0, dug: 0, wrong: 1, left: [{ reason: "bot_stands_in_it", count: 1, named: [{ x: 1, y: 64, z: 1 }] }], missing: [] } },
  };
  await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.ok(building.unfinished !== null);
});

test("the same entity in the cell twice keeps the house; the same policy refusal twice gives it up (run 14 review SF1)", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  const building = { unfinished: null as UnfinishedHouse | null };
  const context = contextFor(runtime, { style: "medieval", building });
  const cow = refusedBuild([{ x: 1, y: 64, z: 1, detail: "cow stands in the cell", cause: "entity" }]);
  for (const _ of [1, 2]) {
    runtime.failNext.build_structure = cow;
    const detail = await runStep({ skill: "build", structure: "house", size: "small" }, context).then((result) => (result.status === "failed" ? result.detail : ""));
    assert.match(detail, /"template":"medieval-small","x":-?\d+,"y":64,"z":-?\d+\} resumes it$/u);
    assert.ok(building.unfinished !== null, "kept after the entity refusal");
  }
  for (const cause of ["route", "placement"]) {
    runtime.failNext.build_structure = refusedBuild([{ x: 1, y: 64, z: 1, detail: "x", cause }]);
    await runStep({ skill: "build", structure: "house", size: "small" }, context);
    runtime.failNext.build_structure = refusedBuild([{ x: 1, y: 64, z: 1, detail: "x", cause }]);
    await runStep({ skill: "build", structure: "house", size: "small" }, context);
    assert.ok(building.unfinished !== null, `${cause} twice keeps the house`);
  }
  const policy = refusedBuild([{ x: 1, y: 64, z: 1, detail: "movement policy prohibits breaking this block", cause: "policy" }]);
  runtime.failNext.build_structure = policy;
  await runStep({ skill: "build", structure: "house", size: "small" }, context);
  runtime.failNext.build_structure = policy;
  const last = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.match(last.status === "failed" ? last.detail : "", /build somewhere else/u);
  assert.equal(building.unfinished, null);
});

test("a stop that is not a refusal keeps the earlier refused cells: refusal A, a tool failure, refusal A again is a repeat (run 14 review SF6)", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  const building = { unfinished: null as UnfinishedHouse | null };
  const context = contextFor(runtime, { style: "medieval", building });
  const policy = refusedBuild([{ x: 1, y: 64, z: 1, detail: "movement policy prohibits breaking this block", cause: "policy" }]);
  runtime.failNext.build_structure = policy;
  await runStep({ skill: "build", structure: "house", size: "small" }, context);
  runtime.failNext.build_structure = { error: "[BUILD_INCOMPLETE] 1 cell still wrong" };
  await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.deepEqual(building.unfinished?.refused, [{ x: 1, y: 64, z: 1 }], "the tool failure did not forget the refusal");
  runtime.failNext.build_structure = policy;
  const third = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.match(third.status === "failed" ? third.detail : "", /build somewhere else/u);
  assert.equal(building.unfinished, null);
});

test("asked to build far from an unfinished house, she starts a new one where she stands", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  const building = { unfinished: null as UnfinishedHouse | null };
  runtime.failNext.build_structure = { error: "[BUILD_INCOMPLETE] 1 cell still wrong" };
  const context = contextFor(runtime, { style: "medieval", building });
  assert.equal((await runStep({ skill: "build", structure: "house", size: "small" }, context)).status, "failed");
  runtime.snapshot = { ...runtime.snapshot, position: { x: 20.5, y: 64, z: 0.5 } };
  const second = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.match(second.status === "done" ? second.detail : "", /door at 2[0-9] 64/u);
});

test("a build the runtime stopped reports the audit it returned: what was left and why", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: SMALL_MEDIEVAL };
  runtime.failures.build_structure = "[BUILD_STOPPED] The build stopped: no progress in two passes.";
  runtime.failureResults.build_structure = {
    status: "failed",
    error: "[BUILD_STOPPED] The build stopped: no progress in two passes.",
    structure: {
      placed: 7, dug: 2, wrong: 5, missing: [{ block: "cobblestone", count: 1 }],
      left: [{ reason: "not_reached", count: 4, named: [] }, { reason: "refused", count: 1, named: [] }],
    },
  };
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval" }));
  assert.equal(result.status, "failed");
  assert.match(
    result.detail ?? "",
    /stopped at part 1\/\d+: \[BUILD_STOPPED\] The build stopped: no progress in two passes\. \(placed 7, dug 2; left 4 not_reached, 1 refused; short of 1 cobblestone\)$/u,
  );
});

test("a house protects its box before the first block, one ring wider and one layer deeper, and only once when built again", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  const areas: ProtectedArea[] = [];
  const context = contextFor(runtime, { style: "medieval", areas });
  assert.equal((await runStep({ skill: "build", structure: "house", size: "small" }, context)).status, "done");
  assert.equal(runtime.submitted[0]?.tool, "protect_region", "protected before any block is touched");
  const cellsBuilt = builds(runtime).flatMap((call) => call.blocks);
  const box = runtime.areas[0]!;
  assert.deepEqual(box.min, {
    x: Math.min(...cellsBuilt.map((cell) => cell.x)) - 1,
    y: Math.min(...cellsBuilt.map((cell) => cell.y)) - 1,
    z: Math.min(...cellsBuilt.map((cell) => cell.z)) - 1,
  });
  assert.deepEqual(box.max, {
    x: Math.max(...cellsBuilt.map((cell) => cell.x)) + 1,
    y: Math.max(...cellsBuilt.map((cell) => cell.y)),
    z: Math.max(...cellsBuilt.map((cell) => cell.z)) + 1,
  });
  assert.equal(box.label, "small medieval house");
  assert.deepEqual(areas, [box]);

  // The same site again (a resume, or a rebuild after a restart): the same box, nothing new stored.
  await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.equal(runtime.areas.length, 1);
  assert.equal(areas.length, 1);
});

test("houseBox spans the cells plus a ring around them and the layer below, not above", () => {
  assert.deepEqual(houseBox([{ x: 0, y: 64, z: 0 }, { x: 4, y: 70, z: 2 }]), { min: { x: -1, y: 63, z: -1 }, max: { x: 5, y: 70, z: 3 } });
});

test("a house levels its site first, keeps what earlier parts built, and checks every part again at the end", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = {
    ...runtime.snapshot,
    position: { x: 0.5, y: 64, z: 0.5 },
    inventory: [...SMALL_MEDIEVAL, { name: "wooden_shovel", count: 1 }, { name: "dirt", count: 8 }],
    players: [{ username: "Steve", position: { x: 8, y: 64, z: 1 } }],
  };
  // A bump of grass on the site, and a hole where the house lays its own floor.
  runtime.world.set("-4,64,0", "grass_block");
  runtime.world.set("-5,63,1", "air");
  const facts: string[] = [];
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { requester: "steve", style: "medieval", templates: SIGNED_TEMPLATES, progress: (fact) => facts.push(fact) }));
  assert.equal(result.status, "done", result.status === "failed" ? result.detail : "");
  // What it starts doing and why, at each phase change, for the character to say.
  assert.equal(facts[0], "leveling the site of a small medieval house: digging what stands above it");
  assert.match(facts[1] ?? "", /^building a small medieval house, part 1\/\d+$/u);
  assert.ok(facts.includes("checking every block of a small medieval house is right"));
  const calls = builds(runtime) as { blocks: { x: number; y: number; z: number; block_name: string }[]; keep?: { x: number; y: number; z: number }[] }[];
  // The bump is dug before any block of the house; the hole is left to the floor that goes there.
  assert.deepEqual(calls[0]!.blocks, [{ x: -4, y: 64, z: 0, block_name: "air" }]);
  assert.ok(!calls.flatMap((call) => call.blocks).some((cell) => cell.block_name === "dirt"));
  const house = calls.slice(1);
  const half = house.length / 2;
  assert.equal(house.length % 2, 0);
  const claimCells = [{ x: -1, y: 64, z: 1 }, { x: -1, y: 63, z: 1 }];
  assert.deepEqual(house[0]!.keep, claimCells, "the first part keeps the claim cells");
  const firstPart = house[0]!.blocks.filter((cell) => cell.block_name !== "air").map(({ x, y, z }) => ({ x, y, z }));
  assert.deepEqual(house[1]!.keep, [...claimCells, ...firstPart], "the second part keeps the claim and first part");
  assert.ok(house.slice(half).every((call) => JSON.stringify(call.keep) === JSON.stringify(claimCells)), "the final check keeps the claim cells");
  assert.deepEqual(house.slice(half).map((call) => call.blocks), house.slice(0, half).map((call) => call.blocks));
});

test("leveling a site gets the best tool it can make for what it digs: stone when it carries cobblestone", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = { ...GLASS_RECIPES, stone_pickaxe: { makes: 1, needs: [{ item: "cobblestone", count: 3 }, { item: "stick", count: 2 }] } };
  runtime.simulateInventory = true;
  runtime.snapshot = {
    ...runtime.snapshot,
    position: { x: 0.5, y: 64, z: 0.5 },
    // Three cobblestone to spare beyond the house's own 16.
    inventory: [...SMALL_MEDIEVAL, { name: "cobblestone", count: 3 }, { name: "crafting_table", count: 1 }, { name: "oak_log", count: 4 }],
    players: [{ username: "Steve", position: { x: 8, y: 64, z: 1 } }],
  };
  runtime.world.set("-4,64,0", "stone");
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { requester: "steve", style: "medieval" }));
  assert.equal(result.status, "done", result.status === "failed" ? result.detail : "");
  const crafted = runtime.submitted.filter((call) => call.tool === "craft_item").flatMap((call) => (call.input.items as { item_name: string }[]).map((item) => item.item_name));
  assert.ok(crafted.includes("stone_pickaxe"), crafted.join(", "));
  const firstBuild = runtime.submitted.findIndex((call) => call.tool === "build_structure");
  const pickaxe = runtime.submitted.findIndex((call) => call.tool === "craft_item" && JSON.stringify(call.input).includes("stone_pickaxe"));
  assert.ok(pickaxe >= 0 && pickaxe < firstBuild, "the tool comes before the first dig");
});

test("a site that could not be leveled is leveled again by the next build, before its first part", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = {
    ...runtime.snapshot,
    position: { x: 0.5, y: 64, z: 0.5 },
    inventory: [...SMALL_MEDIEVAL, { name: "wooden_shovel", count: 1 }],
    players: [{ username: "Steve", position: { x: 8, y: 64, z: 1 } }],
  };
  runtime.world.set("-4,64,0", "grass_block");
  const building = { unfinished: null };
  const context = contextFor(runtime, { requester: "steve", style: "medieval", building });
  runtime.failNext.build_structure = { error: "[BUILD_STOPPED] A fight interrupted the build." };
  const first = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.equal(first.status, "failed");
  assert.match(first.status === "failed" ? first.detail : "", /^could not prepare the site of a small medieval house: leveling stopped at 1\/1: \[BUILD_STOPPED\]/u);
  assert.deepEqual(building.unfinished, { ...MEDIEVAL_SMALL_RECORD, site: { door: { x: -2, y: 64, z: 0 }, facing: "east" }, part: 0, prepared: false, materials: {}, ...STEVE_IN_OVERWORLD });
  const second = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.equal(second.status, "done");
  assert.deepEqual(builds(runtime)[1]!.blocks, [{ x: -4, y: 64, z: 0, block_name: "air" }], "the site is leveled again first");
});

test("a house at given coordinates has its door there and is built from in front of it, wherever she stood", async () => {
  const runtime = new FakeRuntime();
  runtime.walkOnNavigate = true;
  runtime.snapshot = { ...runtime.snapshot, position: { x: 30.5, y: 64, z: 30.5 }, inventory: SMALL_MEDIEVAL, players: [{ username: "Steve", position: { x: 20, y: 64, z: 10 } }] };
  const building = { unfinished: null };
  const result = await runStep(stepSchema.parse({ skill: "build", x: 20, y: 64, z: 4 }), contextFor(runtime, { requester: "steve", style: "medieval", building }));
  assert.equal(result.status, "done");
  assert.match(result.status === "done" ? result.detail : "", /^built a small medieval house, door at 20 64 4 facing south/u);
  // In front of the door (south of it, toward Steve), clear of the house.
  const { keep_items: kept, ...walk } = runtime.submitted.find((call) => call.tool === "navigate")!.input;
  assert.deepEqual(walk, { x: 20, y: 64, z: 6, range: 1 });
  assert.deepEqual([...(kept as string[])].sort(), SMALL_MEDIEVAL.map((stack) => stack.name).sort(), "the walk keeps the house's bill");
});

test("a house's blocks carry their states to build_structure: stairs facing and half, beams along their wall", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  assert.equal((await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval" }))).status, "done");
  const blocks = builds(runtime).flatMap((call) => call.blocks) as { block_name: string; facing?: string; half?: string; axis?: string }[];
  assert.ok(blocks.some((cell) => cell.block_name === "spruce_stairs" && cell.facing !== undefined && cell.half === "bottom"));
  assert.ok(blocks.some((cell) => cell.block_name === "spruce_slab" && cell.half === "bottom"));
  assert.ok(blocks.some((cell) => cell.block_name === "oak_log" && (cell.axis === "x" || cell.axis === "z")));
  assert.ok(blocks.some((cell) => cell.block_name === "oak_log" && cell.axis === "y"));
});

test("a new house over a protected area is refused before anything is protected, naming the nearest clear site", async () => {
  // Live 2026-10-03: told only "choose another zone clear of it", she stepped one block at a time, and each refused
  // start left its site protected for good (16 house boxes, most never built).
  const first = new FakeRuntime();
  first.snapshot = { ...first.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(first, { style: "medieval" }));
  const old = { ...first.areas[0]!, regionId: 12, owner: "Ayla" };

  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  runtime.areas = [old];
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval", self: "Ayla" }));
  assert.equal(result.status, "failed");
  const detail = result.status === "failed" ? result.detail : "";
  assert.match(detail, /^the site of a small medieval house \(door at -?\d+ 64 -?\d+\) overlaps protected area #12 'small medieval house' \(yours: leveling would dig it up\); the nearest site clear of them has its door \d+ blocks [a-z-]+, at (-?\d+) 64 (-?\d+): build there with those coordinates/u);
  assert.deepEqual(runtime.submitted, [], "nothing protected, nothing dug");
  assert.deepEqual(runtime.areas, [old]);

  // Built where it said: clear of the old house.
  runtime.walkOnNavigate = true;
  const [, x, z] = /at (-?\d+) 64 (-?\d+): build there/u.exec(detail)!;
  const there = await runStep({ skill: "build", structure: "house", size: "small", x: Number(x), y: 64, z: Number(z) }, contextFor(runtime, { style: "medieval", self: "Ayla" }));
  assert.equal(there.status, "done", JSON.stringify(there));
});

test("a new house whose site cannot be prepared does not keep its site protected", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  // A protected area beside the site (not over it) that the leveling's own check does not see: Tom's, added once the
  // house is protected, so preparing the site fails the way a worn-out tool would.
  const building = { unfinished: null as UnfinishedHouse | null };
  const context = contextFor(runtime, { style: "medieval", building });
  const protect = runtime.protectRegion.bind(runtime);
  runtime.protectRegion = async (request) => {
    const outcome = await protect(request);
    if (outcome.status === "succeeded" && !request.label.startsWith("leveling")) runtime.areas.push({ ...outcome.area, regionId: 99, label: "Tom's garden", owner: "Tom" });
    return outcome;
  };
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /^could not prepare the site of a small medieval house.*that unfinished house is given up/u);
  assert.deepEqual(runtime.areas.map((area) => area.label), ["Tom's garden"], "the house's own box released");
  // Live 2026-10-07: an unfinished house over another protected area was offered again and again.
  assert.equal(building.unfinished, null);
});

test("a house built with other blocks sends them, checks the shortfall of that bill and remembers the materials", async () => {
  const places: KnownPlace[] = [];
  const runtime = new FakeRuntime();
  runtime.snapshot = {
    ...runtime.snapshot,
    position: { x: 0.5, y: 64, z: 0.5 },
    inventory: [...SMALL_MEDIEVAL.filter((stack) => !["oak_planks", "spruce_stairs", "spruce_slab"].includes(stack.name)), { name: "oak_planks", count: 36 }, { name: "dirt", count: 200 }],
  };
  const materials = { roof: "dirt", window: "air" } as const;
  const result = await runStep({ skill: "build", structure: "house", size: "small", materials }, contextFor(runtime, { style: "medieval", remember: (place) => places.push(place) }));
  assert.equal(result.status, "done", JSON.stringify(result));
  const blocks = builds(runtime).flatMap((call) => call.blocks.map((cell) => cell.block_name));
  assert.ok(blocks.includes("dirt") && !blocks.includes("spruce_stairs") && !blocks.includes("spruce_slab") && !blocks.includes("glass_pane"));
  assert.deepEqual(places[0]!.house, { size: "small", style: "medieval", door: { x: 0, y: 64, z: 2 }, facing: "north", materials, dimension: "minecraft:overworld" });
});

test("a house ordered for yourself is your own house: remembered as own, with no asker to face or name", async () => {
  const places: KnownPlace[] = [];
  const runtime = new FakeRuntime();
  runtime.snapshot = {
    ...runtime.snapshot,
    position: { x: 0.5, y: 64, z: 0.5 },
    inventory: SMALL_MEDIEVAL,
    players: [{ username: "Steve", position: { x: 8, y: 64, z: 1 } }],
  };
  const result = await runStep({ skill: "build", structure: "house", size: "small", own: true }, contextFor(runtime, { requester: "steve", style: "medieval", remember: (place) => places.push(place) }));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.equal(places[0]!.name, "the small medieval house you built");
  assert.equal(places[0]!.own, true);
  // Nobody to face: the site is chosen as for a goal of her own (door facing north), not toward Steve (east).
  assert.equal(places[0]!.house?.facing, "north");
});

test('{"skill":"build","own":true} parses and is described as for yourself', () => {
  const step = stepSchema.parse({ skill: "build", own: true });
  assert.deepEqual(step, { skill: "build", structure: "house", own: true });
  assert.match(describeStep(step), /^build a small house for yourself$/u);
  assert.doesNotMatch(describeStep(stepSchema.parse({ skill: "build" })), /yourself/u);
});

test("materials the game refuses are named before anything is protected or sent", async () => {
  const runtime = new FakeRuntime();
  runtime.notBlocks = new Set(["stone_blok"]);
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "dirt", count: 300 }] };
  const result = await runStep({ skill: "build", structure: "house", size: "small", materials: { wall: "stone_blok", roof: "oak_stairs", door: "dirt" } }, contextFor(runtime, { style: "medieval" }));
  assert.equal(result.status, "failed");
  const detail = result.status === "failed" ? result.detail : "";
  assert.match(detail, /wall: stone_blok is no block id \(this house uses oak_planks\)/u);
  assert.match(detail, /roof: oak_stairs is not a full block \(this house uses spruce_planks\)/u);
  assert.match(detail, /door: dirt is not a door \(this house uses oak_door\)/u);
  assert.equal(runtime.submitted.length, 0);
});

test("improving without a temporary house, or a role that is not temporary, is refused before anything is sent", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: SMALL_MEDIEVAL };
  const none = await runStep({ skill: "improve_house" }, contextFor(runtime, { style: "medieval", ownHouse: () => null }));
  assert.deepEqual(none, { status: "failed", detail: "you have no temporary house of your own to improve" });
  const trim = await runStep({ skill: "improve_house", roles: ["trim", "wall"] }, contextFor(runtime, { style: "medieval", ownHouse: () => TEMPORARY_HOUSE }));
  assert.deepEqual(trim, { status: "failed", detail: "your house is not temporary in trim: its temporary parts are wall, roof" });
  assert.equal(runtime.submitted.length, 0);
});

test("improving a house not carried the blocks for names only what is missing", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 10 }] };
  const result = await runStep({ skill: "improve_house", roles: ["wall"] }, contextFor(runtime, { style: "medieval", ownHouse: () => TEMPORARY_HOUSE }));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /^missing \d+ oak_planks to improve your small medieval house \(the rest is carried\): fetch exactly the missing items with get_items, then improve again$/u);
  assert.equal(runtime.submitted.length, 0);
});

test("improving the walls sends the style's blocks for them, remembers the roof as still temporary, then the roof finishes it", async () => {
  const places: KnownPlace[] = [];
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  let house: KnownPlace = TEMPORARY_HOUSE;
  const context = contextFor(runtime, { style: "medieval", ownHouse: () => house, remember: (place) => { places.push(place); house = place; } });
  const walls = await runStep({ skill: "improve_house", roles: ["wall"] }, context);
  assert.deepEqual(walls, { status: "done", detail: "improved your small medieval house: wall now oak_planks; still temporary: roof dirt" });
  const sent = builds(runtime).flatMap((call) => call.blocks.map((cell) => cell.block_name));
  assert.ok(sent.includes("oak_planks") && sent.includes("dirt") && !sent.includes("spruce_stairs"), "the roof is still dirt");
  assert.deepEqual(places.at(-1)!.house?.materials, { roof: "dirt" });
  assert.equal(places.at(-1)!.name, TEMPORARY_HOUSE.name);
  runtime.submitted.length = 0;
  const roof = await runStep({ skill: "improve_house" }, context);
  assert.equal(roof.status, "done", JSON.stringify(roof));
  const roofBlocks = builds(runtime).flatMap((call) => call.blocks.map((cell) => cell.block_name));
  assert.ok(roofBlocks.includes("spruce_stairs") && roofBlocks.includes("spruce_slab"), "the style's variants come back");
  assert.deepEqual(places.at(-1)!.house?.materials, {});
  assert.deepEqual(roof, { status: "done", detail: "improved your small medieval house: roof now spruce_planks" });
});

test("resuming a house after a restart is not refused over her own earlier box: the runtime's regions are read, not what this session learnt", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  const building: { unfinished: UnfinishedHouse | null } = { unfinished: null };
  runtime.failNext.build_structure = { error: "[BUILD_INCOMPLETE] 1 cell still wrong" };
  await runStep({ skill: "build", structure: "house", size: "small" }, { ...contextFor(runtime, { style: "medieval", building }), self: "self" });
  const house = building.unfinished!;
  // After the restart: the site is still to be leveled, and an older box of hers (a slightly different one) is in the runtime.
  runtime.areas.push({ regionId: 99, owner: "self", label: house.kind, min: { x: house.site.door.x - 4, y: 60, z: house.site.door.z - 4 }, max: { x: house.site.door.x + 4, y: 80, z: house.site.door.z + 4 } });
  const restarted = { unfinished: { ...house, part: 0, prepared: false } };
  runtime.snapshot = { ...runtime.snapshot, inventory: SMALL_MEDIEVAL };
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, { ...contextFor(runtime, { style: "medieval", building: restarted }), self: "self" });
  assert.equal(result.status, "done", result.status === "failed" ? result.detail : "");
});

test("the house's materials are not scaffolding while it is built, and the list is put back after, also when the build stops", async () => {
  const scaffold = ["dirt", "cobblestone", "oak_planks"];
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL, policy: { revision: "r1", digStraightDown: false, scaffoldBlocks: scaffold } };
  const done = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval", building: { unfinished: null } }));
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.deepEqual(runtime.scaffoldSettings, [["dirt"], scaffold]);

  const broken = new FakeRuntime();
  broken.snapshot = { ...broken.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL, policy: { revision: "r1", digStraightDown: false, scaffoldBlocks: scaffold } };
  broken.failNext.build_structure = { error: "[BUILD_INCOMPLETE] 1 cell still wrong" };
  const failed = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(broken, { style: "medieval", building: { unfinished: null } }));
  assert.equal(failed.status, "failed");
  assert.deepEqual(broken.scaffoldSettings, [["dirt"], scaffold]);
});

test("the nearest clear site is named at the walking level of its column, not at the refused site's height", async () => {
  // Live 2026-10-11: a door suggested at y=70 over ground at y=66; the `go to` there failed NAVIGATION_TARGET_UNSUPPORTED.
  const first = new FakeRuntime();
  first.snapshot = { ...first.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(first, { style: "medieval" }));
  const old = { ...first.areas[0]!, regionId: 12, owner: "Ayla" };

  const ask = async (lower: { x: number; z: number } | null) => {
    const runtime = new FakeRuntime();
    runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
    runtime.areas = [old];
    if (lower !== null) for (let y = 61; y <= 63; y += 1) runtime.world.set(`${lower.x},${y},${lower.z}`, "air");
    const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval", self: "Ayla" }));
    return result.status === "failed" ? result.detail : "";
  };
  const flat = /at (-?\d+) (-?\d+) (-?\d+): build there/u.exec(await ask(null))!;
  assert.equal(flat[2], "64");
  const lowered = /at (-?\d+) (-?\d+) (-?\d+): build there/u.exec(await ask({ x: Number(flat[1]), z: Number(flat[3]) }))!;
  assert.deepEqual([lowered[1], lowered[2], lowered[3]], [flat[1], "61", flat[3]], "the column's ground is 4 lower: the door stands on it");
});

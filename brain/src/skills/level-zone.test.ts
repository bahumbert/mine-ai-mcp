// Tests of the level_area, protect_area and release_area skills.
import assert from "node:assert/strict";
import test from "node:test";
import { stepSchema } from "../actions.ts";
import { runStep } from "../skills.ts";
import type { ProtectedArea } from "../runtime-client.ts";
import { FakeRuntime } from "../testing.ts";
import { contextFor, describeCall, HOUSE_RECIPES, builds, refusedBuild } from "./skill-fixtures.test.ts";

test("protect_area keeps a radius around a seen player, owned by that player, and release_area gives it back", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Tom", position: { x: 10.4, y: 64, z: -3.6 } }] };
  const areas: ProtectedArea[] = [];
  const context = contextFor(runtime, { areas });
  const kept = await runStep(stepSchema.parse({ skill: "protect_area", player: "tom", radius: 5, label: "Tom's place" }), context);
  assert.deepEqual(kept, { status: "done", detail: "protected area #1 'Tom's place' (11 blocks across around 10 64 -4): I will not dig or place blocks there" });
  assert.deepEqual(areas, [{ regionId: 1, label: "Tom's place", owner: "tom", min: { x: 5, y: 59, z: -9 }, max: { x: 15, y: 69, z: 1 } }]);

  assert.deepEqual(await runStep({ skill: "release_area", area: 1 }, context), { status: "done", detail: "released area #1: I may dig and place blocks there again" });
  assert.deepEqual(areas, []);
  assert.equal((await runStep({ skill: "release_area", area: 1 }, context)).status, "failed");
});

test("protect_area needs a player in sight or coordinates", async () => {
  const runtime = new FakeRuntime();
  const context = contextFor(runtime);
  assert.deepEqual(await runStep(stepSchema.parse({ skill: "protect_area", player: "Tom", label: "x" }), context), { status: "failed", detail: "cannot see Tom to protect the area around them" });
  assert.equal((await runStep(stepSchema.parse({ skill: "protect_area", x: 1, y: 64, z: 1, radius: 2, label: "spot" }), context)).status, "done");
  assert.equal(runtime.areas[0]?.owner, "self", "coordinates alone protect the character's own area");
  assert.equal(stepSchema.safeParse({ skill: "protect_area", player: "Tom", radius: 32, label: "x" }).success, false);
});

test("level_area flattens the zone between two marker blocks at their level, keeping the markers", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: [{ name: "wooden_shovel", count: 1 }, { name: "dirt", count: 4 }] };
  runtime.world.set("2,64,2", "gold_block");
  runtime.world.set("6,64,5", "gold_block");
  runtime.world.set("4,64,3", "grass_block");
  runtime.world.set("4,65,3", "grass_block");
  runtime.world.set("5,63,4", "air");
  const context = contextFor(runtime, { areas: [] });
  const result = await runStep(stepSchema.parse({ skill: "level_area", markers: "gold_block" }), context);
  assert.deepEqual(result, { status: "done", detail: "leveled 5x4 at y 64: dug 2, filled 1" });
  const cells = builds(runtime).flatMap((call) => call.blocks);
  assert.deepEqual(cells, [
    { x: 4, y: 65, z: 3, block_name: "air" },
    { x: 4, y: 64, z: 3, block_name: "air" },
    // The hole last, with what the dig brought.
    { x: 5, y: 63, z: 4, block_name: "dirt" },
  ]);
  // Set aside while she works, given back after.
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "protect_region" || call.tool === "unprotect_region").map((call) => call.tool), ["protect_region", "unprotect_region"]);
  assert.deepEqual(context.areas, []);
});

test("level_area that fails while filling the holes counts its batches on from the dig: leveling stopped at N/M", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: [{ name: "wooden_shovel", count: 1 }, { name: "dirt", count: 4 }] };
  runtime.world.set("2,64,2", "gold_block");
  runtime.world.set("6,64,5", "gold_block");
  runtime.world.set("4,64,3", "grass_block");
  runtime.world.set("4,65,3", "grass_block");
  runtime.world.set("5,63,4", "air");
  const submit = runtime.submit.bind(runtime);
  // The two dig batches go through; the first fill batch (the hole) is refused for a reason that is no refusal of a cell.
  runtime.submit = async (tool, input, ...rest) => {
    if (tool === "build_structure" && builds(runtime).length === 2) runtime.failNext.build_structure = { error: "[BUILD_STOPPED] The build stopped: no progress in two passes." };
    return submit(tool, input, ...rest);
  };
  const result = await runStep(stepSchema.parse({ skill: "level_area", markers: "gold_block" }), contextFor(runtime, { areas: [] }));
  assert.equal(builds(runtime).length, 3);
  assert.deepEqual(result, { status: "failed", detail: "leveling stopped at 3/3: [BUILD_STOPPED] The build stopped: no progress in two passes." });
});

test("a tool worn out while leveling is made again and the batch done again, not the end of the job", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = { ...HOUSE_RECIPES, wooden_shovel: { makes: 1, needs: [{ item: "oak_planks", count: 1 }, { item: "stick", count: 2 }] } };
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_shovel", count: 1 }, { name: "oak_planks", count: 8 }, { name: "crafting_table", count: 1 }] };
  runtime.world.set("2,64,2", "gold_block");
  runtime.world.set("6,64,5", "gold_block");
  runtime.world.set("4,64,3", "grass_block");
  runtime.failNext.build_structure = { error: "[TOOL_TIER_LOST] wooden_shovel was lost at 4,64,3; no shovel remains.", effect: () => runtime.addItem("wooden_shovel", -1) };
  const result = await runStep(stepSchema.parse({ skill: "level_area", markers: "gold_block" }), contextFor(runtime, { areas: [] }));
  assert.deepEqual(result, { status: "done", detail: "leveled 5x4 at y 64: dug 1, filled 0" });
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "build_structure" || call.tool === "craft_item").map(describeCall), ["build_structure", "craft wooden_shovel at table", "build_structure"]);
});

test("a shovel that breaks with no digging left in the level is not made again, the filling goes on", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = { ...HOUSE_RECIPES, wooden_shovel: { makes: 1, needs: [{ item: "oak_planks", count: 1 }, { item: "stick", count: 2 }] } };
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_shovel", count: 1 }, { name: "oak_planks", count: 8 }, { name: "crafting_table", count: 1 }, { name: "dirt", count: 4 }] };
  runtime.world.set("2,64,2", "gold_block");
  runtime.world.set("6,64,5", "gold_block");
  runtime.world.set("4,64,3", "grass_block");
  runtime.world.set("5,63,4", "air");
  const submit = runtime.submit.bind(runtime);
  // The shovel goes with the last batch (the hole), after every block to dig is dug.
  runtime.submit = async (tool, input, ...rest) => {
    if (tool === "build_structure" && builds(runtime).length === 1) {
      runtime.failNext.build_structure = { error: "[TOOL_TIER_LOST] wooden_shovel was lost at 5,64,4; no shovel remains.", effect: () => runtime.addItem("wooden_shovel", -1) };
    }
    return submit(tool, input, ...rest);
  };
  const result = await runStep(stepSchema.parse({ skill: "level_area", markers: "gold_block" }), contextFor(runtime, { areas: [] }));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "build_structure" || call.tool === "craft_item").map(describeCall), ["build_structure", "build_structure", "build_structure"]);
});

test("level_area lays a one-block floor over a hole, of the block asked for", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: [{ name: "cobblestone", count: 4 }, { name: "dirt", count: 9 }] };
  runtime.world.set("2,64,2", "gold_block");
  runtime.world.set("6,64,5", "gold_block");
  for (const y of [63, 62, 61]) runtime.world.set(`5,${y},4`, "air");
  const result = await runStep(stepSchema.parse({ skill: "level_area", markers: "gold_block", fill: "cobblestone" }), contextFor(runtime, { areas: [] }));
  assert.deepEqual(result, { status: "done", detail: "leveled 5x4 at y 64: dug 0, filled 1" });
  assert.deepEqual(builds(runtime).flatMap((call) => call.blocks), [{ x: 5, y: 63, z: 4, block_name: "cobblestone" }]);
});

test("level_area says where markers out of range are, so the next step can walk there", async () => {
  const runtime = new FakeRuntime();
  runtime.world.set("100,64,0", "gold_block");
  runtime.world.set("104,64,3", "gold_block");
  const result = await runStep(stepSchema.parse({ skill: "level_area", markers: "gold_block" }), contextFor(runtime, { areas: [] }));
  assert.deepEqual(result, { status: "failed", detail: "found no gold_block within 48 blocks: the zone needs two corners; the nearest farther ones are at 100 64 0 and 104 64 3: go near them first" });
});

test("level_area around a player uses their level; it refuses a zone it cannot make out", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_shovel", count: 1 }], players: [{ username: "Tom", position: { x: 10.4, y: 64, z: -3.6 } }] };
  runtime.world.set("12,64,-2", "dirt");
  const result = await runStep(stepSchema.parse({ skill: "level_area", around: "tom", radius: 2 }), contextFor(runtime));
  assert.deepEqual(result, { status: "done", detail: "leveled 5x5 at y 64: dug 1, filled 0" });

  const alone = new FakeRuntime();
  assert.deepEqual(await runStep(stepSchema.parse({ skill: "level_area", markers: "gold_block" }), contextFor(alone)), { status: "failed", detail: "found no gold_block within 48 blocks: the zone needs two corners" });
  assert.deepEqual(await runStep(stepSchema.parse({ skill: "level_area", x1: 0, z1: 0, x2: 40, z2: 3, y: 64 }), contextFor(alone)), { status: "failed", detail: "the zone is 41 by 4: at most 32 by 32 at a time" });
  assert.deepEqual(await runStep(stepSchema.parse({ skill: "level_area", x1: 0, z1: 0, x2: 4, z2: 3 }), contextFor(alone)), { status: "failed", detail: "level_area with corners needs the walking level y" });
  assert.deepEqual(await runStep(stepSchema.parse({ skill: "level_area" }), contextFor(alone)), { status: "failed", detail: "level_area needs markers, a player to level around, or x1, z1, x2, z2 corners" });
});

test("level_area never levels over a protected area, her own houses included", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_shovel", count: 1 }] };
  runtime.areas = [
    { regionId: 4, label: "small medieval house", owner: "Ayla", min: { x: 3, y: 60, z: 3 }, max: { x: 9, y: 72, z: 9 } },
    { regionId: 5, label: "Steve's garden", owner: "Steve", min: { x: -3, y: 60, z: -3 }, max: { x: 0, y: 72, z: 0 } },
  ];
  runtime.world.set("1,64,1", "dirt");
  const result = await runStep(stepSchema.parse({ skill: "level_area", x1: 0, z1: 0, x2: 5, z2: 5, y: 64 }), contextFor(runtime, { self: "Ayla" }));
  // What each area is, so the model does not just release them (live 2026-10-02).
  assert.deepEqual(result, {
    status: "failed",
    detail: "6x6 at y 64 overlaps protected areas #4 'small medieval house' (yours: leveling would dig it up), #5 'Steve's garden' (owned by Steve): choose another zone clear of them, or ask whoever asked you",
  });
  assert.deepEqual(builds(runtime), []);
});

test("leveling goes on around a cell it may not dig, and says so", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_shovel", count: 1 }, { name: "wooden_axe", count: 1 }] };
  runtime.world.set("1,64,1", "crafting_table");
  runtime.world.set("2,64,1", "dirt");
  runtime.world.set("2,65,1", "dirt");
  // The structured audit says it, not the wording of the error (run 14 review N10).
  runtime.failNext.build_structure = { ...refusedBuild([{ x: 1, y: 64, z: 1, detail: "movement policy prohibits breaking this block" }]), error: "[BUILD_INCOMPLETE] one cell was turned down" };
  const result = await runStep(stepSchema.parse({ skill: "level_area", x1: 0, z1: 0, x2: 3, z2: 3, y: 64 }), contextFor(runtime));
  assert.deepEqual(result, { status: "done", detail: "leveled 4x4 at y 64: dug 2, filled 0 (left 1 cell it may not dig, leveled around)" });
  assert.equal(builds(runtime).length, 2, "the batch after the refused one still ran");
});

test("level_area refuses above its block budget, says how many blocks and how deep, and digs nothing", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_shovel", count: 1 }] };
  for (let x = 0; x < 10; x += 1) for (let z = 0; z < 10; z += 1) for (let y = 64; y <= 66; y += 1) runtime.world.set(`${x},${y},${z}`, "dirt");
  const result = await runStep(stepSchema.parse({ skill: "level_area", x1: 0, z1: 0, x2: 9, z2: 9, y: 64 }), contextFor(runtime, { areas: [] }));
  assert.equal(result.status, "failed");
  const detail = result.status === "failed" ? result.detail : "";
  assert.match(detail, /^leveling 10x10 at y 64 means moving 300 blocks \(300 to dig, 0 to fill\), up to 3 deep; at most 256 blocks are moved at a time: ask for a smaller area or a nearer height/u);
  assert.doesNotMatch(detail, /pit/u);
  assert.equal(builds(runtime).length, 0);
});

test("level_area names a deep dig as a pit of its depth when it is refused, and no tower or hill as one", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_shovel", count: 1 }] };
  // A hole: the ground stands at 74 all round and the level is 64.
  runtime.groundTop = 74;
  const result = await runStep(stepSchema.parse({ skill: "level_area", x1: 0, z1: 0, x2: 4, z2: 4, y: 64 }), contextFor(runtime, { areas: [] }));
  assert.match(result.status === "failed" ? result.detail : "", /means moving 275 blocks .*up to 11 deep \(this digs a pit 11 deep\)/u);
  // A tower of the same height in flat ground is cut, not dug into.
  const flat = new FakeRuntime();
  flat.snapshot = { ...flat.snapshot, inventory: [{ name: "wooden_shovel", count: 1 }] };
  for (let x = 0; x < 5; x += 1) for (let z = 0; z < 5; z += 1) for (let y = 64; y <= 74; y += 1) flat.world.set(`${x},${y},${z}`, "dirt");
  const tower = await runStep(stepSchema.parse({ skill: "level_area", x1: 0, z1: 0, x2: 4, z2: 4, y: 64 }), contextFor(flat, { areas: [] }));
  assert.doesNotMatch(tower.status === "failed" ? tower.detail : "", /pit/u);
});

test("level_area tells a pit whatever the count of blocks, when it is done", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_shovel", count: 1 }] };
  runtime.groundTop = 67;
  const result = await runStep(stepSchema.parse({ skill: "level_area", x1: 0, z1: 0, x2: 2, z2: 2, y: 64 }), contextFor(runtime, { areas: [] }));
  assert.deepEqual(result, { status: "done", detail: "leveled 3x3 at y 64: dug 36, filled 0 (this digs a pit 4 deep)" });
});

test("level_area around a player levels the same place for the whole objective, wherever the player goes", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_shovel", count: 1 }, { name: "dirt", count: 40 }], players: [{ username: "Tom", position: { x: 10.4, y: 64, z: -3.6 } }] };
  runtime.world.set("12,64,-2", "dirt");
  const levelSites = new Map<string, { x: number; y: number; z: number }>();
  const step = stepSchema.parse({ skill: "level_area", around: "Tom", radius: 2 });
  assert.equal((await runStep(step, contextFor(runtime, { levelSites }))).status, "done");
  const first = builds(runtime).flatMap((call) => call.blocks);
  // Tom flies off, 4 up and 20 away.
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Tom", position: { x: 30.5, y: 68, z: 20.5 } }] };
  const again = await runStep(step, contextFor(runtime, { levelSites }));
  assert.equal(again.status, "done");
  assert.match(again.status === "done" ? again.detail : "", /^leveled 5x5 at y 64: /u);
  assert.deepEqual(builds(runtime).flatMap((call) => call.blocks).slice(first.length), first, "the first zone, at the first level");
  // Another objective (no shared record) goes where Tom is now.
  const moved = await runStep(step, contextFor(runtime, { levelSites: new Map() }));
  assert.match(moved.status === "done" ? moved.detail : "", /^leveled 5x5 at y 68: /u);
});

test("level_area builds one support column under a platform in the air, then fills the layer outward from it", async () => {
  const runtime = new FakeRuntime();
  // The ground is at 118; the level asked is 123: the layer to fill is y 122, over air all the way down.
  runtime.groundTop = 118;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "dirt", count: 40 }], players: [{ username: "Tom", position: { x: 10.5, y: 123, z: 10.5 } }] };
  const result = await runStep(stepSchema.parse({ skill: "level_area", around: "Tom", radius: 2 }), contextFor(runtime, { levelSites: new Map() }));
  assert.deepEqual(result, { status: "done", detail: "leveled 5x5 at y 123: dug 0, filled 28 (3 of them a support column up from the ground)" });
  const batches = builds(runtime).map((call) => call.blocks.map(({ x, y, z }) => `${x},${y},${z}`));
  assert.deepEqual(batches[0], ["10,119,10", "10,120,10", "10,121,10"], "the column first, bottom up");
  assert.equal(batches[1]!.length, 25);
  assert.equal(batches[1]![0], "10,122,10", "the layer starts on the column");
});

test("level_area refuses a platform in the air with no ground within reach, before placing anything", async () => {
  const runtime = new FakeRuntime();
  runtime.groundTop = 20;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "dirt", count: 40 }] };
  const result = await runStep(stepSchema.parse({ skill: "level_area", x1: 0, z1: 0, x2: 4, z2: 4, y: 123 }), contextFor(runtime, { areas: [] }));
  assert.deepEqual(result, { status: "failed", detail: "leveling 5x5 at y 123 would build a platform in the air with no solid ground within 16 blocks under it: choose a nearer height" });
  assert.deepEqual(builds(runtime), []);
});

test("her own name in a step is where she stands: protecting the area around herself works", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 10.5, y: 64, z: -3.5 } };
  const result = await runStep({ skill: "protect_area", player: "ayla", radius: 4, label: "camp" }, contextFor(runtime, { self: "Ayla" }));
  assert.equal(result.status, "done");
  assert.deepEqual(runtime.areas[0]?.min, { x: 6, y: 60, z: -8 });
  const other = await runStep({ skill: "protect_area", player: "Bob", radius: 4, label: "camp" }, contextFor(runtime, { self: "Ayla" }));
  assert.deepEqual(other, { status: "failed", detail: "cannot see Bob to protect the area around them" });
});

test("protect_area with no player and no coordinates protects around herself, owned as her own (live 2026-10-11: 'around you' came as the speaker's name)", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 10.5, y: 64, z: -3.5 } };
  const bare = await runStep({ skill: "protect_area", radius: 4, label: "camp" }, contextFor(runtime, { self: "Ayla" }));
  assert.equal(bare.status, "done");
  assert.deepEqual(runtime.areas[0]?.min, { x: 6, y: 60, z: -8 });
  runtime.snapshot = { ...runtime.snapshot, position: { x: 30.5, y: 64, z: -3.5 } };
  const named = await runStep({ skill: "protect_area", player: "ayla", radius: 4, label: "camp two" }, contextFor(runtime, { self: "Ayla" }));
  assert.equal(named.status, "done");
  assert.deepEqual([runtime.areas[0]?.owner, runtime.areas[1]?.owner], ["self", "self"], "her own name is no other owner");
});

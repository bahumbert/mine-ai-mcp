// Tests of the explore skill: legs, water, boats, places already searched and what it names.
import assert from "node:assert/strict";
import test from "node:test";
import { skillUsage, stepSchema } from "../actions.ts";
import { runStep } from "../skills.ts";
import type { BotSnapshot, ProtectedArea } from "../runtime-client.ts";
import { FakeRuntime } from "../testing.ts";
import { contextFor } from "./skill-fixtures.test.ts";

/** An explore result without its closing list of how far unseen land is each way. */
const withoutWays = (detail: string) => detail.split("; unseen land from here: ")[0]!;

test("explore names a drowned or roofed nearest log and offers only the open one as the trip", async () => {
  for (const situation of ["under_water", "roofed"] as const) for (const open of [true, false]) {
    const runtime = new FakeRuntime();
    runtime.walkOnNavigate = true;
    runtime.world.set("80,60,0", "oak_log");
    runtime.situations = { "80,60,0": situation };
    if (open) runtime.world.set("120,64,0", "oak_log");
    const result = await runStep(stepSchema.parse({ skill: "explore", toward: "east", chunks: 8, for: "oak_log" }), contextFor(runtime));
    const detail = "detail" in result ? result.detail : "";
    assert.match(detail, new RegExp(`the nearest oak_log you know of lies ${situation === "under_water" ? "under water" : "roofed over"} at 80 60 0`, "u"));
    if (open) assert.match(detail, /the nearest in the open is .*around 120 0: get_items oak_log goes there/u);
    else assert.doesNotMatch(detail, /get_items oak_log.*(?:goes there|fetches it)/u);
    assert.equal(runtime.snapshot.position.x, open ? 96 : 128, "only an open hit ends the walk early");
  }
});

test("a refused explore names drowned logs without offering them as a get_items trip", async () => {
  const runtime = new FakeRuntime();
  runtime.world.set("10,60,0", "oak_log");
  runtime.situations = { "10,60,0": "under_water" };
  runtime.unseenAlong = async () => null;
  const result = await runStep(stepSchema.parse({ skill: "explore", toward: "east", for: "oak_log" }), contextFor(runtime));
  assert.match("detail" in result ? result.detail : "", /lies under water at 10 60 0/u);
  assert.doesNotMatch("detail" in result ? result.detail : "", /get_items oak_log.*fetches it/u);
});

test("explore leaves a wet frontier trip to go_to because the next fetch refuses to walk there", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.seen = { oak_log: { dimension: "overworld", x: 700, z: 8 } };
  runtime.water = { "43,0": 0.9 };
  runtime.unseenAlong = async () => null;
  const explored = await runStep(stepSchema.parse({ skill: "explore", toward: "east", for: "oak_log" }), contextFor(runtime));
  runtime.failNext.collect_block = { error: "[NO_TARGET_IN_RANGE] none near" };
  assert.equal((await runStep({ skill: "get_items", items: [{ item: "oak_log", count: 1 }] }, contextFor(runtime))).status, "failed");
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "navigate"), []);
  const detail = "detail" in explored ? explored.detail : "";
  assert.doesNotMatch(detail, /get_items oak_log.*(?:fetches it|goes there)/u);
  assert.match(detail, /mostly water.*around 700 8.*go_to/u);
});

/** A fake whose snapshot lists these mobs once the bot stands at or past `fromX` (what loads as she walks on). */
class MobsLoadAt extends FakeRuntime {
  constructor(private readonly fromX: number, private readonly mobs: BotSnapshot["mobs"]) { super(); }

  override async status(): Promise<BotSnapshot> {
    return { ...this.snapshot, mobs: this.snapshot.position.x >= this.fromX ? this.mobs : [] };
  }
}

test("explore walks on through land she has seen to where unseen land comes into sight, and says how far it is each way", async () => {
  // Owner 2026-10-04: exploring already known areas has no point; live, Vex circled 60 blocks around the same spot.
  const runtime = new FakeRuntime();
  runtime.walkOnNavigate = true;
  runtime.snapshot = { ...runtime.snapshot, position: { x: 8, y: 64, z: 8 } };
  // Seen: 20 chunks east of her (to x 320), and everything north as far as it is looked for.
  runtime.explored = new Set([...Array.from({ length: 20 }, (_, i) => `${i},0`), ...Array.from({ length: 40 }, (_, i) => `0,${-i}`)]);
  const result = await runStep(stepSchema.parse({ skill: "explore", toward: "east", chunks: 2 }), contextFor(runtime));
  // Unseen from x 328, 320 blocks east of her: it comes into sight 128 short of it, then 2 chunks on, 224 blocks in all,
  // in legs of 96 blocks (owner, live 2026-10-07: 32-block legs were a stream of hops she could see past).
  assert.equal(runtime.submitted.filter((call) => call.tool === "navigate").length, 3);
  assert.match(result.status === "done" ? result.detail : "", /^explored east: now 224 blocks east from where you started, at 232 64 8; unseen land from here: /u);
  runtime.snapshot = { ...runtime.snapshot, position: { x: 8, y: 64, z: 8 } };
  const north = await runStep(stepSchema.parse({ skill: "explore", toward: "north" }), contextFor(runtime));
  assert.match(north.status === "failed" ? north.detail : "", /^north is land you have seen as far as 512 blocks\. Unseen land lies .*east \d+ blocks.*: explore one of those ways; the walk crosses the land you know to get there \(up to 384 blocks a step\)$/u);
  // What it was for, she already knows of: the refusal says so, with the step that fetches it.
  runtime.world.set("20,64,8", "oak_log");
  const known = await runStep(stepSchema.parse({ skill: "explore", toward: "north", for: "oak_log" }), contextFor(runtime));
  assert.match(known.status === "failed" ? known.detail : "", /; you already know of oak_log 12 blocks east, around 20 8: get_items oak_log fetches it$/u);
});

test("a way sailed without finding land is not sailed again from near there", async () => {
  // Live 2026-10-04: Vex rode 450 blocks of sea out and back nine times from the same base.
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 8, y: 64, z: 8 } };
  const endsAtSea = (blocks: number) => ({ error: `[NAVIGATION_BOAT_FAILED] Crossing deep water by boat failed: rode ${blocks} blocks by boat and stays at sea in its boat at 0 -${blocks} (no land within ${blocks} blocks that way).`, effect: () => { runtime.snapshot = { ...runtime.snapshot, position: { x: 0, y: 63, z: 8 - blocks } }; } });
  runtime.failNext.navigate = endsAtSea(200);
  const first = await runStep(stepSchema.parse({ skill: "explore", toward: "north" }), contextFor(runtime));
  assert.equal(first.status, "failed");
  // Back at the base, where the ride went past her.
  runtime.snapshot = { ...runtime.snapshot, position: { x: 8, y: 64, z: 8 } };
  const again = await runStep(stepSchema.parse({ skill: "explore", toward: "north" }), contextFor(runtime));
  assert.match(again.status === "failed" ? again.detail : "", /^north from here is open sea: you sailed it and found no land within 200 blocks: explore another way/u);
  assert.equal(runtime.submitted.filter((call) => call.tool === "navigate").length, 1);
  // Another way is still open.
  const east = await runStep(stepSchema.parse({ skill: "explore", toward: "east" }), contextFor(runtime));
  assert.doesNotMatch(east.status === "failed" ? east.detail : "", /open sea/u);
});

test("from the boat where a ride ended at sea, going on the same way is not refused: no one has sailed past it (run 14 review SF5)", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 8, y: 64, z: 8 } };
  runtime.failNext.navigate = { error: "[NAVIGATION_BOAT_FAILED] Crossing deep water by boat failed: rode 158 blocks by boat and stays at sea in its boat at 8 -150 (no land within 158 blocks that way).", effect: () => { runtime.snapshot = { ...runtime.snapshot, position: { x: 8, y: 63, z: -150 } }; } };
  await runStep(stepSchema.parse({ skill: "explore", toward: "north" }), contextFor(runtime));
  const before = runtime.submitted.filter((call) => call.tool === "navigate").length;
  const onward = await runStep(stepSchema.parse({ skill: "explore", toward: "north" }), contextFor(runtime));
  assert.doesNotMatch(onward.status === "failed" ? onward.detail : "", /open sea/u);
  assert.equal(runtime.submitted.filter((call) => call.tool === "navigate").length, before + 1, "the ride goes on from the boat");
});

test("explore walks one compass way from where she stands, in legs, and says where it ended and where a known block is", async () => {
  const runtime = new FakeRuntime();
  runtime.walkOnNavigate = true;
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 } };
  const result = await runStep(stepSchema.parse({ skill: "explore", toward: "east", for: "dark_oak_log" }), contextFor(runtime));
  assert.deepEqual(runtime.submitted.map((call) => [call.tool, call.input.x, call.input.z, call.input.y]), [["navigate", 64, 0, undefined]]);
  assert.equal(withoutWays(result.status === "done" ? result.detail : ""), "explored east: now 64 blocks east from where you started, at 64 64 0; no dark_oak_log seen on the way");

  // An ore is dug for, not walked to (live 2026-10-07: Vex explored for iron_ore, which the map leaves out).
  const before = runtime.submitted.length;
  const ore = await runStep(stepSchema.parse({ skill: "explore", toward: "east", for: "iron_ore" }), contextFor(runtime));
  assert.equal(ore.status, "failed");
  assert.match("detail" in ore ? ore.detail : "", /^iron_ore lies underground nearly everywhere, and walking the surface does not find it: get_items raw_iron digs for it/u);
  assert.equal(runtime.submitted.length, before);

  // Only blocks are seen on the way (live 2026-10-07: Ayla explored for "water_source").
  runtime.notBlocks = new Set(["water_source"]);
  const notBlock = await runStep(stepSchema.parse({ skill: "explore", toward: "east", for: "water_source" }), contextFor(runtime));
  assert.deepEqual(notBlock, { status: "failed", detail: "water_source is not a block: explore looks for a block by its Minecraft name; get_items gets an item. To find animals or monsters, leave \"for\" out to just explore: the new land you reach shows what lives there, and get_items gets what they drop (white_wool from sheep, porkchop from pigs)" });
  assert.equal(runtime.submitted.length, before);

  // What is made is not found (live 2026-10-07: Ayla explored for a crafting_table).
  runtime.recipes = { ...runtime.recipes, crafting_table: { makes: 1, needs: [{ item: "oak_planks", count: 4 }] } };
  const table = await runStep(stepSchema.parse({ skill: "explore", toward: "east", for: "crafting_table" }), contextFor(runtime));
  assert.deepEqual(table, { status: "failed", detail: "crafting_table is crafted, not found: get_items crafting_table makes it" });
  assert.equal(runtime.submitted.length, before);

  // Live 2026-10-07: Ayla explored "for spruce_log" some forty times while she knew of spruce 169 blocks away; the
  // result names the known one and the step that fetches it.
  const near = new FakeRuntime();
  near.walkOnNavigate = true;
  near.snapshot = { ...near.snapshot, position: { x: 0.5, y: 64, z: 0.5 } };
  near.world.set("80,64,2", "oak_log");
  const found = await runStep(stepSchema.parse({ skill: "explore", toward: "east", chunks: 8, for: "oak_log" }), contextFor(near));
  assert.equal(withoutWays(found.status === "done" ? found.detail : ""), "explored east: now 96 blocks east from where you started, at 96 64 0; the nearest oak_log you know of is 16 blocks west, around 80 2: get_items oak_log goes there and gathers it");
  // Seen before, out of sight now: the bot data's record counts too.
  const seen = new FakeRuntime();
  seen.seen = { spruce_log: { dimension: "overworld", x: -366, z: -18 } };
  const recorded = await runStep(stepSchema.parse({ skill: "explore", toward: "north", for: "spruce_log" }), contextFor(seen));
  assert.match("detail" in recorded ? recorded.detail : "", /the nearest spruce_log you know of is \d+ blocks west, around -366 -18: get_items spruce_log goes there/u);
});

test("a walk that stopped is not \"done\" because the block is in sight farther off: it says why it stopped", async () => {
  // Live 2026-10-07: "explored north: now 0 blocks ... the nearest spruce_log is 169 blocks" returned done, forty times.
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 } };
  runtime.failures.navigate = "[NAVIGATION_STOPPED] Pathfinder stopped: planning_stalled.";
  const result = await runStep(stepSchema.parse({ skill: "explore", toward: "east", for: "dark_oak_log" }), contextFor(runtime));
  assert.match(result.status === "failed" ? result.detail : "", /^exploring east stopped \(\[NAVIGATION_STOPPED\] Pathfinder stopped: planning_stalled\.\): now 0 blocks/u);
});

test("explore for an animal walks leg by leg and stops on the leg where one comes into sight, saying which way and how far", async () => {
  // Live 2026-10-09, 10 bots: five needed sheep (wool for a bed) and asked explore for sheep, pig, zombie.
  const sheep = { name: "sheep", hostile: false, count: 3, distance: 23, position: { x: 112, y: 64, z: -16 } };
  const runtime = new MobsLoadAt(96, [sheep]);
  runtime.walkOnNavigate = true;
  runtime.notBlocks = new Set(["sheep"]);
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 } };
  const result = await runStep(stepSchema.parse({ skill: "explore", toward: "east", chunks: 8, for: "sheep" }), contextFor(runtime));
  // The first leg of 96 blocks brought the sheep into the list: the second leg is not walked.
  assert.deepEqual(runtime.submitted.map((call) => [call.tool, call.input.x, call.input.z]), [["navigate", 96, 0]]);
  assert.equal(withoutWays(result.status === "done" ? result.detail : ""), "explored east: now 96 blocks east from where you started, at 96 64 0; found sheep 23 blocks north-east, around 112 -16: get_items what you want from it hunts it there");
});

test("explore for an animal that never comes into sight ends as today, saying none was seen; one already in sight is not walked to", async () => {
  const none = new FakeRuntime();
  none.walkOnNavigate = true;
  none.notBlocks = new Set(["pig"]);
  none.snapshot = { ...none.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, mobs: [{ name: "sheep", hostile: false, count: 2, distance: 9 }] };
  const result = await runStep(stepSchema.parse({ skill: "explore", toward: "east", chunks: 8, for: "pig" }), contextFor(none));
  assert.deepEqual(none.submitted.map((call) => [call.tool, call.input.x, call.input.z]), [["navigate", 96, 0], ["navigate", 128, 0]]);
  assert.equal(withoutWays(result.status === "done" ? result.detail : ""), "explored east: now 128 blocks east from where you started, at 128 64 0; no pig seen on the way");

  // Already loaded: say so, no walk (get_items hunts it where it is).
  const near = new FakeRuntime();
  near.notBlocks = new Set(["zombie"]);
  near.snapshot = { ...near.snapshot, mobs: [{ name: "zombie", hostile: true, count: 1, distance: 40 }] };
  const here = await runStep(stepSchema.parse({ skill: "explore", toward: "east", for: "zombie" }), contextFor(near));
  assert.equal(near.submitted.length, 0);
  assert.match(here.status === "done" ? here.detail : "", /^zombie already in sight, 40 blocks away: get_items what you want from it hunts it there$/u);
});

test("explore for a name that is neither a block nor a creature keeps the refusal; a block is unchanged", async () => {
  const runtime = new FakeRuntime();
  runtime.walkOnNavigate = true;
  runtime.notBlocks = new Set(["water_source", "unicorn"]);
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 } };
  for (const name of ["water_source", "unicorn"]) {
    const refused = await runStep(stepSchema.parse({ skill: "explore", toward: "east", for: name }), contextFor(runtime));
    assert.equal(refused.status, "failed");
    assert.match("detail" in refused ? refused.detail : "", new RegExp(`^${name} is not a block: explore looks for a block by its Minecraft name`, "u"));
  }
  assert.equal(runtime.submitted.length, 0);
  // A block is looked for as ever.
  const block = await runStep(stepSchema.parse({ skill: "explore", toward: "east", for: "dark_oak_log" }), contextFor(runtime));
  assert.equal(withoutWays(block.status === "done" ? block.detail : ""), "explored east: now 64 blocks east from where you started, at 64 64 0; no dark_oak_log seen on the way");
});

test("a recorded place found empty is not offered again: explore no longer sends her back to it", async () => {
  // Live 2026-10-07: spruce "seen" 6 blocks from Ayla, none loaded; explore kept sending her back for 15 minutes.
  const runtime = new FakeRuntime();
  runtime.failures.collect_block = "[NO_TARGET_IN_RANGE] No spruce_log block left within 64 blocks of where the run started; none is loaded farther either.";
  runtime.seen = { spruce_log: { dimension: "overworld", x: 6, z: -6 } };
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 } };
  const near = await runStep({ skill: "collect_block", block: "spruce_log", count: 3 }, contextFor(runtime));
  assert.match(near.status === "failed" ? near.detail : "", /^no spruce_log within 64 blocks, and you know of none farther away/u);
  runtime.snapshot = { ...runtime.snapshot, position: { x: 200.5, y: 64, z: 0.5 } };
  const result = await runStep(stepSchema.parse({ skill: "explore", toward: "east", for: "spruce_log" }), contextFor(runtime));
  assert.match("detail" in result ? result.detail : "", /no spruce_log seen on the way/u);
});

test("explore names only blocks she may take: a log in a wall of her protected house is not \"the nearest\"", async () => {
  // Live 2026-10-04: all 48 oak logs near Ayla were walls of her houses, and explore kept naming them.
  const runtime = new FakeRuntime();
  runtime.walkOnNavigate = true;
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 } };
  runtime.world.set("40,64,0", "oak_log");
  runtime.world.set("150,64,0", "oak_log");
  const house = { regionId: 4, label: "small medieval house", owner: "Ayla", reason: "", min: { x: 36, y: 60, z: -4 }, max: { x: 44, y: 70, z: 4 } } as unknown as ProtectedArea;
  const result = await runStep(stepSchema.parse({ skill: "explore", toward: "east", for: "oak_log" }), contextFor(runtime, { areas: [house] }));
  assert.equal(withoutWays(result.status === "done" ? result.detail : ""), "explored east: now 64 blocks east from where you started, at 64 64 0; the nearest oak_log you know of is 86 blocks east, around 150 0: get_items oak_log goes there and gathers it");
});

test("explore does not set off toward ground she knows to be mostly water, and says how much water she crossed", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 8, y: 64, z: 8 } };
  // Chunks north of her: the ocean she saw before.
  runtime.walkOnNavigate = true;
  runtime.water = { "0,-1": 0.9, "0,-2": 0.95, "1,0": 0.25, "2,0": 0, "3,0": 0, "4,0": 0 };
  const refused = await runStep(stepSchema.parse({ skill: "explore", toward: "north" }), contextFor(runtime));
  assert.deepEqual(refused, { status: "failed", detail: "north is water as far as you have seen (93% of the next 2 chunks): explore another way, carry a boat to cross it, or say so" });
  assert.deepEqual(runtime.submitted, []);
  const east = await runStep(stepSchema.parse({ skill: "explore", toward: "east" }), contextFor(runtime));
  assert.match(withoutWays(east.status === "done" ? east.detail : ""), /; 6% of the ground crossed was water$/u);
});

test("with a boat, explore sets off over the water: one leg to the whole distance, for navigate to cross by boat", async () => {
  // Live 2026-10-04: Vex made a boat to explore south-east, then was refused "water as far as you have seen" again.
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 8, y: 64, z: 8 }, inventory: [{ name: "oak_boat", count: 1 }] };
  runtime.walkOnNavigate = true;
  runtime.water = { "0,-1": 0.9, "0,-2": 0.95, "0,-3": 0.95, "0,-4": 0.9 };
  const result = await runStep(stepSchema.parse({ skill: "explore", toward: "north" }), contextFor(runtime));
  assert.equal(result.status, "done");
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "navigate").map((call) => call.input), [{ x: 8, z: -56, near_y: 64, range: 4 }]);
});

test("the boat is a carried item of the boat family (B6: a bamboo_raft is one), and a name ending in _boat with no family is none", async () => {
  const sail = async (inventory: { name: string; count: number; families: string[] }[]) => {
    const runtime = new FakeRuntime();
    runtime.snapshot = { ...runtime.snapshot, position: { x: 8, y: 64, z: 8 }, inventory };
    runtime.walkOnNavigate = true;
    runtime.water = { "0,-1": 0.9, "0,-2": 0.95, "0,-3": 0.95, "0,-4": 0.9 };
    return runStep(stepSchema.parse({ skill: "explore", toward: "north" }), contextFor(runtime));
  };
  assert.equal((await sail([{ name: "bamboo_raft", count: 1, families: ["boat"] }])).status, "done");
  const none = await sail([{ name: "paper_boat", count: 1, families: [] }]);
  assert.match(none.status === "failed" ? none.detail : "", /^north is water as far as you have seen/u);
});

test("out on the water, explore names the nearest land instead of another way", async () => {
  // Live 2026-10-04: Vex, 104 blocks out over water, was refused all eight ways, fifteen steps in a row.
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 8, y: 62, z: 8 } };
  runtime.water = { "0,0": 1, "-1,0": 1, "1,0": 1, "2,0": 1, "0,-1": 1, "0,-2": 1, "-3,0": 0.1 };
  runtime.world.set("8,61,8", "water");
  const result = await runStep(stepSchema.parse({ skill: "explore", toward: "east" }), contextFor(runtime));
  assert.deepEqual(result, { status: "failed", detail: "you are out on the water, and east is water as far as you have seen (100% of the next 2 chunks); the nearest land you have seen is 48 blocks west, around -40 8: go_to there first" });
  // On dry ground by the sea (live 2026-10-07: Ayla on a hill), the chunk's water is no reason to say so.
  runtime.world.set("8,61,8", "stone");
  const ashore = await runStep(stepSchema.parse({ skill: "explore", toward: "east" }), contextFor(runtime));
  assert.match(ashore.status === "failed" ? ashore.detail : "", /^east is water as far as you have seen .*: explore another way, carry a boat to cross it, or say so$/u);
});

test("a leg over caves or under trees goes to the ground nearest her own height, in one call", async () => {
  // Live 2026-10-04: navigate without y refused columns with caves under them ([NAVIGATION_HEIGHT_REQUIRED]); live
  // 2026-10-07: the refused first call and its retry showed as errors. near_y lets the runtime take that floor.
  const runtime = new FakeRuntime();
  runtime.walkOnNavigate = true;
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 } };
  const result = await runStep(stepSchema.parse({ skill: "explore", toward: "east", chunks: 2 }), contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.map((call) => [call.input.x, call.input.y, call.input.near_y, call.input.z]), [[32, undefined, 64, 0]]);
});

test("explore stopped on the way says why and where it got to; known water ahead ends the walk where it is", async () => {
  const runtime = new FakeRuntime();
  runtime.failures.navigate = "[NAVIGATION_TARGET_WATER] The ground at 0, 32 is water, and no dry ground the bot can stand on lies within 8 blocks of it.";
  const result = await runStep(stepSchema.parse({ skill: "explore", toward: "south" }), contextFor(runtime));
  assert.match(result.status === "failed" ? result.detail : "", /^exploring south stopped \(\[NAVIGATION_TARGET_WATER\] .*\): now 0 blocks /u);

  const shore = new FakeRuntime();
  shore.walkOnNavigate = true;
  shore.snapshot = { ...shore.snapshot, position: { x: 8, y: 64, z: 8 } };
  shore.water = { "3,0": 1, "4,0": 1 };
  const stopped = await runStep(stepSchema.parse({ skill: "explore", toward: "east" }), contextFor(shore));
  assert.match(stopped.status === "failed" ? stopped.detail : "", /^exploring east stopped \(east is water as far as you have seen \(100% of the next 2 chunks\)\): now 32 blocks east/u);
});

test("explore for an item that only drops from blocks names those blocks and says the drop is rare", async () => {
  // Run 12: Sana and Mira explored "for apple" and were only told it is not a block, then spent 15-23 minutes on leaves.
  const runtime = new FakeRuntime();
  runtime.notBlocks = new Set(["apple"]);
  runtime.dropSources = { ...runtime.dropSources, apple: [{ block: "oak_leaves", chance: 0.005, planted: false }, { block: "dark_oak_leaves", chance: 0.005, planted: false }] };
  const result = await runStep(stepSchema.parse({ skill: "explore", toward: "east", for: "apple" }), contextFor(runtime));
  assert.equal(result.status, "failed");
  const detail = result.status === "failed" ? result.detail : "";
  assert.match(detail, /^apple is not a block/u);
  assert.match(detail, /apple drops from oak_leaves, dark_oak_leaves/u);
  assert.match(detail, /rare \(0\.5% of breaks\)/u);
  assert.deepEqual(runtime.submitted, []);
});

test("the explore template marks for as optional, and the refusal of a word like none says to leave it out", async () => {
  // Run 15: 86 explore steps with "for": "none", 6 with "unknown".
  assert.match(skillUsage("explore", "europe"), /"for":"<block or creature id, optional: leave it out to just explore>"/u);
  const runtime = new FakeRuntime();
  runtime.notBlocks = new Set(["none"]);
  const refused = await runStep(stepSchema.parse({ skill: "explore", toward: "east", for: "none" }), contextFor(runtime));
  assert.equal(refused.status, "failed");
  assert.match("detail" in refused ? refused.detail : "", /leave "for" out to just explore/u);
});

test("the get_items line says it walks to the nearest known places, how many, and that it takes minutes", () => {
  // The line promised a go_to step the bot never had: it says what the gathering does (fetch-farther.ts).
  const usage = skillUsage("get_items", "europe");
  assert.ok(usage.includes("it fetches within 64 blocks, else walks to the nearest places where you saw some (up to 5) and gathers there; when it knows of none, it says so (explore for it); takes minutes"), usage);
  assert.ok(!usage.includes("going there is a go_to step of its own"), usage);
});

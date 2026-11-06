// Tests of the get_items skill: fetching, smelting, tools that break, buckets, boats and rare drops.
import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import { fuelsOf } from "#src/world/smelting.ts";
import { runStep } from "../skills.ts";
import { RARE_DROP_BREAKS } from "../gathering/how-to-get.ts";
import { FakeRuntime, SMALL_MEDIEVAL_HOUSE as SMALL_MEDIEVAL } from "../testing.ts";
import { contextFor, describeCall, HOUSE_RECIPES, needsOnlyTools, GLASS_RECIPES } from "./skill-fixtures.test.ts";

/** Run 13: Brea's shovel broke while digging dirt; dirt drops by hand, so the fetch went on bare-handed and never asked for another. */
const SHOVEL_RECIPES = { ...HOUSE_RECIPES, wooden_shovel: { makes: 1, needs: [{ item: "oak_planks", count: 1 }, { item: "stick", count: 2 }] } };

const shovelLost = (runtime: FakeRuntime, dirt: number) => ({
  error: "[TOOL_TIER_LOST] wooden_shovel was lost at 1,64,2; no shovel remains. Broke 6 matching blocks; inventory gained 6/16 requested items.",
  result: { collected: { requested: 16, gained: dirt, gainedByItem: { dirt }, blocksBroken: dirt, brokenAt: [], toolLost: { item: "wooden_shovel", class: "shovel" } } },
  effect: () => {
    runtime.addItem("dirt", dirt);
    runtime.addItem("wooden_shovel", -1);
  },
});

function smeltRuntime(inventory: { name: string; count: number }[] = []): FakeRuntime {
  const runtime = new FakeRuntime();
  runtime.recipes = GLASS_RECIPES;
  runtime.smelting = { glass: ["sand", "red_sand"], iron_ingot: ["deepslate_iron_ore", "iron_ore", "raw_iron"], coal: ["coal_ore", "deepslate_coal_ore"], cooked_beef: ["beef"] };
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory };
  return runtime;
}

function smeltCalls(runtime: FakeRuntime) {
  return runtime.submitted.filter((call) => call.tool === "smelt_item").map((call) => call.input);
}

/** The fuel table the brain gets from the runtime: `view_smelting_recipes`' `fuels` (`fuelsOf`), as `runtime-client.ts` reads it. */
const RUNTIME_FUELS_1_21_4: Readonly<Record<string, number>> = Object.fromEntries(fuelsOf(Object.keys(minecraftData("1.21.4").itemsByName), "1.21.4").map(({ item, itemsSmelted }) => [item, itemsSmelted]));

/** Run 14 review N13: the boat of a wood is found from the recipe data, not by cutting the wood's name at its last word. */
const BOAT_ASKS = async (wood: string, tags: Record<string, readonly string[]>) => {
  const runtime = new FakeRuntime();
  runtime.recipes = { oak_boat: { makes: 1, needs: [{ item: "oak_planks", count: 5 }] }, birch_boat: { makes: 1, needs: [{ item: "birch_planks", count: 5 }] } };
  runtime.blockTags = { ...runtime.blockTags, oak_log: ["logs", "oak_logs"], birch_log: ["logs", "birch_logs"], spruce_log: ["logs", "spruce_logs"], ...tags };
  runtime.failures.collect_block = "[NO_TARGET_IN_RANGE] No oak_log block left within 64 blocks of where the run started; none is loaded farther either.";
  runtime.seen = { oak_log: { dimension: "overworld", x: 700, z: 8 } };
  runtime.water = Object.fromEntries(Array.from({ length: 40 }, (_unused, index) => [`${index + 1},0`, 1]));
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: wood, count: 5 }] };
  const asked: string[] = [];
  const lookup = runtime.craftingNeeds.bind(runtime);
  runtime.craftingNeeds = async (items, prefer) => {
    asked.push(...items.map((entry) => entry.item));
    return lookup(items, prefer);
  };
  const result = await runStep({ skill: "collect_block", block: "oak_log", count: 3 }, contextFor(runtime));
  return { asked, detail: result.status === "failed" ? result.detail : "" };
};

/** A pickaxe breaking after `stone` blocks; `then` is what the next collect does (another loss, or nothing: it succeeds). */
function pickaxeLost(runtime: FakeRuntime, stone: number, then?: () => void) {
  return {
    error: `[TOOL_TIER_LOST] wooden_pickaxe was lost; no pickaxe remains. Broke ${stone} matching blocks.`,
    result: { collected: { requested: 16, gained: stone, gainedByItem: { cobblestone: stone }, blocksBroken: stone, brokenAt: [], toolLost: { item: "wooden_pickaxe", class: "pickaxe" } } },
    effect: () => {
      runtime.addItem("cobblestone", stone);
      runtime.addItem("wooden_pickaxe", -1);
      then?.();
    },
  };
}

test("a carried crafting table with no dry cell around is set down on the nearest land she has seen", async () => {
  // Live 2026-10-07: at the water's edge, "crafting_table: no_cell", and the boat she needed was never crafted.
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.walkOnNavigate = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_log", count: 4 }, { name: "crafting_table", count: 1 }] };
  runtime.water = { "0,0": 1, "2,0": 0 };
  runtime.failNext.craft_item = { error: "[WORKSTATION_PLACEMENT_FAILED] crafting_table: no_cell (no dry, clear cell with something solid to set it on within reach: in water, a tunnel or a crowded spot); move to open dry ground first." };
  const result = await runStep({ skill: "get_items", items: [{ item: "oak_door", count: 3 }] }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  // Then back to where the step started, as every get_items does.
  assert.deepEqual(runtime.submitted.map((call) => [call.tool, call.input.x]).filter(([tool]) => tool !== "collect_block"), [["craft_item", undefined], ["navigate", 40], ["craft_item", undefined], ["navigate", 0]]);
});

test("get_items fetches items like a player: logs, a table to carry, a wooden pickaxe for stone, then the crafts", async () => {
  const runtime = smeltRuntime();
  const items = SMALL_MEDIEVAL.map(({ name, count }) => ({ item: name, count }));
  const result = await runStep({ skill: "get_items", items }, contextFor(runtime));
  assert.equal(result.status, "done");
  // Glass panes for the windows: sand with the rest, the furnace crafted with the house blocks, glass smelted with
  // planks, then the panes and the planks the fuel used up.
  assert.deepEqual([...new Set(runtime.submitted.map(describeCall))], [
    "collect oak_log",
    "collect sand",
    "collect spruce_log",
    "craft crafting_table",
    "craft wooden_pickaxe at table",
    "collect stone",
    "craft spruce_stairs+oak_planks+spruce_slab+oak_door+furnace at table",
    "smelt_item",
    "craft oak_planks+glass_pane at table",
  ]);
  assert.ok(runtime.submitted.filter((call) => call.tool === "collect_block").every((call) => Number(call.input.count) <= 32));
});

test("a pickaxe that breaks while digging is a setback, not a failure: another one is crafted and digging goes on", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_log", count: 10 }, { name: "crafting_table", count: 1 }, { name: "wooden_pickaxe", count: 1 }] };
  runtime.failNext.collect_block = {
    error: "[TOOL_TIER_LOST] wooden_pickaxe was lost; no pickaxe remains. Broke 15 matching blocks; inventory gained 15/16 requested items.",
    effect: () => {
      runtime.addItem("cobblestone", 15);
      runtime.addItem("wooden_pickaxe", -1);
    },
  };
  const result = await runStep({ skill: "get_items", items: [{ item: "cobblestone", count: 16 }] }, contextFor(runtime));
  assert.equal(result.status, "done");
  // The logs the new pickaxe used are hers to use: nothing is chopped to replace them (live 2026-10-04: Tom).
  assert.deepEqual(runtime.submitted.map(describeCall), ["collect stone", "craft wooden_pickaxe at table", "collect stone"]);
});

test("a shovel that breaks mid-fetch is made again for the dirt still to dig, though dirt drops by hand", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = SHOVEL_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_shovel", count: 1 }, { name: "oak_log", count: 10 }, { name: "crafting_table", count: 1 }] };
  runtime.failNext.collect_block = shovelLost(runtime, 6);
  const result = await runStep({ skill: "get_items", items: [{ item: "dirt", count: 16 }] }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.map(describeCall), ["collect dirt", "craft wooden_shovel at table", "collect dirt"]);
  // The setback is told, with the tool that broke.
  assert.match(result.status === "done" ? result.detail : "", /setback \(\[TOOL_TIER_LOST\] wooden_shovel was lost/u);
});

test("a tool that breaks with nothing left to dig for its class is not made again", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = SHOVEL_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_shovel", count: 1 }, { name: "oak_log", count: 10 }, { name: "crafting_table", count: 1 }] };
  // It broke on the last block: all 16 are carried.
  runtime.failNext.collect_block = shovelLost(runtime, 16);
  const result = await runStep({ skill: "get_items", items: [{ item: "dirt", count: 16 }] }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.map(describeCall), ["collect dirt"]);
});

test("a fetch that broke its shovel and cannot make another goes on by hand: dirt needs no tool", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = SHOVEL_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_shovel", count: 1 }, { name: "oak_log", count: 10 }, { name: "crafting_table", count: 1 }] };
  // The replacement cannot be made.
  runtime.failures.craft_item = "[CRAFT_FAILED] no recipe works here";
  runtime.failNext.collect_block = shovelLost(runtime, 6);
  const result = await runStep({ skill: "get_items", items: [{ item: "dirt", count: 16 }] }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_block").length, 2);
});

test("a pickaxe that breaks with stone still to dig is made again from the structured loss, even when the stop reason names nothing", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_log", count: 10 }, { name: "crafting_table", count: 1 }, { name: "wooden_pickaxe", count: 1 }] };
  runtime.failNext.collect_block = {
    error: "[SOMETHING_ODD] stopped after 15 matching blocks",
    result: { collected: { requested: 16, gained: 15, gainedByItem: { cobblestone: 15 }, blocksBroken: 15, brokenAt: [], toolLost: { item: "wooden_pickaxe", class: "pickaxe" } } },
    effect: () => {
      runtime.addItem("cobblestone", 15);
      runtime.addItem("wooden_pickaxe", -1);
    },
  };
  const result = await runStep({ skill: "get_items", items: [{ item: "cobblestone", count: 16 }] }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.map(describeCall), ["collect stone", "craft wooden_pickaxe at table", "collect stone"]);
});

test("the harvest tool comes from game data and climbs the tiers: a wooden pickaxe for the stone of a stone one for iron ore", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = { ...HOUSE_RECIPES, stone_pickaxe: { makes: 1, needs: [{ item: "cobblestone", count: 3 }, { item: "stick", count: 2 }] } };
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_log", count: 10 }, { name: "crafting_table", count: 1 }] };
  // Iron ore drops raw iron (game data): without silk touch, the ore block itself is never gathered.
  const result = await runStep({ skill: "get_items", items: [{ item: "raw_iron", count: 2 }] }, contextFor(runtime));
  assert.equal(result.status, "done", result.status === "done" ? "" : JSON.stringify(result));
  const calls = runtime.submitted.map(describeCall);
  assert.deepEqual(calls.filter((call) => call.startsWith("craft")), ["craft wooden_pickaxe at table", "craft stone_pickaxe at table"]);
  assert.ok(calls.indexOf("collect stone") > calls.indexOf("craft wooden_pickaxe at table"), calls.join(" | "));
  assert.ok(calls.indexOf("collect iron_ore") > calls.indexOf("craft stone_pickaxe at table"), calls.join(" | "));
});

test("an item asked for by a wrong name is answered by the runtime, and an ore block with what it drops", async () => {
  const runtime = new FakeRuntime();
  // Live 2026-10-07: "sticks", three steps in a row; the runtime's answer names the ids close to it.
  runtime.notItems = new Set(["sticks"]);
  const plural = await runStep({ skill: "get_items", items: [{ item: "sticks", count: 4 }] }, contextFor(runtime));
  assert.deepEqual(plural, { status: "failed", detail: "[UNKNOWN_CRAFT_ITEMS] Minecraft has no registry items named: sticks." });
  // Live 2026-10-07: Vex asked for iron_ore, which only silk touch gets; what it drops comes from the game data.
  runtime.notDropped = new Set([...runtime.notDropped, "iron_ore"]);
  const ore = await runStep({ skill: "get_items", items: [{ item: "iron_ore", count: 2 }] }, contextFor(runtime));
  assert.deepEqual(ore, { status: "failed", detail: "iron_ore is never got as itself: broken, it drops raw_iron; get_items raw_iron" });
});

test("get_items gathers an item from the block that drops it, from game data: wheat seeds from grass", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  const result = await runStep({ skill: "get_items", items: [{ item: "wheat_seeds", count: 8 }] }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.map((call) => [call.tool, call.input.block_name, call.input.count]), [["collect_block", "short_grass", 8]]);
});

test("among equally likely sources, the nearest loaded one is broken", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.world.set("2,64,0", "fern");
  runtime.world.set("30,64,0", "short_grass");
  await runStep({ skill: "get_items", items: [{ item: "wheat_seeds", count: 2 }] }, contextFor(runtime));
  assert.deepEqual(runtime.submitted.map((call) => call.input.block_name), ["fern"]);
});

test("the iron for a bucket is mined as iron ore (raw iron is its drop), then smelted and crafted", async () => {
  const runtime = smeltRuntime([{ name: "oak_log", count: 10 }, { name: "crafting_table", count: 1 }, { name: "stone_pickaxe", count: 1 }, { name: "furnace", count: 1 }, { name: "coal", count: 4 }]);
  runtime.recipes = { ...GLASS_RECIPES, bucket: { makes: 1, needs: [{ item: "iron_ingot", count: 3 }] } };
  const result = await runStep({ skill: "get_items", items: [{ item: "bucket", count: 1 }] }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  const calls = runtime.submitted.map(describeCall);
  assert.ok(calls.includes("collect iron_ore"), calls.join(" | "));
  assert.ok(!calls.includes("collect raw_iron"), calls.join(" | "));
});

test("an item that only grows as a crop is not gathered from someone's farm: get_items says to farm it", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.dropSources = { ...runtime.dropSources, wheat: [{ block: "wheat", chance: 1, planted: true }] };
  const result = await runStep({ skill: "get_items", items: [{ item: "wheat", count: 3 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /wheat grows as a crop: farm it/u);
  assert.deepEqual(runtime.submitted, []);
});

test("what get_items fetches is not scaffolding meanwhile; the scaffold list is put back after", async () => {
  // Live 2026-10-04: walking out of a cave, Tom's routes used 16 of the 36 cobblestone fetched for his house.
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, policy: { revision: "r1", digStraightDown: false, scaffoldBlocks: ["dirt", "cobblestone"] } };
  const result = await runStep({ skill: "get_items", items: [{ item: "dirt", count: 4 }] }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.scaffoldSettings, [["cobblestone"], ["dirt", "cobblestone"]]);
});

test("what get_items carries is not struck off the scaffold list: only the bill and the crafted keep are", async () => {
  // Review B7: every carried scaffold block (dirt, cobblestone) came off the list for the whole fetch.
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "dirt", count: 20 }], policy: { revision: "r1", digStraightDown: false, scaffoldBlocks: ["dirt", "cobblestone"] } };
  const result = await runStep({ skill: "get_items", items: [{ item: "oak_planks", count: 4 }] }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.scaffoldSettings, []);
});

test("an item no block drops, and nothing crafts or smelts, ends get_items saying so", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  const result = await runStep({ skill: "get_items", items: [{ item: "glass_pane", count: 1 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /no block or mob drops glass_pane, and it is not crafted or smelted/u);
  assert.deepEqual(runtime.submitted, []);
});

test("a water bucket is a carried bucket filled at water", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "bucket", count: 1 }] };
  const result = await runStep({ skill: "get_items", items: [{ item: "water_bucket", count: 1 }] }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.map((call) => [call.tool, call.input]), [["use_bucket", { action: "fill", liquid: "water" }]]);
  assert.ok(runtime.snapshot.inventory.some((stack) => stack.name === "water_bucket"));
});

test("a full bucket is filled only with a liquid the use_bucket contract lists: others get the generic refusal", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "bucket", count: 1 }] };
  runtime.notDropped = new Set(["milk_bucket", "lava_bucket"]);
  const milk = await runStep({ skill: "get_items", items: [{ item: "milk_bucket", count: 1 }] }, contextFor(runtime));
  assert.equal(milk.status, "failed");
  assert.ok(!runtime.submitted.some((call) => call.tool === "use_bucket"), "no fill for milk");
  // The liquids come from the contract: with only water listed, a lava bucket is no fill either.
  runtime.toolEnums = { "use_bucket.liquid": ["water"] };
  const lava = await runStep({ skill: "get_items", items: [{ item: "lava_bucket", count: 1 }] }, contextFor(runtime));
  assert.equal(lava.status, "failed");
  assert.ok(!runtime.submitted.some((call) => call.tool === "use_bucket"), "no fill for a liquid the contract does not list");
  runtime.toolEnums = { "use_bucket.liquid": ["water", "lava"] };
  const listed = await runStep({ skill: "get_items", items: [{ item: "lava_bucket", count: 1 }] }, contextFor(runtime));
  assert.equal(listed.status, "done", JSON.stringify(listed));
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "use_bucket").map((call) => call.input), [{ action: "fill", liquid: "lava" }]);
});

test("a water bucket without a bucket crafts one from iron first, then fills it", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "crafting_table", count: 1 }, { name: "iron_ingot", count: 3 }] };
  runtime.recipes = { bucket: { makes: 1, needs: [{ item: "iron_ingot", count: 3 }] } };
  const result = await runStep({ skill: "get_items", items: [{ item: "water_bucket", count: 1 }] }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.map((call) => call.tool), ["craft_item", "use_bucket"]);
});

test("get_items of a water bucket with no bucket carried makes the bucket first, then fills it", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "crafting_table", count: 1 }, { name: "iron_ingot", count: 3 }] };
  runtime.recipes = { bucket: { makes: 1, needs: [{ item: "iron_ingot", count: 3 }] } };
  const result = await runStep({ skill: "get_items", items: [{ item: "water_bucket", count: 1 }] }, contextFor(runtime));
  assert.deepEqual(result, { status: "done", detail: "got 1 water_bucket, now carrying 1 water_bucket (crafted 1 bucket, filled a bucket with water)" });
  assert.deepEqual(runtime.submitted.map((call) => [call.tool, call.input]), [
    ["craft_item", { items: [{ item_name: "bucket", count: 1 }], temporary_workstation: true }],
    ["use_bucket", { action: "fill", liquid: "water" }],
  ]);
});

test("a fill that finds no water ends get_items with the runtime's words", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "bucket", count: 1 }] };
  runtime.failures.use_bucket = "[BUCKET_NO_SOURCE] No water source in any loaded column.";
  const result = await runStep({ skill: "get_items", items: [{ item: "water_bucket", count: 1 }] }, contextFor(runtime));
  assert.match(result.status === "failed" ? result.detail : "", /BUCKET_NO_SOURCE/u);
});

test("the boat named across water is the one her carried wood makes, oak_boat when it says nothing", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = { birch_boat: { makes: 1, needs: [{ item: "birch_planks", count: 5 }] }, oak_boat: { makes: 1, needs: [{ item: "oak_planks", count: 5 }] } };
  runtime.failures.collect_block = "[NO_TARGET_IN_RANGE] No oak_log block left within 64 blocks of where the run started; none is loaded farther either.";
  runtime.seen = { oak_log: { dimension: "overworld", x: 700, z: 8 } };
  runtime.water = Object.fromEntries(Array.from({ length: 40 }, (_unused, index) => [`${index + 1},0`, 1]));
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "birch_planks", count: 5 }] };
  const birch = await runStep({ skill: "collect_block", block: "oak_log", count: 3 }, contextFor(runtime));
  assert.match(birch.status === "failed" ? birch.detail : "", /take a boat \(get_items birch_boat\) and go_to there/u);
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "birch_planks", count: 2 }] };
  const short = await runStep({ skill: "collect_block", block: "oak_log", count: 3 }, contextFor(runtime));
  assert.match(short.status === "failed" ? short.detail : "", /get_items birch_boat\)/u, "a recipe the wood has, short of planks");
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "dirt", count: 2 }] };
  const none = await runStep({ skill: "collect_block", block: "oak_log", count: 3 }, contextFor(runtime));
  assert.match(none.status === "failed" ? none.detail : "", /get_items oak_boat\)/u);
});

test("get_items hunts what an animal gives instead of crafting it the long way: wool from sheep, not from string", async () => {
  // Live 2026-10-04: a first bed planned "12 string"; Tom walked 200-300 blocks three ways and never hunted sheep.
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.recipes = { white_wool: { makes: 1, needs: [{ item: "string", count: 4 }] }, arrow: { makes: 4, needs: [{ item: "flint", count: 1 }] } };
  runtime.mobDrops = {
    white_wool: [{ mob: "sheep", chance: 1, hostile: false }],
    beef: [{ mob: "cow", chance: 1, hostile: false }],
    arrow: [{ mob: "skeleton", chance: 1, hostile: true }],
  };
  const wool = await runStep({ skill: "get_items", items: [{ item: "white_wool", count: 3 }, { item: "beef", count: 2 }] }, contextFor(runtime));
  assert.equal(wool.status, "done", JSON.stringify(wool));
  assert.deepEqual(runtime.submitted.map((call) => [call.tool, call.input.mob_name, call.input.drop_name, call.input.count]), [
    ["collect_mob_drop", "sheep", "white_wool", 3],
    ["collect_mob_drop", "cow", "beef", 2],
  ]);
  // A fight is no source when a craft will do: arrows are crafted, not taken from skeletons.
  await runStep({ skill: "get_items", items: [{ item: "arrow", count: 4 }] }, contextFor(runtime));
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_mob_drop" && call.input.mob_name === "skeleton").length, 0);
});

test("get_items refuses a drop only hostile mobs give on a peaceful server, before walking; an animal's drop is still hunted", async () => {
  // Run 12: HUNT_TARGET_NOT_LOADED for rotten_flesh and bone, the server being peaceful (no zombie ever spawns).
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.mobDrops = {
    rotten_flesh: [{ mob: "zombie", chance: 1, hostile: true }],
    beef: [{ mob: "cow", chance: 1, hostile: false }],
  };
  runtime.snapshot = { ...runtime.snapshot, difficulty: "peaceful" };
  const flesh = await runStep({ skill: "get_items", items: [{ item: "rotten_flesh", count: 2 }] }, contextFor(runtime));
  assert.equal(flesh.status, "failed");
  assert.match(flesh.status === "failed" ? flesh.detail : "", /no zombie spawns on this peaceful server: rotten_flesh cannot be hunted here/u);
  assert.equal(runtime.submitted.length, 0, "refused before any action");

  const beef = await runStep({ skill: "get_items", items: [{ item: "beef", count: 2 }] }, contextFor(runtime));
  assert.equal(beef.status, "done", JSON.stringify(beef));

  runtime.snapshot = { ...runtime.snapshot, difficulty: "normal" };
  const normal = await runStep({ skill: "get_items", items: [{ item: "rotten_flesh", count: 2 }] }, contextFor(runtime));
  assert.equal(normal.status, "done", JSON.stringify(normal));
});

test("items that cannot be found end get_items, saying why", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.failures.collect_block = "[NO_LOADED_MATCHING_TARGETS] Observed 0 loaded spruce_log blocks.";
  const result = await runStep({ skill: "get_items", items: [{ item: "spruce_planks", count: 8 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /^no \w+ within 64 blocks that you may take, and you know of none farther away outside protected areas: explore for it \(toward land you have not seen\), use another material, or say so \(\[NO_LOADED_MATCHING_TARGETS\]/u);
});

test("get_items with none near she may take goes to the nearest place she saw it, however far, never into a protected area", async () => {
  // Live 2026-10-04: every oak log near Ayla was a wall of her houses, a forest 140 blocks off, and every order failed.
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.walkOnNavigate = true;
  runtime.simulateInventory = true;
  runtime.failNext.collect_block = { error: "[NO_REACHABLE_MATCHING_TARGETS] Every loaded oak_log block was found but none could be reached. Last routing stop: 48 loaded matching block(s) cannot be mined: inside protected region #4 'small medieval house' (owner Ayla) (×48)" };
  runtime.seen = { oak_log: { dimension: "overworld", x: 150, z: 8 } };
  const result = await runStep({ skill: "get_items", items: [{ item: "oak_log", count: 4 }] }, contextFor(runtime));
  assert.equal(result.status, "done");
  assert.deepEqual(runtime.submitted.slice(0, 3).map((call) => [call.tool, call.input.x ?? call.input.block_name]), [["collect_block", "oak_log"], ["navigate", 150], ["collect_block", "oak_log"]]);

  const far = new FakeRuntime();
  far.recipes = HOUSE_RECIPES;
  far.walkOnNavigate = true;
  far.simulateInventory = true;
  far.failNext.collect_block = { error: "[NO_TARGET_IN_RANGE] No oak_log block left within 64 blocks of where the run started; none is loaded farther either." };
  far.seen = { oak_log: { dimension: "overworld", x: 900, z: 0 } };
  const walked = await runStep({ skill: "get_items", items: [{ item: "oak_log", count: 4 }] }, contextFor(far));
  assert.equal(walked.status, "done", JSON.stringify(walked));
  assert.deepEqual(far.submitted.slice(0, 3).map((call) => [call.tool, call.input.x ?? call.input.block_name]), [["collect_block", "oak_log"], ["navigate", 900], ["collect_block", "oak_log"]]);

  // Owner, 2026-10-07: gathering is mining, and a protected area's blocks are its walls: such a place is never a trip.
  const guarded = new FakeRuntime();
  guarded.recipes = HOUSE_RECIPES;
  guarded.failNext.collect_block = { error: "[NO_TARGET_IN_RANGE] No oak_log block left within 64 blocks of where the run started; none is loaded farther either." };
  guarded.seen = { oak_log: { dimension: "overworld", x: 150, z: 8 } };
  guarded.areas = [{ regionId: 4, owner: "self", label: "small medieval house", min: { x: 145, y: 60, z: 4 }, max: { x: 151, y: 70, z: 10 } }];
  const told = await runStep({ skill: "get_items", items: [{ item: "oak_log", count: 4 }] }, contextFor(guarded));
  assert.match(told.status === "failed" ? told.detail : "", /^no oak_log within 64 blocks that you may take, and you know of none farther away outside protected areas: explore for it/u);
  assert.deepEqual(guarded.submitted.filter((call) => call.tool === "navigate"), []);
});

test("a fetch tells where it is travelling to before the walk and that it arrived after it", async () => {
  const runtime = new FakeRuntime();
  runtime.walkOnNavigate = true;
  runtime.simulateInventory = true;
  runtime.failNext.collect_block = { error: "[NO_TARGET_IN_RANGE] No oak_log block left within 64 blocks of where the run started; none is loaded farther either." };
  runtime.seen = { oak_log: { dimension: "overworld", x: 900, z: 0 } };
  const headings: ({ x: number; z: number } | null)[] = [];
  const result = await runStep({ skill: "get_items", items: [{ item: "oak_log", count: 4 }] }, contextFor(runtime, { heading: (target) => headings.push(target) }));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(headings, [{ x: 900, z: 0 }, null]);
});

test("a fetch stays within 64 blocks and, finding nothing, says where she last saw some and which way", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.failures.collect_block = "[NO_TARGET_IN_RANGE] No dark_oak_log block left within 64 blocks of where the run started; none is loaded farther either.";
  runtime.seen = { dark_oak_log: { dimension: "overworld", x: 700, z: 8 } };
  const result = await runStep({ skill: "collect_block", block: "dark_oak_log", count: 3 }, contextFor(runtime));
  assert.equal(runtime.submitted[0]?.input.max_distance, 64);
  assert.match(result.status === "failed" ? result.detail : "", /^no dark_oak_log within 64 blocks; you saw some 700 blocks east, around 700 64 8: go_to there yourself if it is worth the trip/u);
  // Across the sea she knows: a trip by boat, with one carried or to get first.
  runtime.water = Object.fromEntries(Array.from({ length: 40 }, (_unused, index) => [`${index + 1},0`, 1]));
  const across = await runStep({ skill: "collect_block", block: "dark_oak_log", count: 3 }, contextFor(runtime));
  assert.match(across.status === "failed" ? across.detail : "", /you saw some 700 blocks east, across the water, around 700 64 8: take a boat \(get_items oak_boat\) and go_to there/u);
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_boat", count: 1 }] };
  const boat = await runStep({ skill: "collect_block", block: "dark_oak_log", count: 3 }, contextFor(runtime));
  assert.match(boat.status === "failed" ? boat.detail : "", /go_to there crosses by boat \(you carry one\)/u);
  runtime.water = {};
  runtime.seen = { dark_oak_log: { dimension: "the_nether", x: 40, z: -8 } };
  const nether = await runStep({ skill: "collect_block", block: "dark_oak_log", count: 3 }, contextFor(runtime));
  assert.match(nether.status === "failed" ? nether.detail : "", /you saw some in the nether around 40 -8/u);
  // Live 2026-10-03: a record inside the range just searched is stale (logs cut long ago); it is not offered as a trip.
  runtime.seen = { dark_oak_log: { dimension: "overworld", x: -4, z: 5 } };
  const stale = await runStep({ skill: "collect_block", block: "dark_oak_log", count: 3 }, contextFor(runtime));
  assert.match(stale.status === "failed" ? stale.detail : "", /^no dark_oak_log within 64 blocks, and you know of none farther away/u);
});

/**
 * Live 2026-10-03: the pickaxe Vex crafted used one of the 12 dark oak logs he carried, and get_items walked 700 blocks
 * to replace that one log; live 2026-10-04: Tom's 24 logs, gathered for his house, were "replaced" 24 rounds in a row.
 * Raw materials she carries are what crafting uses: nothing is fetched to replace them.
 */
test("the raw materials she carries are used by the crafts, never fetched again to replace them", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = { ...HOUSE_RECIPES, crafting_table: { makes: 1, needs: [{ item: "oak_log", count: 1 }] } };
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_log", count: 12 }] };
  runtime.failures.collect_block = "[NO_TARGET_IN_RANGE] No oak_log block left within 64 blocks of where the run started; none is loaded farther either.";
  const result = await runStep({ skill: "get_items", items: [{ item: "crafting_table", count: 1 }] }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "collect_block"), []);
});

test("get_items smelts what only a furnace makes: sand, logs and stone gathered, a furnace and fuel crafted, glass smelted, panes crafted", async () => {
  const runtime = smeltRuntime();
  const result = await runStep({ skill: "get_items", items: [{ item: "glass_pane", count: 3 }] }, contextFor(runtime));
  assert.equal(result.status, "done", result.status === "failed" ? result.detail : "");
  const calls = runtime.submitted.map((call) => call.tool === "smelt_item" ? `smelt ${String(call.input.item_name)}` : describeCall(call));
  assert.ok(calls.indexOf("collect sand") >= 0, calls.join(" | "));
  assert.ok(calls.indexOf("craft wooden_pickaxe at table") < calls.indexOf("collect stone"), calls.join(" | "));
  assert.ok(calls.findIndex((call) => call.startsWith("craft") && call.includes("furnace")) < calls.indexOf("smelt sand"), calls.join(" | "));
  assert.ok(calls.indexOf("smelt sand") < calls.findIndex((call) => call.includes("glass_pane")), calls.join(" | "));
  assert.deepEqual(smeltCalls(runtime), [{ item_name: "sand", count: 6, fuel_item_name: "oak_planks", temporary_workstation: true }]);
  assert.ok(runtime.snapshot.inventory.some((stack) => stack.name === "glass_pane" && stack.count >= 3));
});

test("carried coal burns before planks, and carried red sand is smelted before any sand is dug", async () => {
  const runtime = smeltRuntime([{ name: "red_sand", count: 8 }, { name: "coal", count: 2 }, { name: "oak_planks", count: 20 }, { name: "furnace", count: 1 }]);
  const result = await runStep({ skill: "get_items", items: [{ item: "glass", count: 8 }] }, contextFor(runtime));
  assert.equal(result.status, "done");
  assert.deepEqual(runtime.submitted.map((call) => call.tool), ["smelt_item"]);
  assert.deepEqual(smeltCalls(runtime), [{ item_name: "red_sand", count: 8, fuel_item_name: "coal", temporary_workstation: true }]);
});

test("a carried lava bucket is kept and coal burns, from the runtime's real fuel list", async () => {
  const runtime = smeltRuntime([{ name: "sand", count: 8 }, { name: "lava_bucket", count: 1 }, { name: "coal", count: 1 }, { name: "furnace", count: 1 }]);
  runtime.fuels = RUNTIME_FUELS_1_21_4;
  const result = await runStep({ skill: "get_items", items: [{ item: "glass", count: 8 }] }, contextFor(runtime));
  assert.equal(result.status, "done", result.status === "failed" ? result.detail : "");
  assert.deepEqual(smeltCalls(runtime), [{ item_name: "sand", count: 8, fuel_item_name: "coal", temporary_workstation: true }]);
  assert.equal(runtime.snapshot.inventory.find((stack) => stack.name === "lava_bucket")?.count ?? 0, 1);
});

test("with only a lava bucket to burn, planks are made from the carried log", async () => {
  const runtime = smeltRuntime([{ name: "sand", count: 3 }, { name: "lava_bucket", count: 1 }, { name: "oak_log", count: 1 }, { name: "crafting_table", count: 1 }, { name: "furnace", count: 1 }]);
  runtime.fuels = RUNTIME_FUELS_1_21_4;
  const result = await runStep({ skill: "get_items", items: [{ item: "glass", count: 3 }] }, contextFor(runtime));
  assert.equal(result.status, "done", result.status === "failed" ? result.detail : "");
  assert.deepEqual(smeltCalls(runtime), [{ item_name: "sand", count: 3, fuel_item_name: "oak_planks", temporary_workstation: true }]);
  const carried = (item: string) => runtime.snapshot.inventory.find((stack) => stack.name === item)?.count ?? 0;
  assert.equal(carried("lava_bucket"), 1);
  assert.equal(carried("glass"), 3);
});

test("a carried boat is kept and planks burn, though the runtime lists boats as fuel", async () => {
  const runtime = smeltRuntime([{ name: "sand", count: 3 }, { name: "oak_boat", count: 2 }, { name: "oak_planks", count: 2 }, { name: "furnace", count: 1 }]);
  runtime.fuels = RUNTIME_FUELS_1_21_4;
  const result = await runStep({ skill: "get_items", items: [{ item: "glass", count: 3 }] }, contextFor(runtime));
  assert.equal(result.status, "done", result.status === "failed" ? result.detail : "");
  assert.deepEqual(smeltCalls(runtime), [{ item_name: "sand", count: 3, fuel_item_name: "oak_planks", temporary_workstation: true }]);
  assert.equal(runtime.snapshot.inventory.find((stack) => stack.name === "oak_boat")?.count ?? 0, 2);
});

test("planks asked for and burnt as fuel are made again", async () => {
  const runtime = smeltRuntime([{ name: "sand", count: 3 }, { name: "oak_planks", count: 2 }, { name: "furnace", count: 1 }, { name: "crafting_table", count: 1 }]);
  const result = await runStep({ skill: "get_items", items: [{ item: "glass", count: 3 }, { item: "oak_planks", count: 2 }] }, contextFor(runtime));
  assert.equal(result.status, "done");
  const carried = (item: string) => runtime.snapshot.inventory.find((stack) => stack.name === item)?.count ?? 0;
  assert.equal(carried("glass"), 3);
  assert.ok(carried("oak_planks") >= 4, `planks: ${carried("oak_planks")}`);
});

test("iron ingots come from the carried raw iron; coal is mined, never smelted from its ore", async () => {
  const runtime = smeltRuntime([{ name: "raw_iron", count: 3 }, { name: "coal", count: 1 }, { name: "furnace", count: 1 }]);
  assert.equal((await runStep({ skill: "get_items", items: [{ item: "iron_ingot", count: 3 }] }, contextFor(runtime))).status, "done");
  assert.deepEqual(smeltCalls(runtime), [{ item_name: "raw_iron", count: 3, fuel_item_name: "coal", temporary_workstation: true }]);

  const miner = smeltRuntime([{ name: "wooden_pickaxe", count: 1 }]);
  assert.equal((await runStep({ skill: "get_items", items: [{ item: "coal", count: 2 }] }, contextFor(miner))).status, "done");
  assert.deepEqual(miner.submitted.map(describeCall), ["collect coal"]);
});

test("an item whose only recipe cannot be planned (coal from a coal block) is mined or smelted instead", async () => {
  const miner = smeltRuntime([{ name: "wooden_pickaxe", count: 1 }, { name: "raw_iron", count: 2 }, { name: "furnace", count: 1 }]);
  miner.unplannable = ["coal", "iron_ingot"];
  const result = await runStep({ skill: "get_items", items: [{ item: "coal", count: 1 }, { item: "iron_ingot", count: 2 }] }, contextFor(miner));
  assert.equal(result.status, "done", result.status === "failed" ? result.detail : "");
  assert.deepEqual(miner.submitted.map((call) => call.tool === "smelt_item" ? `smelt ${String(call.input.item_name)} with ${String(call.input.fuel_item_name)}` : describeCall(call)), ["collect coal", "smelt raw_iron with coal"]);
});

test("a furnace item whose input cannot be gathered ends get_items with the runtime's reason", async () => {
  const runtime = smeltRuntime([{ name: "coal", count: 1 }, { name: "furnace", count: 1 }]);
  runtime.failures.collect_block = "[UNKNOWN_BLOCK] Minecraft has no block named beef.";
  const result = await runStep({ skill: "get_items", items: [{ item: "cooked_beef", count: 1 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /beef/u);
  assert.deepEqual(runtime.submitted.map(describeCall), ["collect beef"]);
});

test("a fetch that got its items is done when only the walk back failed (live 2026-10-10 run 10: counted as failed, the explore loop followed)", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 } };
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    const settled = await submit(tool, input, ...rest);
    if (tool === "collect_block") runtime.snapshot = { ...runtime.snapshot, position: { x: 40.5, y: 64, z: 0.5 } };
    return settled;
  };
  runtime.failures.navigate = "[NAVIGATION_DEEP_WATER] Deep open water ahead";
  const result = await runStep({ skill: "get_items", items: [{ item: "oak_log", count: 3 }] }, contextFor(runtime));
  assert.equal(result.status, "done");
  assert.match(result.status === "done" ? result.detail : "", /^got 3 oak_log; could not walk back: \[NAVIGATION_DEEP_WATER\]/u);
});

test("get_items fetches that many more of each item", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_log", count: 5 }] };
  const result = await runStep({ skill: "get_items", items: [{ item: "oak_log", count: 3 }] }, contextFor(runtime));
  assert.match(result.status === "done" ? result.detail : "", /^got 3 oak_log, now carrying 8 oak_log/u);
  assert.deepEqual(runtime.submitted.map((call) => [call.tool, call.input.count]), [["collect_block", 3]]);
});

test("get_items keeps what it carried: planks that crafting the new items used up are made again", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 20 }] };
  const result = await runStep({ skill: "get_items", items: [{ item: "oak_fence", count: 3 }] }, contextFor(runtime));
  assert.equal(result.status, "done");
  const count = (item: string) => runtime.snapshot.inventory.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);
  assert.ok(count("oak_fence") >= 3);
  assert.ok(count("oak_planks") >= 20, `still carries the 20 planks (${count("oak_planks")})`);
  assert.ok(runtime.submitted.some((call) => call.tool === "collect_block" && call.input.block_name === "oak_log"), "chopped logs to make the planks again");
});

test("get_items that used her own carried planks for a craft, with no logs near to replace them, says what it used", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 20 }, { name: "oak_log", count: 2 }, { name: "crafting_table", count: 1 }] };
  // The fake planner counts only raw leaves, so the craft itself takes her planks the way the game's does (6 of the 20).
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    if (tool === "craft_item") runtime.addItem("oak_planks", -6);
    return submit(tool, input, ...rest);
  };
  // The logs that would make them again are out of range.
  runtime.failures.collect_block = "[NO_TARGET_IN_RANGE] No oak_log block left within 64 blocks of where the run started; none is loaded farther either.";
  const result = await runStep({ skill: "get_items", items: [{ item: "oak_fence", count: 3 }] }, contextFor(runtime));
  assert.deepEqual(runtime.submitted.map(describeCall), ["craft oak_fence at table", "collect oak_log"]);
  assert.deepEqual(result, { status: "done", detail: "got 3 oak_fence, now carrying 3 oak_fence (crafted 3 oak_fence; used 6 oak_planks of what you carried (none near to replace it))" });
});

test("get_items does not fetch back the scaffold blocks spent walking home to craft", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "dirt", count: 10 }, { name: "crafting_table", count: 1 }] };
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    // The logs are far away; the way back home pillars and bridges with carried dirt.
    if (tool === "collect_block") runtime.snapshot = { ...runtime.snapshot, position: { x: 30, y: 64, z: 0 } };
    if (tool === "navigate") {
      runtime.addItem("dirt", -3);
      runtime.snapshot = { ...runtime.snapshot, position: { x: 0, y: 64, z: 0 } };
    }
    return submit(tool, input, ...rest);
  };
  const result = await runStep({ skill: "get_items", items: [{ item: "oak_planks", count: 8 }] }, contextFor(runtime));
  assert.equal(result.status, "done");
  assert.deepEqual(runtime.submitted.map(describeCall), ["collect oak_log", "navigate", "craft oak_planks at table"]);
});

test("a crafting table close by is walked to and used; a far one is not, her own is set down instead", async () => {
  const near = new FakeRuntime();
  near.recipes = HOUSE_RECIPES;
  near.simulateInventory = true;
  near.snapshot = { ...near.snapshot, inventory: [{ name: "oak_log", count: 4 }, { name: "crafting_table", count: 1 }] };
  near.world.set("6,64,3", "crafting_table");
  assert.equal((await runStep({ skill: "get_items", items: [{ item: "wooden_pickaxe", count: 1 }] }, contextFor(near))).status, "done");
  const nearCalls = near.submitted.filter((call) => call.tool === "navigate" || call.tool === "craft_item");
  assert.deepEqual(nearCalls.map((call) => call.tool === "navigate" ? `walk to ${call.input.x} ${call.input.z}` : describeCall(call)), ["walk to 6 3", "craft wooden_pickaxe"]);

  const far = new FakeRuntime();
  far.recipes = HOUSE_RECIPES;
  far.simulateInventory = true;
  far.snapshot = { ...far.snapshot, inventory: [{ name: "oak_log", count: 4 }, { name: "crafting_table", count: 1 }] };
  far.world.set("40,64,3", "crafting_table");
  assert.equal((await runStep({ skill: "get_items", items: [{ item: "wooden_pickaxe", count: 1 }] }, contextFor(far))).status, "done");
  assert.deepEqual(far.submitted.filter((call) => call.tool === "craft_item").map(describeCall), ["craft wooden_pickaxe at table"]);

  // Without a table of her own, that one 40 blocks off is worth the walk (owner, 2026-10-07: 48 blocks).
  const none = new FakeRuntime();
  none.recipes = HOUSE_RECIPES;
  none.simulateInventory = true;
  none.snapshot = { ...none.snapshot, inventory: [{ name: "oak_log", count: 4 }] };
  none.world.set("40,64,3", "crafting_table");
  assert.equal((await runStep({ skill: "get_items", items: [{ item: "wooden_pickaxe", count: 1 }] }, contextFor(none))).status, "done");
  assert.deepEqual(none.submitted.filter((call) => call.tool === "navigate" || call.tool === "craft_item").map((call) => call.tool === "navigate" ? `walk to ${call.input.x} ${call.input.z}` : describeCall(call)), ["walk to 40 3", "craft wooden_pickaxe"]);
});

test("get_items plans recipes that take any wood with the woods growing nearby, nearest first", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.world.set("3,64,0", "birch_log");
  runtime.world.set("9,64,0", "oak_log");
  runtime.world.set("5,64,0", "birch_log");
  await runStep({ skill: "get_items", items: [{ item: "stick", count: 4 }] }, contextFor(runtime));
  assert.ok(runtime.preferences.some((prefer) => prefer.join(",") === "birch_log,oak_log"), JSON.stringify(runtime.preferences));
});

test("a far place whose walk failed is not walked to again by the next round, and one across the sea without a boat is not walked to", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.failures.collect_block = "[NO_TARGET_IN_RANGE] No oak_log block left within 64 blocks of where the run started; none is loaded farther either.";
  runtime.failures.navigate = "[NO_PATH] no route";
  runtime.seen = { oak_log: { dimension: "overworld", x: 300, z: 8 } };
  await runStep({ skill: "get_items", items: [{ item: "oak_log", count: 4 }] }, contextFor(runtime));
  await runStep({ skill: "get_items", items: [{ item: "oak_log", count: 4 }] }, contextFor(runtime));
  assert.equal(runtime.submitted.filter((call) => call.tool === "navigate").length, 1, "the second round does not offer the place again");

  const sea = new FakeRuntime();
  sea.failures.collect_block = "[NO_TARGET_IN_RANGE] No oak_log block left within 64 blocks of where the run started; none is loaded farther either.";
  sea.seen = { oak_log: { dimension: "overworld", x: 700, z: 8 } };
  sea.water = Object.fromEntries(Array.from({ length: 40 }, (_unused, index) => [`${index + 1},0`, 1]));
  const told = await runStep({ skill: "get_items", items: [{ item: "oak_log", count: 4 }] }, contextFor(sea));
  assert.deepEqual(sea.submitted.filter((call) => call.tool === "navigate"), []);
  assert.match(told.status === "failed" ? told.detail : "", /the oak_log you know of is across the water: take a boat/u);
});

test("a far walk that failed on deep water ends the fetch with the boat hint, no walk to the next far place across the same water", async () => {
  const runtime = new FakeRuntime();
  runtime.failures.collect_block = "[NO_TARGET_IN_RANGE] No oak_log block left within 64 blocks of where the run started; none is loaded farther either.";
  runtime.failures.navigate = "[NAVIGATION_DEEP_WATER] Deep open water ahead (40+ blocks) and no boat is carried.";
  runtime.seen = { oak_log: { dimension: "overworld", x: 300, z: 8 } };
  runtime.alsoSeen = { oak_log: [{ dimension: "overworld", x: 400, z: 8 }] };
  const told = await runStep({ skill: "get_items", items: [{ item: "oak_log", count: 4 }] }, contextFor(runtime));
  assert.equal(runtime.submitted.filter((call) => call.tool === "navigate").length, 1, "one walk only");
  assert.match(told.status === "failed" ? told.detail : "", /take a boat \(get_items oak_boat\)/u);
});

test("near trees none could be reached are not offered again, and a fetch failing after a partial gather says what it got", async () => {
  const runtime = new FakeRuntime();
  runtime.failures.collect_block = "[NO_REACHABLE_MATCHING_TARGETS] Every loaded oak_log block was found but none could be reached.";
  runtime.seen = { oak_log: { dimension: "overworld", x: 20, z: 8 } };
  await runStep({ skill: "get_items", items: [{ item: "oak_log", count: 4 }] }, contextFor(runtime));
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "navigate"), [], "the near place is marked, so no trip to it");

  const partial = new FakeRuntime();
  partial.recipes = HOUSE_RECIPES;
  partial.failures.collect_block = "[SOMETHING_ODD] the axe slipped";
  // The first collect fails but got 2 logs (a setback that gained); the next round fails with no gain at all.
  partial.failNext.collect_block = { error: "[SOMETHING_ODD] the axe slipped", effect: () => { partial.snapshot = { ...partial.snapshot, inventory: [{ name: "oak_log", count: 2 }] }; } };
  const result = await runStep({ skill: "get_items", items: [{ item: "oak_log", count: 4 }] }, contextFor(partial));
  assert.equal(result.status === "failed" ? result.detail : "", "got setback ([SOMETHING_ODD] the axe slipped) so far (carried now: 2 oak_log); still missing 2 oak_log: [SOMETHING_ODD] the axe slipped");
});

test("get_items stops after a bounded number of blocks broken for a rare drop that never came, and says so", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.dropSources = { ...runtime.dropSources, apple: [{ block: "oak_leaves", chance: 0.005, planted: false }] };
  const result = await runStep({ skill: "get_items", items: [{ item: "apple", count: 5 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  const detail = result.status === "failed" ? result.detail : "";
  assert.match(detail, new RegExp(`broke ${RARE_DROP_BREAKS} oak_leaves without gaining apple`, "u"));
  assert.match(detail, /rare \(0\.5% of breaks\)/u);
  const broken = runtime.submitted.filter((call) => call.tool === "collect_block").reduce((sum, call) => sum + Number(call.input.count), 0);
  assert.equal(broken, RARE_DROP_BREAKS);
});

test("a boat is looked up only for carried woods: iron_block costs no recipe lookup", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = { birch_boat: { makes: 1, needs: [{ item: "birch_planks", count: 5 }] }, oak_boat: { makes: 1, needs: [{ item: "oak_planks", count: 5 }] } };
  runtime.failures.collect_block = "[NO_TARGET_IN_RANGE] No oak_log block left within 64 blocks of where the run started; none is loaded farther either.";
  runtime.seen = { oak_log: { dimension: "overworld", x: 700, z: 8 } };
  runtime.water = Object.fromEntries(Array.from({ length: 40 }, (_unused, index) => [`${index + 1},0`, 1]));
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "iron_block", count: 4 }, { name: "hay_block", count: 2 }, { name: "birch_planks", count: 5 }] };
  const asked: string[] = [];
  const lookup = runtime.craftingNeeds.bind(runtime);
  runtime.craftingNeeds = async (items, prefer) => {
    asked.push(...items.map((entry) => entry.item));
    return lookup(items, prefer);
  };
  const result = await runStep({ skill: "collect_block", block: "oak_log", count: 3 }, contextFor(runtime));
  assert.match(result.status === "failed" ? result.detail : "", /get_items birch_boat\)/u);
  assert.deepEqual(asked.filter((item) => /^(iron|hay)_/u.test(item)), [], "no recipe was asked for a block that is no wood");
});

test("the rare-drop bound counts blocks the runtime reports broken, whatever drops came", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.dropSources = { ...runtime.dropSources, apple: [{ block: "oak_leaves", chance: 0.005, planted: false }] };
  // Each call breaks fewer blocks than asked: only the structured count may stop the fetch.
  runtime.collectBroken = () => 8;
  const result = await runStep({ skill: "get_items", items: [{ item: "apple", count: 5 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", new RegExp(`broke ${RARE_DROP_BREAKS} oak_leaves without gaining apple`, "u"));
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_block").length, RARE_DROP_BREAKS / 8);
});

test("a rare drop already carried when the fetch starts is not taken for a gain", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "apple", count: 2 }] };
  runtime.dropSources = { ...runtime.dropSources, apple: [{ block: "oak_leaves", chance: 0.005, planted: false }] };
  runtime.collectBroken = () => 16;
  const result = await runStep({ skill: "get_items", items: [{ item: "apple", count: 5 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", new RegExp(`broke ${RARE_DROP_BREAKS} oak_leaves without gaining apple`, "u"));
});

test("a fetch whose craft finds no room makes room and crafts again once", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 8 }, { name: "stick", count: 4 }, { name: "crafting_table", count: 1 }, { name: "dirt", count: 64 }] };
  runtime.failNext.craft_item = { error: "[WORKSTATION_NO_ROOM] crafting_table: no free inventory slot to pick it back up afterwards; make room first." };
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "dirt", dropped: 64 }] });
  const result = await runStep({ skill: "get_items", items: [{ item: "wooden_pickaxe", count: 1 }] }, { ...contextFor(runtime), needed: needsOnlyTools });
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.map((call) => call.tool).filter((tool) => tool === "craft_item" || tool === "drop_item"), ["craft_item", "drop_item", "craft_item"]);
});

test("a rare fetch tells the runtime how many blocks it may still break: max_breaks is what is left of the bound", async () => {
  // Run 14 review SF7: one `collect_block oak_leaves count 5` could break 204 leaves before the bound was looked at.
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.dropSources = { ...runtime.dropSources, apple: [{ block: "oak_leaves", chance: 0.005, planted: false }] };
  runtime.collectBroken = () => 8;
  await runStep({ skill: "get_items", items: [{ item: "apple", count: 5 }] }, contextFor(runtime));
  const caps = runtime.submitted.filter((call) => call.tool === "collect_block").map((call) => call.input.max_breaks);
  assert.deepEqual(caps, Array.from({ length: RARE_DROP_BREAKS / 8 }, (_unused, call) => RARE_DROP_BREAKS - call * 8));
});

test("a sure drop is given no break cap", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  await runStep({ skill: "get_items", items: [{ item: "oak_log", count: 3 }] }, contextFor(runtime));
  const calls = runtime.submitted.filter((call) => call.tool === "collect_block");
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => !("max_breaks" in call.input)));
});

test("a pickaxe that broke and cannot be made again ends a fetch of stone at once: stone needs it", async () => {
  // Run 14 review N9: "going on without it" also applied to a harvest-required tool, so one more round tried the same remake.
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_log", count: 10 }, { name: "crafting_table", count: 1 }, { name: "wooden_pickaxe", count: 1 }] };
  runtime.failNext.collect_block = {
    error: "[TOOL_TIER_LOST] wooden_pickaxe was lost; no pickaxe remains.",
    result: { collected: { requested: 16, gained: 15, gainedByItem: { cobblestone: 15 }, blocksBroken: 15, brokenAt: [], toolLost: { item: "wooden_pickaxe", class: "pickaxe" } } },
    effect: () => {
      runtime.addItem("cobblestone", 15);
      runtime.addItem("wooden_pickaxe", -1);
    },
  };
  runtime.failures.craft_item = "[CRAFT_FAILED] no recipe works here";
  const result = await runStep({ skill: "get_items", items: [{ item: "cobblestone", count: 16 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.equal(runtime.submitted.filter((call) => call.tool === "craft_item").length, 1, runtime.submitted.map(describeCall).join(" | "));
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_block").length, 1);
});

test("a stripped log makes its tree's boat with one planner call, none for another tree's boat", async () => {
  const { asked, detail } = await BOAT_ASKS("stripped_oak_log", { stripped_oak_log: ["logs", "oak_logs"] });
  assert.match(detail, /get_items oak_boat\)/u);
  assert.deepEqual(asked.filter((item) => /boat|raft/u.test(item)), ["oak_boat"]);
});

test("a stem of a tree with no boat recipe costs no planner call and names the default boat", async () => {
  const { asked, detail } = await BOAT_ASKS("crimson_stem", { crimson_stem: ["logs", "crimson_stems"] });
  assert.match(detail, /get_items oak_boat\)/u);
  assert.deepEqual(asked.filter((item) => /boat|raft/u.test(item)), []);
});

test("a crop that is its own seed: get_items names where a first one comes from, not 'farm it' (N1)", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.dropSources = { ...runtime.dropSources, carrot: [{ block: "carrots", chance: 1, planted: true, seed: "carrot" }] };
  runtime.mobDrops = { carrot: [{ mob: "zombie", chance: 0.025, hostile: true }] };
  const result = await runStep({ skill: "get_items", items: [{ item: "carrot", count: 16 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  const detail = result.status === "failed" ? result.detail : "";
  assert.match(detail, /carrot grows as a crop/u);
  assert.match(detail, /zombie/u);
  assert.doesNotMatch(detail, /farm it/u);
  assert.deepEqual(runtime.submitted, []);
});

test("get_items hunts the runtime's first non-hostile source: porkchop with a pig loaded hunts the pig, not the hoglin", async () => {
  // Run 15: the registry type put hoglin (hostile by the hunt's own category) before pig.
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.mobDrops = { porkchop: [
    { mob: "pig", chance: 1, hostile: false, spawnsInDimension: true, loaded: 1 },
    { mob: "hoglin", chance: 1, hostile: true, spawnsInDimension: false, loaded: 0 },
  ] };
  const result = await runStep({ skill: "get_items", items: [{ item: "porkchop", count: 2 }] }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.map((call) => call.input.mob_name), ["pig"]);
});

test("get_items tries the next mob source once after a hunt that finds none loaded, then names both", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.mobDrops = { leather: [
    { mob: "cow", chance: 1, hostile: false, spawnsInDimension: true, loaded: 0 },
    { mob: "horse", chance: 1, hostile: false, spawnsInDimension: true, loaded: 0 },
  ] };
  runtime.failNext.collect_mob_drop = { error: "[HUNT_TARGET_NOT_LOADED] no cow loaded" };
  const second = await runStep({ skill: "get_items", items: [{ item: "leather", count: 1 }] }, contextFor(runtime));
  assert.equal(second.status, "done", JSON.stringify(second));
  assert.deepEqual(runtime.submitted.map((call) => call.input.mob_name), ["cow", "horse"]);

  const again = new FakeRuntime();
  again.simulateInventory = true;
  again.mobDrops = runtime.mobDrops;
  again.failures.collect_mob_drop = "[HUNT_TARGET_NOT_LOADED] none loaded";
  const failed = await runStep({ skill: "get_items", items: [{ item: "leather", count: 1 }] }, contextFor(again));
  assert.equal(failed.status, "failed");
  assert.match(failed.status === "failed" ? failed.detail : "", /cow.*horse/su, "names both sources tried");
  assert.deepEqual(again.submitted.map((call) => call.input.mob_name), ["cow", "horse"], "each source once per step");
});

test("a pickaxe lost twice in one get_items is remade twice and the collect goes on; the third loss stops with the reason", async () => {
  const twice = new FakeRuntime();
  twice.recipes = HOUSE_RECIPES;
  twice.simulateInventory = true;
  twice.snapshot = { ...twice.snapshot, inventory: [{ name: "oak_log", count: 10 }, { name: "crafting_table", count: 1 }, { name: "wooden_pickaxe", count: 1 }] };
  twice.failNext.collect_block = pickaxeLost(twice, 5, () => { twice.failNext.collect_block = pickaxeLost(twice, 5); });
  const done = await runStep({ skill: "get_items", items: [{ item: "cobblestone", count: 16 }] }, contextFor(twice));
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.deepEqual(twice.submitted.map(describeCall), ["collect stone", "craft wooden_pickaxe at table", "collect stone", "craft wooden_pickaxe at table", "collect stone"]);

  const thrice = new FakeRuntime();
  thrice.recipes = HOUSE_RECIPES;
  thrice.simulateInventory = true;
  thrice.snapshot = { ...thrice.snapshot, inventory: [{ name: "oak_log", count: 20 }, { name: "crafting_table", count: 1 }, { name: "wooden_pickaxe", count: 1 }] };
  thrice.failNext.collect_block = pickaxeLost(thrice, 2, () => {
    thrice.failNext.collect_block = pickaxeLost(thrice, 2, () => { thrice.failNext.collect_block = pickaxeLost(thrice, 2); });
  });
  const stopped = await runStep({ skill: "get_items", items: [{ item: "cobblestone", count: 16 }] }, contextFor(thrice));
  assert.equal(stopped.status, "failed");
  assert.match(stopped.status === "failed" ? stopped.detail : "", /pickaxe was lost 3 times in this step \(remade 2 times\)/u);
  assert.equal(thrice.submitted.filter((call) => call.tool === "craft_item").length, 2, "remade twice, not after the third loss");
});

test("a tool that broke in one fetch is remembered by the next fetch of the same objective", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = SHOVEL_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_shovel", count: 1 }, { name: "oak_log", count: 10 }, { name: "crafting_table", count: 1 }] };
  const toolsLost = new Set<string>();
  // It broke on the last dirt (nothing left to dig, so not remade in that call)...
  runtime.failNext.collect_block = shovelLost(runtime, 16);
  const first = await runStep({ skill: "get_items", items: [{ item: "dirt", count: 16 }] }, contextFor(runtime, { toolsLost }));
  assert.equal(first.status, "done", JSON.stringify(first));
  runtime.submitted.length = 0;
  // ...and the next call of the objective makes it before it digs again.
  const second = await runStep({ skill: "get_items", items: [{ item: "dirt", count: 32 }] }, contextFor(runtime, { toolsLost }));
  assert.equal(second.status, "done", JSON.stringify(second));
  assert.deepEqual(runtime.submitted.map(describeCall).slice(0, 2), ["craft wooden_shovel at table", "collect dirt"]);
});

test("in the Nether, logs seen in the overworld are named as the overworld's, not offered as a walk; Nether places are walked to", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, dimension: "the_nether" };
  runtime.recipes = HOUSE_RECIPES;
  runtime.failures.collect_block = "[NO_TARGET_IN_RANGE] No dark_oak_log block left within 64 blocks of where the run started; none is loaded farther either.";
  runtime.seen = { dark_oak_log: { dimension: "overworld", x: 700, z: 8 } };
  const elsewhere = await runStep({ skill: "collect_block", block: "dark_oak_log", count: 3 }, contextFor(runtime));
  assert.match(elsewhere.status === "failed" ? elsewhere.detail : "", /you saw some in overworld around 700 8/u);
  runtime.seen = { dark_oak_log: { dimension: "the_nether", x: 700, z: 8 } };
  const here = await runStep({ skill: "collect_block", block: "dark_oak_log", count: 3 }, contextFor(runtime));
  assert.match(here.status === "failed" ? here.detail : "", /you saw some 700 blocks east, around 700 64 8: go_to there yourself/u);
});

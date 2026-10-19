import assert from "node:assert/strict";
import test from "node:test";
import { describeStep, skillUsage, stepSchema } from "./actions.ts";
import { Body } from "./body.ts";
import { houseBox, runStep, type SkillContext, type UnfinishedHouse } from "./skills.ts";
import { RARE_DROP_BREAKS } from "./gathering.ts";
import { DEFAULT_STYLE, STYLES } from "./building/styles.ts";
import { neededItems } from "./inventory-room.ts";
import type { BotSnapshot, ProtectedArea } from "./runtime-client.ts";
import type { KnownPlace } from "./mind.ts";
import { FakeRuntime, SMALL_MEDIEVAL_HOUSE as SMALL_MEDIEVAL } from "./testing.ts";

function contextFor(runtime: FakeRuntime, extra: Partial<SkillContext> = {}): SkillContext {
  return { runtime, body: new Body(runtime, () => undefined), signal: new AbortController().signal, ...extra };
}

function builds(runtime: FakeRuntime) {
  return runtime.submitted.filter((call) => call.tool === "build_structure").map((call) => call.input as { blocks: { x: number; y: number; z: number; block_name: string; facing?: string }[]; remove_wrong_blocks: boolean });
}

test("a build step defaults to a small house; the style is always the persona's, never the model's", () => {
  assert.deepEqual(stepSchema.parse({ skill: "build" }), { skill: "build", structure: "house", size: "small" });
  assert.equal(stepSchema.safeParse({ skill: "build", style: "japanese" }).success, false);
  assert.equal(stepSchema.safeParse({ skill: "build", structure: "castle" }).success, false);
});

/** Enough of Minecraft's recipes for a small medieval house. */
const HOUSE_RECIPES = {
  oak_planks: { makes: 4, needs: [{ item: "oak_log", count: 1 }] },
  spruce_planks: { makes: 4, needs: [{ item: "spruce_log", count: 1 }] },
  spruce_stairs: { makes: 4, needs: [{ item: "spruce_planks", count: 6 }] },
  spruce_slab: { makes: 6, needs: [{ item: "spruce_planks", count: 3 }] },
  stick: { makes: 4, needs: [{ item: "oak_planks", count: 2 }] },
  crafting_table: { makes: 1, needs: [{ item: "oak_planks", count: 4 }] },
  wooden_pickaxe: { makes: 1, needs: [{ item: "oak_planks", count: 3 }, { item: "stick", count: 2 }] },
  oak_fence: { makes: 3, needs: [{ item: "oak_planks", count: 4 }, { item: "stick", count: 2 }] },
  oak_door: { makes: 3, needs: [{ item: "oak_planks", count: 6 }] },
};

function describeCall(call: { readonly tool: string; readonly input: Readonly<Record<string, unknown>> }): string {
  if (call.tool === "collect_block") return `collect ${String(call.input.block_name)}`;
  if (call.tool === "craft_item") {
    const items = (call.input.items as { item_name: string }[]).map((item) => item.item_name).join("+");
    return `craft ${items}${call.input.temporary_workstation === true ? " at table" : ""}`;
  }
  return call.tool;
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

test("drop_item drops several items in one step, and the single-item form still reads", async () => {
  // Live 2026-10-04: a full inventory took Tom 20 steps of dropping one item each.
  const runtime = new FakeRuntime();
  const step = stepSchema.parse({ skill: "drop_item", items: [{ item: "snowball" }, { item: "granite", count: 10 }] });
  const result = await runStep(step, contextFor(runtime));
  assert.equal(result.status, "done");
  assert.deepEqual(runtime.submitted.map((call) => [call.input.items, call.input.in_a_hole]), [[[{ item_name: "snowball" }, { item_name: "granite", count: 10 }], true]]);
  assert.equal(stepSchema.safeParse({ skill: "drop_item", item: "dirt" }).success, true);
  assert.equal(stepSchema.safeParse({ skill: "drop_item" }).success, false);
});

test("drop_item names what was really dropped, and says the inventory has room again", async () => {
  // Live 2026-10-10 run 7: every drop was reported "dropped 16 coal, 32 cobblestone" while the action had dropped 0.
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "dirt", count: 5 }] };
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "cobblestone", dropped: 32 }] });
  const result = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "cobblestone", count: 32 }] }), contextFor(runtime));
  assert.equal(result.status, "done");
  assert.match(result.status === "done" ? result.detail : "", /32 cobblestone.*the inventory has room again: 35 of 36 slots free/u);
});

test("a drop that dropped nothing fails with the action's reason, and a water-locked pit falls back to the ground", async () => {
  const runtime = new FakeRuntime();
  runtime.dropOutcomes.push({ status: "failed", error: "[DROP_PICKED_UP] coal came back into the inventory after the toss", dropped: [{ item: "coal", dropped: 0 }] });
  const failed = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "coal" }] }), contextFor(runtime));
  assert.equal(failed.status, "failed");
  assert.match(failed.status === "failed" ? failed.detail : "", /DROP_PICKED_UP/u);
  assert.deepEqual(runtime.submitted.map((call) => call.tool), ["drop_item"], "no ground toss after a pit that failed otherwise");

  const water = new FakeRuntime();
  water.walkOnNavigate = true;
  water.dropOutcomes.push(
    { status: "failed", error: "[DROP_HOLE_UNAVAILABLE] No place within 8 blocks", dropped: [] },
    { status: "succeeded", error: null, dropped: [{ item: "coal", dropped: 4 }] },
  );
  const ground = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "coal" }] }), contextFor(water));
  assert.equal(ground.status, "done");
  assert.deepEqual(water.submitted.map((call) => [call.tool, call.input.in_a_hole]), [["drop_item", true], ["drop_item", undefined]], "the action walks off itself, the step does not");
  assert.match(ground.status === "done" ? ground.detail : "", /4 coal/u);
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

/** House recipes plus what glass windows take: a furnace, and panes from glass. */
const GLASS_RECIPES = {
  ...HOUSE_RECIPES,
  furnace: { makes: 1, needs: [{ item: "cobblestone", count: 8 }] },
  glass_pane: { makes: 16, needs: [{ item: "glass", count: 6 }] },
};

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

test("a house without its blocks is refused with the exact shortfall, before any block is touched", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 30 }, { name: "cobblestone", count: 64 }] };
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval" }));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /^missing 42 spruce_stairs, 6 oak_planks, 24 oak_log, 7 spruce_slab, 3 glass_pane, 1 oak_door for a small medieval house/u);
  assert.equal(runtime.submitted.length, 0);
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
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { requester: "steve", style: "unknown-style", remember: (place) => places.push(place) }));
  assert.deepEqual(result, { status: "done", detail: "built a small medieval house, door at -2 64 0 facing east" });
  // The gable ridge runs across the door's axis, two blocks behind it; its centre is straight behind the door.
  assert.deepEqual(places, [{ name: "the small medieval house you built for steve", detail: "door -2 64 0 facing east; stand on its roof at -4 70 0", house: { size: "small", style: "medieval", door: { x: -2, y: 64, z: 0 }, facing: "east", materials: {} } }]);
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
  assert.match(first.status === "failed" ? first.detail : "", /stopped at part 1\/\d+: .*; building it again resumes it there$/u);
  // Back near the site (get_items walks back to where it started), it resumes there.
  runtime.snapshot = { ...runtime.snapshot, position: { x: 3.5, y: 64, z: 0.5 }, inventory: [{ name: "oak_door", count: 1 }] };
  const second = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.equal(second.status, "done");
  const calls = builds(runtime);
  assert.deepEqual(calls[1]!.blocks, calls[0]!.blocks, "the refused part is built again where it was");
  assert.equal(building.unfinished, null);
});

/** A failed `build_structure` whose audit names these cells as refused (the runtime's structured `left` groups). */
function refusedBuild(cells: readonly { x: number; y: number; z: number; detail: string; cause?: string }[]): { readonly error: string; readonly result: Record<string, unknown> } {
  return {
    error: `[BUILD_INCOMPLETE] ${cells.length} cell still wrong: ${cells.length} were refused.`,
    result: {
      status: "failed",
      error: "refused",
      structure: { placed: 0, dug: 0, wrong: cells.length, left: [{ reason: "refused", count: cells.length, named: cells.map((cell) => ({ cause: "policy", ...cell })) }], missing: [] },
    },
  };
}

test("one refused cell keeps the unfinished house and records the cell (run 13 review R1: a transient refusal forgot the house)", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  const building = { unfinished: null as UnfinishedHouse | null };
  runtime.failNext.build_structure = refusedBuild([{ x: 1, y: 64, z: 1, detail: "route timed out" }]);
  const first = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval", building }));
  const detail = first.status === "failed" ? first.detail : "";
  assert.match(detail, /resumes it there$/u);
  assert.doesNotMatch(detail, /build somewhere else/u);
  assert.ok(building.unfinished !== null, "the house is kept");
  assert.deepEqual(building.unfinished.refused, [{ x: 1, y: 64, z: 1 }], "with the cell that was refused");
  // Resumed, the cell is built this time: the house is done.
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_door", count: 1 }] };
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
  assert.doesNotMatch(detail, /resumes it there/u);
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
  assert.match(first.status === "failed" ? first.detail : "", /resumes it there$/u);
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
    assert.match(detail, /resumes it there$/u);
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

test("an unfinished house is checked again from its first part, so what was dug out since is put back", async () => {
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
  assert.deepEqual(calls[3]!.blocks, calls[0]!.blocks, "the second build starts again at part 1");
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
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { requester: "steve", style: "medieval", progress: (fact) => facts.push(fact) }));
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
  assert.equal(house[0]!.keep, undefined, "the first part has nothing before it to keep");
  const firstPart = house[0]!.blocks.filter((cell) => cell.block_name !== "air").map(({ x, y, z }) => ({ x, y, z }));
  assert.deepEqual(house[1]!.keep, firstPart, "the second part keeps the first");
  assert.ok(house.slice(half).every((call) => call.keep === undefined), "the final check may put anything back");
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
  assert.deepEqual(building.unfinished, { kind: "small medieval house", site: { door: { x: -2, y: 64, z: 0 }, facing: "east" }, part: 0, prepared: false, materials: {} });
  const second = await runStep({ skill: "build", structure: "house", size: "small" }, context);
  assert.equal(second.status, "done");
  assert.deepEqual(builds(runtime)[1]!.blocks, [{ x: -4, y: 64, z: 0, block_name: "air" }], "the site is leveled again first");
});

test("a house at given coordinates has its door there and is built from in front of it, wherever she stood", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 30.5, y: 64, z: 30.5 }, inventory: SMALL_MEDIEVAL, players: [{ username: "Steve", position: { x: 20, y: 64, z: 10 } }] };
  const building = { unfinished: null };
  const result = await runStep(stepSchema.parse({ skill: "build", x: 20, y: 64, z: 4 }), contextFor(runtime, { requester: "steve", style: "medieval", building }));
  assert.deepEqual(result, { status: "done", detail: "built a small medieval house, door at 20 64 4 facing south" });
  // In front of the door (south of it, toward Steve), clear of the house.
  assert.deepEqual(runtime.submitted.find((call) => call.tool === "navigate")?.input, { x: 20, y: 64, z: 6, range: 1 });
});

test("a missing material names only what is missing, as the get_items step to take", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: SMALL_MEDIEVAL.filter((stack) => stack.name !== "spruce_slab") };
  const result = await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval" }));
  assert.deepEqual(result, { status: "failed", detail: "missing 7 spruce_slab for a small medieval house (the rest is carried): fetch exactly the missing items with get_items, then build again" });
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

/** An explore result without its closing list of how far unseen land is each way. */
const withoutWays = (detail: string) => detail.split("; unseen land from here: ")[0]!;

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

/** A fake whose snapshot lists these mobs once the bot stands at or past `fromX` (what loads as she walks on). */
class MobsLoadAt extends FakeRuntime {
  constructor(private readonly fromX: number, private readonly mobs: BotSnapshot["mobs"]) { super(); }

  override async status(): Promise<BotSnapshot> {
    return { ...this.snapshot, mobs: this.snapshot.position.x >= this.fromX ? this.mobs : [] };
  }
}

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

test("out on the water, explore names the nearest land instead of another way", async () => {
  // Live 2026-10-04: Vex, 104 blocks out over water, was refused all eight ways, fifteen steps in a row.
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 8, y: 62, z: 8 } };
  runtime.water = { "0,0": 1, "-1,0": 1, "1,0": 1, "2,0": 1, "0,-1": 1, "0,-2": 1, "-3,0": 0.1 };
  runtime.world.set("8,61,8", "water");
  const result = await runStep(stepSchema.parse({ skill: "explore", toward: "east" }), contextFor(runtime));
  assert.deepEqual(result, { status: "failed", detail: "you are out on the water, and east is water as far as you have seen (100% of the next 2 chunks); the nearest land you have seen is 48 blocks west, around -40 62 8: go_to there first" });
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

test("get_items plans recipes that take any wood with the woods growing nearby, nearest first", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.world.set("3,64,0", "birch_log");
  runtime.world.set("9,64,0", "oak_log");
  runtime.world.set("5,64,0", "birch_log");
  await runStep({ skill: "get_items", items: [{ item: "stick", count: 4 }] }, contextFor(runtime));
  assert.ok(runtime.preferences.some((prefer) => prefer.join(",") === "birch_log,oak_log"), JSON.stringify(runtime.preferences));
});

test("walking to a crafting table close by sends navigate its coordinates only, never the block's name", async () => {
  const runtime = new FakeRuntime();
  runtime.world.set("3,64,0", "crafting_table");
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 4 }] };
  runtime.recipes = { stick: { makes: 4, needs: [{ item: "oak_planks", count: 2 }] } };
  await runStep({ skill: "craft_item", item: "stick", count: 4 }, contextFor(runtime));
  assert.deepEqual(runtime.submitted.find((call) => call.tool === "navigate")?.input, { x: 3, y: 64, z: 0, range: 2 });
});

test("a follow asked for by a player ends after ten minutes without a word from them", async () => {
  // Spec 2026-10-04-activity-time-travel-terraforming: following never ended by itself (live: Vex followed Tester until
  // an order came).
  const runtime = new FakeRuntime();
  const quiet = await runStep({ skill: "follow_player", player: "Tom", distance: 3 }, contextFor(runtime, { heardFrom: () => Date.now() - 11 * 60_000 }));
  assert.equal(quiet.status, "done");
  assert.match(quiet.status === "done" ? quiet.detail : "", /Tom; they said nothing for 10 minutes/u);
  assert.equal(stepSchema.safeParse({ skill: "follow_player", player: "Tom", minutes: 16 }).success, false);
  assert.deepEqual(stepSchema.parse({ skill: "follow_player", player: "Tom", minutes: 5 }), { skill: "follow_player", player: "Tom", distance: 3, minutes: 5 });
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
  assert.deepEqual(places[0]!.house, { size: "small", style: "medieval", door: { x: 0, y: 64, z: 2 }, facing: "north", materials });
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

test("a house built for a requester without own stays theirs", async () => {
  const places: KnownPlace[] = [];
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL, players: [{ username: "Steve", position: { x: 8, y: 64, z: 1 } }] };
  await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { requester: "steve", style: "medieval", remember: (place) => places.push(place) }));
  assert.equal(places[0]!.name, "the small medieval house you built for steve");
  assert.equal("own" in places[0]!, false);
});

test('{"skill":"build","own":true} parses and is described as for yourself', () => {
  const step = stepSchema.parse({ skill: "build", own: true });
  assert.deepEqual(step, { skill: "build", structure: "house", size: "small", own: true });
  assert.match(describeStep(step), /^build a small house for yourself$/u);
  assert.doesNotMatch(describeStep(stepSchema.parse({ skill: "build" })), /yourself/u);
});

test("a house built as the style remembers an empty materials list", async () => {
  const places: KnownPlace[] = [];
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL };
  await runStep({ skill: "build", structure: "house", size: "small" }, contextFor(runtime, { style: "medieval", remember: (place) => places.push(place) }));
  assert.deepEqual(places[0]!.house?.materials, {});
});

test("materials the game refuses are named before anything is protected or sent", async () => {
  const runtime = new FakeRuntime();
  runtime.notBlocks = new Set(["stone_blok"]);
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "dirt", count: 300 }] };
  const result = await runStep({ skill: "build", structure: "house", size: "small", materials: { wall: "stone_blok", roof: "oak_stairs", door: "dirt" } }, contextFor(runtime, { style: "medieval" }));
  assert.equal(result.status, "failed");
  const detail = result.status === "failed" ? result.detail : "";
  assert.match(detail, /wall: stone_blok is no block id \(your style uses oak_planks\)/u);
  assert.match(detail, /roof: oak_stairs is not a full block \(your style uses spruce_planks\)/u);
  assert.match(detail, /door: dirt is not a door \(your style uses oak_door\)/u);
  assert.equal(runtime.submitted.length, 0);
});

test("a resumed house is built with the materials it was started with, not the step's", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: [{ name: "dirt", count: 300 }, { name: "oak_door", count: 1 }, { name: "cobblestone", count: 20 }, { name: "oak_log", count: 30 }, { name: "oak_planks", count: 40 }, { name: "glass_pane", count: 3 }] };
  const building = { unfinished: null as UnfinishedHouse | null };
  runtime.failNext.build_structure = { error: "[BUILD_INCOMPLETE] 1 cell still wrong" };
  const context = contextFor(runtime, { style: "medieval", building });
  await runStep({ skill: "build", structure: "house", size: "small", materials: { roof: "dirt" } }, context);
  assert.deepEqual(building.unfinished?.materials, { roof: "dirt" });
  await runStep({ skill: "build", structure: "house", size: "small", materials: { roof: "cobblestone" } }, context);
  const blocks = builds(runtime).flatMap((call) => call.blocks.map((cell) => cell.block_name));
  assert.ok(blocks.includes("dirt") && !blocks.includes("spruce_stairs"));
});

/** A small medieval house at door 0 64 2 facing north, temporary in wall and roof, as `build` remembers it. */
const TEMPORARY_HOUSE: KnownPlace = {
  name: "the small medieval house you built",
  detail: "door 0 64 2 facing north; stand on its roof at 0 70 0",
  own: true,
  house: { size: "small", style: "medieval", door: { x: 0, y: 64, z: 2 }, facing: "north", materials: { wall: "dirt", roof: "dirt" } },
};

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

test("drop_item keeps the last tool of a class, the last bed and the last boat (live 2026-10-10 run 8: pickaxe, axe, shovel, boat and bed dropped)", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "stone_pickaxe", count: 1 }, { name: "dirt", count: 20 }, { name: "white_bed", count: 1 }, { name: "oak_boat", count: 1 }] };
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "dirt", dropped: 20 }] });
  const result = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "stone_pickaxe" }, { item: "dirt" }, { item: "white_bed" }, { item: "oak_boat" }] }), contextFor(runtime));
  assert.equal(result.status, "done");
  assert.deepEqual(runtime.submitted.map((call) => call.input.items), [[{ item_name: "dirt" }]], "only the dirt went to the action");
  const detail = result.status === "done" ? result.detail : "";
  assert.match(detail, /kept 1 stone_pickaxe: your only pickaxe/u);
  assert.match(detail, /kept 1 white_bed: your only bed/u);
  assert.match(detail, /kept 1 oak_boat: your only boat/u);

  const several = new FakeRuntime();
  several.snapshot = { ...several.snapshot, inventory: [{ name: "stone_pickaxe", count: 3 }, { name: "wooden_pickaxe", count: 1 }] };
  several.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "stone_pickaxe", dropped: 2 }] });
  await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "stone_pickaxe", count: 2 }] }), contextFor(several));
  assert.deepEqual(several.submitted.map((call) => call.input.items), [[{ item_name: "stone_pickaxe", count: 2 }]], "two of three is fine");

  // Dropping every pickaxe keeps the best one, not the one named first: the best is the one the runtime reports the larger durability maximum for.
  const tiers = new FakeRuntime();
  tiers.snapshot = { ...tiers.snapshot, inventory: [{ name: "wooden_pickaxe", count: 1, durability: { remaining: 59, maximum: 59 } }, { name: "iron_pickaxe", count: 1, durability: { remaining: 250, maximum: 250 } }] };
  tiers.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "wooden_pickaxe", dropped: 1 }] });
  await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "wooden_pickaxe" }, { item: "iron_pickaxe" }] }), contextFor(tiers));
  assert.deepEqual(tiers.submitted.map((call) => call.input.items), [[{ item_name: "wooden_pickaxe" }]]);

  // A golden pickaxe wears out sooner than a stone one: dropping both keeps the stone one (review 2026-10-18 #9).
  const golden = new FakeRuntime();
  golden.snapshot = { ...golden.snapshot, inventory: [{ name: "golden_pickaxe", count: 1, durability: { remaining: 32, maximum: 32 } }, { name: "stone_pickaxe", count: 1, durability: { remaining: 100, maximum: 131 } }] };
  golden.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "golden_pickaxe", dropped: 1 }] });
  await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "golden_pickaxe" }, { item: "stone_pickaxe" }] }), contextFor(golden));
  assert.deepEqual(golden.submitted.map((call) => call.input.items), [[{ item_name: "golden_pickaxe" }]]);

  const only = new FakeRuntime();
  only.snapshot = { ...only.snapshot, inventory: [{ name: "stone_axe", count: 1 }] };
  const refused = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "stone_axe" }] }), contextFor(only));
  assert.equal(refused.status, "failed");
  assert.match(refused.status === "failed" ? refused.detail : "", /kept 1 stone_axe: your only axe/u);
  assert.deepEqual(only.submitted, []);
});

test("a failed drop still says which tools it kept (live 2026-10-10 run 9: the kept hoe and pickaxe vanished from the failure text)", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_hoe", count: 1 }, { name: "wooden_pickaxe", count: 1 }, { name: "oak_log", count: 4 }] };
  runtime.dropOutcomes.push({ status: "failed", error: "[DROP_INCOMPLETE] 1 of 1 item could not be dropped: oak_log: [DROP_PICKED_UP] oak_log came back", dropped: [{ item: "oak_log", dropped: 0 }] });
  const result = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "oak_log" }, { item: "wooden_hoe" }, { item: "wooden_pickaxe" }] }), contextFor(runtime));
  assert.equal(result.status, "failed");
  const detail = result.status === "failed" ? result.detail : "";
  assert.match(detail, /DROP_PICKED_UP/u);
  assert.match(detail, /kept 1 wooden_pickaxe: your only pickaxe/u);
  assert.match(detail, /kept 1 wooden_hoe: your only hoe/u);
});

test("a drop of her own work keeps what the work needs (the best tool of each class, the house planks; a lesser axe is spare, run 15 N5); an order drops anything", async () => {
  const inventory = [{ name: "stone_pickaxe", count: 1 }, { name: "stone_axe", count: 1 }, { name: "wooden_axe", count: 1 }, { name: "oak_planks", count: 16 }, { name: "snowball", count: 40 }];
  const step = stepSchema.parse({ skill: "drop_item", items: [{ item: "stone_axe" }, { item: "wooden_axe" }, { item: "oak_planks" }, { item: "snowball" }] });
  const own = new FakeRuntime();
  own.snapshot = { ...own.snapshot, inventory };
  own.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "snowball", dropped: 40 }] });
  const result = await runStep(step, { ...contextFor(own), needed: (snapshot) => neededItems(snapshot, { houseBill: ["oak_planks"] }) });
  assert.deepEqual(own.submitted.map((call) => call.input.items), [[{ item_name: "wooden_axe" }, { item_name: "snowball" }]]);
  const detail = result.status === "done" ? result.detail : "";
  assert.match(detail, /kept all 16 oak_planks: your current work needs them/u);
  assert.match(detail, /kept 1 stone_axe: your only axe/u);

  const ordered = new FakeRuntime();
  ordered.snapshot = { ...ordered.snapshot, inventory };
  ordered.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "oak_planks", dropped: 16 }] });
  await runStep(step, contextFor(ordered));
  assert.deepEqual(ordered.submitted.map((call) => call.input.items), [[{ item_name: "wooden_axe" }, { item_name: "oak_planks" }, { item_name: "snowball" }]], "an order drops the planks and the spare axe (the best axe stays anyway)");
});

test("a drop that keeps everything names what may go; with only needed items carried, the needed ones go (run 11: Mira's dead end)", async () => {
  const needed = (snapshot: Parameters<typeof neededItems>[0]) => neededItems(snapshot, { houseBill: ["cobblestone"] });
  const kept = new FakeRuntime();
  kept.snapshot = { ...kept.snapshot, inventory: [{ name: "cobblestone", count: 64 }, { name: "granite", count: 20 }] };
  const refused = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "cobblestone" }] }), { ...contextFor(kept), needed });
  assert.equal(refused.status, "failed");
  assert.match(refused.status === "failed" ? refused.detail : "", /nothing dropped; kept all 64 cobblestone: your current work needs them; .*20 granite/u);
  assert.deepEqual(kept.submitted, []);

  const all = new FakeRuntime();
  all.snapshot = { ...all.snapshot, inventory: [{ name: "cobblestone", count: 64 }] };
  all.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "cobblestone", dropped: 64 }] });
  await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "cobblestone" }] }), { ...contextFor(all), needed });
  assert.deepEqual(all.submitted.map((call) => call.input.items), [[{ item_name: "cobblestone" }]]);
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

test("an eat step with the food bar full is tried and the game's answer is reported (golden apples are edible when full)", async () => {
  // Run 12: `[EAT_REJECTED] ... Food is full` for bread; golden_apple / chorus_fruit are accepted by the game when full.
  const rejected = new FakeRuntime();
  rejected.snapshot = { ...rejected.snapshot, food: 20, foods: [{ name: "bread", hunger: 5, count: 2 } as never] };
  rejected.failures.eat_food = "[EAT_REJECTED] Mineflayer could not consume the selected food: Food is full";
  const refused = await runStep({ skill: "eat", food: "bread" }, contextFor(rejected));
  assert.equal(refused.status, "failed");
  assert.match("detail" in refused ? refused.detail : "", /Food is full/u);
  assert.deepEqual(rejected.submitted.map((call) => call.tool), ["eat_food"]);

  const accepted = new FakeRuntime();
  accepted.snapshot = { ...accepted.snapshot, food: 20 };
  const ate = await runStep({ skill: "eat", food: "golden_apple" }, contextFor(accepted));
  assert.equal(ate.status, "done");
  assert.deepEqual(accepted.submitted.map((call) => call.tool), ["eat_food"]);
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

test("an eat step with the food bar not full still eats", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, food: 14 };
  const result = await runStep({ skill: "eat", food: "bread" }, contextFor(runtime));
  assert.equal(result.status, "done");
  assert.deepEqual(runtime.submitted.map((call) => call.tool), ["eat_food"]);
});

test("a craft step that lacks raw materials says get_items gathers and crafts them", async () => {
  // Run 12: 16 `[CRAFT_MATERIALS_MISSING] Missing leaf materials: birch_log x1 / iron_ingot x3`.
  const runtime = new FakeRuntime();
  runtime.failures.craft_item = "[CRAFT_MATERIALS_MISSING] Missing leaf materials: birch_log x1, oak_log x1.";
  const result = await runStep({ skill: "craft_item", item: "wooden_axe", count: 1 }, contextFor(runtime));
  assert.equal(result.status, "failed");
  const detail = "detail" in result ? result.detail : "";
  assert.match(detail, /CRAFT_MATERIALS_MISSING/u);
  assert.match(detail, /get_items wooden_axe 1/u);
});

test("a craft step failing for another reason gets no get_items hint", async () => {
  const runtime = new FakeRuntime();
  runtime.failures.craft_item = "[UNKNOWN_CRAFT_ITEMS] Minecraft has no registry items named: oak_wooden_axe.";
  const result = await runStep({ skill: "craft_item", item: "oak_wooden_axe", count: 1 }, contextFor(runtime));
  assert.doesNotMatch("detail" in result ? result.detail : "", /get_items/u);
});

const NO_ROOM_CRAFT = "[CRAFT_EXECUTION_FAILED] Mineflayer stopped while executing the selected recipe batch: This crafting execution needs inventory room to store 1 stone_shovel before the next recipe application.";
const needsOnlyTools = (snapshot: BotSnapshot) => neededItems(snapshot, {});

test("a craft step that finds no inventory room drops what the work does not need, then crafts again (run 12: bruno, oskar)", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_pickaxe", count: 1 }, { name: "oak_planks", count: 8 }, { name: "dirt", count: 64 }, { name: "gravel", count: 16 }] };
  runtime.failNext.craft_item = { error: NO_ROOM_CRAFT };
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "dirt", dropped: 64 }] });
  const result = await runStep({ skill: "craft_item", item: "stick", count: 4 }, { ...contextFor(runtime), needed: needsOnlyTools });
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.map((call) => call.tool).filter((tool) => tool === "craft_item" || tool === "drop_item"), ["craft_item", "drop_item", "craft_item"]);
  const dropped = runtime.submitted.find((call) => call.tool === "drop_item")!.input.items as { item_name: string }[];
  assert.deepEqual(dropped.map((entry) => entry.item_name).sort(), ["dirt"], "one stack, of the kind junkStacks lists first (equal stacks: the biggest count), only until a slot is free");
});

test("a craft of stone tools with a full inventory keeps its cobblestone and drops one stack of junk (run 13 review R8)", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = { ...HOUSE_RECIPES, stone_shovel: { makes: 1, needs: [{ item: "cobblestone", count: 1 }, { item: "stick", count: 2 }] } };
  const filler = Array.from({ length: 29 }, (_, index) => ({ name: `junk_${index}`, count: 50 }));
  const full = [{ name: "wooden_pickaxe", count: 1 }, { name: "cobblestone", count: 64 }, { name: "cobblestone", count: 64 }, { name: "stick", count: 8 }, { name: "dirt", count: 30 }, { name: "gravel", count: 40 }, { name: "dirt", count: 5 }, ...filler];
  assert.equal(full.length, 36);
  runtime.snapshot = { ...runtime.snapshot, inventory: full };
  runtime.failNext.craft_item = { error: NO_ROOM_CRAFT };
  // The drop frees the first stack of dirt.
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "dirt", dropped: 30 }], effect: () => { runtime.snapshot = { ...runtime.snapshot, inventory: runtime.snapshot.inventory.filter((stack) => !(stack.name === "dirt" && stack.count === 30)) }; } });
  const result = await runStep({ skill: "craft_item", item: "stone_shovel", count: 1 }, { ...contextFor(runtime), needed: needsOnlyTools });
  assert.equal(result.status, "done", JSON.stringify(result));
  const drops = runtime.submitted.filter((call) => call.tool === "drop_item");
  assert.equal(drops.length, 1, "one stack is enough for one free slot");
  assert.deepEqual(drops[0]!.input.items, [{ item_name: "dirt", count: 30 }], "the first dirt stack: the stack losing least, never the cobblestone or sticks the shovel takes");
});

test("a craft with a full inventory of one bucket and five dirt stacks drops a dirt stack, never the bucket (run 14 review SF3)", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = { ...HOUSE_RECIPES, stone_shovel: { makes: 1, needs: [{ item: "cobblestone", count: 1 }, { item: "stick", count: 2 }] } };
  const filler = Array.from({ length: 28 }, (_, index) => ({ name: `junk_${index}`, count: 50 }));
  const full = [{ name: "wooden_pickaxe", count: 1 }, { name: "bucket", count: 1 }, ...[30, 10, 20, 5, 40].map((count) => ({ name: "dirt", count })), ...filler, { name: "stick", count: 8 }];
  assert.equal(full.length, 36);
  runtime.snapshot = { ...runtime.snapshot, inventory: full };
  runtime.failNext.craft_item = { error: NO_ROOM_CRAFT };
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "dirt", dropped: 30 }], effect: () => { runtime.snapshot = { ...runtime.snapshot, inventory: runtime.snapshot.inventory.filter((stack) => !(stack.name === "dirt" && stack.count === 30)) }; } });
  const result = await runStep({ skill: "craft_item", item: "stone_shovel", count: 1 }, { ...contextFor(runtime), needed: needsOnlyTools });
  assert.equal(result.status, "done", JSON.stringify(result));
  const drops = runtime.submitted.filter((call) => call.tool === "drop_item");
  assert.equal(drops.length, 1);
  assert.deepEqual(drops[0]!.input.items, [{ item_name: "dirt", count: 30 }], "the kind with most stacks, its first stack (a count drops stacks in inventory order); the lone bucket stays");
});

test("a craft step with nothing to spare fails with the original reason (the agent names what to drop)", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_pickaxe", count: 1 }, { name: "oak_planks", count: 8 }] };
  runtime.failNext.craft_item = { error: NO_ROOM_CRAFT };
  const result = await runStep({ skill: "craft_item", item: "stick", count: 4 }, { ...contextFor(runtime), needed: (snapshot) => neededItems(snapshot, { wanted: new Set(["oak_planks"]) }) });
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /needs inventory room/u);
  assert.equal(runtime.submitted.some((call) => call.tool === "drop_item"), false);
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

test("a craft step with no crafting table carried makes one first, then crafts (run 12: bruno's bed, oskar)", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 8 }] };
  runtime.failNext.craft_item = { error: "[WORKSTATION_NOT_CARRIED] No crafting_table is carried for temporary use." };
  const result = await runStep({ skill: "craft_item", item: "oak_door", count: 3 }, contextFor(runtime));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "craft_item").map(describeCall), ["craft oak_door", "craft crafting_table", "craft oak_door"]);
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

test("the explore template marks for as optional, and the refusal of a word like none says to leave it out", async () => {
  // Run 15: 86 explore steps with "for": "none", 6 with "unknown".
  assert.match(skillUsage("explore", STYLES.get(DEFAULT_STYLE)!), /"for":"<block or creature id, optional: leave it out to just explore>"/u);
  const runtime = new FakeRuntime();
  runtime.notBlocks = new Set(["none"]);
  const refused = await runStep(stepSchema.parse({ skill: "explore", toward: "east", for: "none" }), contextFor(runtime));
  assert.equal(refused.status, "failed");
  assert.match("detail" in refused ? refused.detail : "", /leave "for" out to just explore/u);
});

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

test("a drop of 4 of 5 wooden swords drops 4 though the work needs a sword; the last one stays (run 15 N5)", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_sword", count: 5 }, { name: "dirt", count: 3 }] };
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "wooden_sword", dropped: 4 }] });
  const needed = (snapshot: Parameters<typeof neededItems>[0]) => neededItems(snapshot);
  const result = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "wooden_sword", count: 4 }] }), { ...contextFor(runtime), needed });
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.map((call) => call.input.items), [[{ item_name: "wooden_sword", count: 4 }]]);
});

/** A chest the runtime remembers as the bot's own (`observed_containers`), 6 blocks from the spawn point. */
const OWN_CHEST = { x: 6, y: 64, z: 0, blockName: "chest", slotCount: 27, usedSlots: 3 };

test("a drop with an own chest remembered within 32 blocks deposits there; with none (or a full one) it buries as before (run 15 N5)", async () => {
  const stocked = new FakeRuntime();
  stocked.snapshot = { ...stocked.snapshot, inventory: [{ name: "cobblestone", count: 64 }, { name: "dirt", count: 30 }] };
  stocked.containers = [OWN_CHEST];
  const stored = await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "cobblestone" }] }), { ...contextFor(stocked), self: "Ayla" });
  assert.equal(stored.status, "done", JSON.stringify(stored));
  assert.match(stored.status === "done" ? stored.detail : "", /stored 64 cobblestone in your chest at 6 64 0/u);
  assert.deepEqual(stocked.submitted.map((call) => [call.tool, call.input.operation, call.input.x, call.input.y, call.input.z, JSON.stringify(call.input.items)]), [["use_container", "deposit", 6, 64, 0, JSON.stringify([{ item_name: "cobblestone", count: 64 }])]]);

  const none = new FakeRuntime();
  none.snapshot = { ...none.snapshot, inventory: [{ name: "cobblestone", count: 64 }] };
  none.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "cobblestone", dropped: 64 }] });
  await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "cobblestone" }] }), { ...contextFor(none), self: "Ayla" });
  assert.deepEqual(none.submitted.map((call) => call.tool), ["drop_item"], "no chest known: buried");

  const full = new FakeRuntime();
  full.snapshot = { ...full.snapshot, inventory: [{ name: "cobblestone", count: 64 }] };
  full.containers = [{ ...OWN_CHEST, usedSlots: 27 }];
  full.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "cobblestone", dropped: 64 }] });
  await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "cobblestone" }] }), { ...contextFor(full), self: "Ayla" });
  assert.deepEqual(full.submitted.map((call) => call.tool), ["drop_item"], "a full chest is no room: buried");

  const failing = new FakeRuntime();
  failing.snapshot = { ...failing.snapshot, inventory: [{ name: "cobblestone", count: 64 }] };
  failing.containers = [OWN_CHEST];
  failing.failures.use_container = "[CONTAINER_UNREACHABLE] Pathfinder could not reach the container";
  failing.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "cobblestone", dropped: 64 }] });
  await runStep(stepSchema.parse({ skill: "drop_item", items: [{ item: "cobblestone" }] }), { ...contextFor(failing), self: "Ayla" });
  assert.deepEqual(failing.submitted.map((call) => call.tool), ["use_container", "drop_item"], "a chest that cannot be reached: buried after");
});

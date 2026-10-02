import assert from "node:assert/strict";
import test from "node:test";
import { stepSchema } from "./actions.ts";
import { Body } from "./body.ts";
import { houseBox, runStep, type SkillContext, type UnfinishedHouse } from "./skills.ts";
import type { ProtectedArea } from "./runtime-client.ts";
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
  // The logs the new pickaxe used up are chopped again: get_items keeps what it carried.
  assert.deepEqual(runtime.submitted.map(describeCall), ["collect stone", "craft wooden_pickaxe at table", "collect stone", "collect oak_log"]);
});

test("the harvest tool comes from game data and climbs the tiers: a wooden pickaxe for the stone of a stone one for iron ore", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = { ...HOUSE_RECIPES, stone_pickaxe: { makes: 1, needs: [{ item: "cobblestone", count: 3 }, { item: "stick", count: 2 }] } };
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_log", count: 10 }, { name: "crafting_table", count: 1 }] };
  const result = await runStep({ skill: "get_items", items: [{ item: "iron_ore", count: 2 }] }, contextFor(runtime));
  assert.equal(result.status, "done", result.status === "done" ? "" : JSON.stringify(result));
  const calls = runtime.submitted.map(describeCall);
  assert.deepEqual(calls.filter((call) => call.startsWith("craft")), ["craft wooden_pickaxe at table", "craft stone_pickaxe at table"]);
  assert.ok(calls.indexOf("collect stone") > calls.indexOf("craft wooden_pickaxe at table"), calls.join(" | "));
  assert.ok(calls.indexOf("collect iron_ore") > calls.indexOf("craft stone_pickaxe at table"), calls.join(" | "));
});

test("items that cannot be found end get_items, saying why", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_RECIPES;
  runtime.simulateInventory = true;
  runtime.failures.collect_block = "[NO_LOADED_MATCHING_TARGETS] Observed 0 loaded spruce_log blocks.";
  const result = await runStep({ skill: "get_items", items: [{ item: "spruce_planks", count: 8 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /^\[NO_LOADED_MATCHING_TARGETS\]/u);
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
  assert.deepEqual(places, [{ name: "the small medieval house you built for steve", detail: "door -2 64 0 facing east; stand on its roof at -4 70 0" }]);
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
  assert.deepEqual(await runStep(stepSchema.parse({ skill: "protect_area", label: "x" }), context), { status: "failed", detail: "protect_area needs a player or x, y and z" });
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
  assert.deepEqual(building.unfinished, { kind: "small medieval house", site: { door: { x: -2, y: 64, z: 0 }, facing: "east" }, part: 0, prepared: false });
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
  runtime.areas = [{ regionId: 4, label: "small medieval house", owner: "self", min: { x: 3, y: 60, z: 3 }, max: { x: 9, y: 72, z: 9 } }];
  runtime.world.set("1,64,1", "dirt");
  const result = await runStep(stepSchema.parse({ skill: "level_area", x1: 0, z1: 0, x2: 5, z2: 5, y: 64 }), contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /overlaps a protected area \(#4 'small medieval house'\)/u);
  assert.deepEqual(builds(runtime), []);
});

test("leveling goes on around a cell it may not dig, and says so", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "wooden_shovel", count: 1 }, { name: "wooden_axe", count: 1 }] };
  runtime.world.set("1,64,1", "crafting_table");
  runtime.world.set("2,64,1", "dirt");
  runtime.world.set("2,65,1", "dirt");
  runtime.failNext.build_structure = { error: "[BUILD_INCOMPLETE] 1 cell still wrong: 1 were refused (1,64,1: movement policy prohibits breaking this block)." };
  const result = await runStep(stepSchema.parse({ skill: "level_area", x1: 0, z1: 0, x2: 3, z2: 3, y: 64 }), contextFor(runtime));
  assert.deepEqual(result, { status: "done", detail: "leveled 4x4 at y 64: dug 2, filled 0 (left 1 cell it may not dig, leveled around)" });
  assert.equal(builds(runtime).length, 2, "the batch after the refused one still ran");
});

// get_items and the gathering never spend what an open trade owes: crafts, furnace fuel and input, scaffold list.
import assert from "node:assert/strict";
import test from "node:test";
import { runStep } from "../skills.ts";
import { FakeRuntime } from "../testing.ts";
import { GLASS_RECIPES, HOUSE_RECIPES, contextFor, count, describeCall, owing } from "./skill-fixtures.test.ts";

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

test("get_items never crafts away the raw logs a trade owes: the table is made and the logs fetched back to the owed count", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = { ...HOUSE_RECIPES, crafting_table: { makes: 1, needs: [{ item: "oak_log", count: 1 }] } };
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_log", count: 12 }] };
  const result = await runStep({ skill: "get_items", items: [{ item: "crafting_table", count: 1 }] }, contextFor(runtime, { owed: () => [owing("oak_log", 12)] }));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.equal(count(runtime, "crafting_table"), 1);
  assert.ok(count(runtime, "oak_log") >= 12, `logs: ${count(runtime, "oak_log")}`);
  assert.ok(runtime.submitted.some((call) => call.tool === "collect_block"), "the log the table used is fetched again");
});

test("get_items uses the logs beyond the owed count as before (owed 3 of 12: nothing is fetched)", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = { ...HOUSE_RECIPES, crafting_table: { makes: 1, needs: [{ item: "oak_log", count: 1 }] } };
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_log", count: 12 }] };
  runtime.failures.collect_block = "[NO_TARGET_IN_RANGE] No oak_log block left within 64 blocks of where the run started; none is loaded farther either.";
  const result = await runStep({ skill: "get_items", items: [{ item: "crafting_table", count: 1 }] }, contextFor(runtime, { owed: () => [owing("oak_log", 3)] }));
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "collect_block"), []);
});

test("owed planks are not the furnace's fuel: new planks are made first and the owed count is still carried after", async () => {
  const runtime = smeltRuntime([{ name: "red_sand", count: 8 }, { name: "oak_planks", count: 20 }, { name: "furnace", count: 1 }, { name: "crafting_table", count: 1 }]);
  const result = await runStep({ skill: "get_items", items: [{ item: "glass", count: 8 }] }, contextFor(runtime, { owed: () => [owing("oak_planks", 20)] }));
  assert.equal(result.status, "done", result.status === "failed" ? result.detail : "");
  assert.equal(smeltCalls(runtime).length, 1);
  assert.ok(runtime.submitted.some((call) => call.tool === "collect_block"), "logs are fetched for the fuel planks");
  assert.ok(count(runtime, "oak_planks") >= 20, `planks: ${count(runtime, "oak_planks")}`);
});

test("owed raw iron is not smelted: the iron is mined again and the owed count stays carried", async () => {
  const runtime = smeltRuntime([{ name: "raw_iron", count: 3 }, { name: "coal", count: 4 }, { name: "furnace", count: 1 }, { name: "stone_pickaxe", count: 1 }]);
  const result = await runStep({ skill: "get_items", items: [{ item: "iron_ingot", count: 3 }] }, contextFor(runtime, { owed: () => [owing("raw_iron", 3)] }));
  assert.equal(result.status, "done", result.status === "failed" ? result.detail : "");
  assert.ok(runtime.submitted.some((call) => call.tool === "collect_block" && call.input.block_name === "iron_ore"), runtime.submitted.map(describeCall).join(" | "));
  assert.ok(count(runtime, "raw_iron") >= 3, `raw iron: ${count(runtime, "raw_iron")}`);
});

test("a trade that ends during the gather frees its planks for the next round's fuel", async () => {
  const runtime = smeltRuntime([{ name: "red_sand", count: 8 }, { name: "oak_planks", count: 20 }, { name: "furnace", count: 1 }]);
  // Round 1 sees the trade (logs are fetched for new fuel planks); once a log is collected the trade is over.
  const owed = () => runtime.submitted.some((call) => call.tool === "collect_block") ? [] : [owing("oak_planks", 20)];
  const result = await runStep({ skill: "get_items", items: [{ item: "glass", count: 8 }] }, contextFor(runtime, { owed }));
  assert.equal(result.status, "done", result.status === "failed" ? result.detail : "");
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_block").length, 1, "one fetch in round 1, none after the trade ended");
  assert.equal(smeltCalls(runtime).length, 1);
});

test("the scaffold list loses a kind a trade owes all of during get_items, and keeps one with a spare", async () => {
  const run = async (inventory: { name: string; count: number }[], owed: readonly ReturnType<typeof owing>[]) => {
    const runtime = new FakeRuntime();
    runtime.simulateInventory = true;
    runtime.snapshot = { ...runtime.snapshot, inventory, policy: { revision: "r1", digStraightDown: false, scaffoldBlocks: ["dirt", "cobblestone"] } };
    const result = await runStep({ skill: "get_items", items: [{ item: "oak_planks", count: 4 }] }, contextFor(runtime, { owed: () => owed }));
    assert.equal(result.status, "done", JSON.stringify(result));
    return runtime.scaffoldSettings;
  };
  assert.deepEqual(await run([{ name: "cobblestone", count: 5 }], [owing("cobblestone", 5)]), [["dirt"], ["dirt", "cobblestone"]]);
  assert.deepEqual(await run([{ name: "cobblestone", count: 64 }], [owing("cobblestone", 2)]), [], "64 carried, 2 owed: still a scaffold block");
});

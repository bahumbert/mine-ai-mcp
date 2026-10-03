import assert from "node:assert/strict";
import test from "node:test";
import { zip } from "../test-support/zip.js";
import { extractSmeltingRecipes, readZipEntries } from "./smelting-extract.js";


test("zip entries are read whether stored or deflated", () => {
  const entries = readZipEntries(zip({ "a.json": "{\"a\":1}", "dir/b.json": "{\"b\":2}" }, ["dir/b.json"]));
  assert.deepEqual([...entries.keys()], ["a.json", "dir/b.json"]);
  assert.equal(entries.get("dir/b.json")!(), "{\"b\":2}");
});

test("smelting recipes resolve ids, tags, nested tags and lists, and skip other recipe types", () => {
  const jar = zip({
    "data/minecraft/recipe/glass.json": JSON.stringify({ type: "minecraft:smelting", cookingtime: 200, ingredient: "#minecraft:smelts_to_glass", result: { id: "minecraft:glass" } }),
    "data/minecraft/recipe/iron_ingot_from_smelting_raw_iron.json": JSON.stringify({ type: "minecraft:smelting", cookingtime: 200, ingredient: "minecraft:raw_iron", result: { id: "minecraft:iron_ingot" } }),
    "data/minecraft/recipe/charcoal.json": JSON.stringify({ type: "minecraft:smelting", cookingtime: 200, ingredient: "#minecraft:logs_that_burn", result: { id: "minecraft:charcoal" } }),
    "data/minecraft/recipe/dried_kelp.json": JSON.stringify({ type: "minecraft:smelting", cookingtime: 200, ingredient: ["minecraft:kelp"], result: { count: 1, id: "minecraft:dried_kelp" } }),
    "data/minecraft/recipe/iron_ingot_from_blasting_raw_iron.json": JSON.stringify({ type: "minecraft:blasting", cookingtime: 100, ingredient: "minecraft:raw_iron", result: { id: "minecraft:iron_ingot" } }),
    "data/minecraft/recipe/oak_planks.json": JSON.stringify({ type: "minecraft:crafting_shapeless", ingredients: ["#minecraft:oak_logs"], result: { count: 4, id: "minecraft:oak_planks" } }),
    "data/minecraft/tags/item/smelts_to_glass.json": JSON.stringify({ values: ["minecraft:sand", "minecraft:red_sand"] }),
    "data/minecraft/tags/item/logs_that_burn.json": JSON.stringify({ values: ["#minecraft:oak_logs", { id: "minecraft:birch_log", required: false }] }),
    "data/minecraft/tags/item/oak_logs.json": JSON.stringify({ values: ["minecraft:oak_log", "minecraft:oak_wood"] }),
  }, ["data/minecraft/recipe/glass.json", "data/minecraft/tags/item/logs_that_burn.json"]);
  assert.deepEqual(extractSmeltingRecipes(jar), [
    { output: "charcoal", count: 1, inputs: ["oak_log", "oak_wood", "birch_log"], cookingTicks: 200 },
    { output: "dried_kelp", count: 1, inputs: ["kelp"], cookingTicks: 200 },
    { output: "glass", count: 1, inputs: ["sand", "red_sand"], cookingTicks: 200 },
    { output: "iron_ingot", count: 1, inputs: ["raw_iron"], cookingTicks: 200 },
  ]);
});

test("a recipe naming a tag the jar lacks is reported, not silently emptied", () => {
  const jar = zip({
    "data/minecraft/recipe/glass.json": JSON.stringify({ type: "minecraft:smelting", cookingtime: 200, ingredient: "#minecraft:missing", result: { id: "minecraft:glass" } }),
  });
  assert.throws(() => extractSmeltingRecipes(jar), /minecraft:missing/u);
});

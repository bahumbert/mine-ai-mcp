import assert from "node:assert/strict";
import test from "node:test";
import itemTagData from "./data/item-tags/1.21.4.json" with { type: "json" };
import { cookingTicksOf, fuelCapacity, recipesFor, smeltingData } from "./smelting.js";

const data = (version: string) => ({ version, recipes: [] });

test("a version uses its own smelting data, else the nearest older shipped one, else none", () => {
  const shipped = [data("1.20.1"), data("1.21.4"), data("1.21")];
  assert.equal(smeltingData("1.21.4", shipped)?.version, "1.21.4");
  assert.equal(smeltingData("1.21.8", shipped)?.version, "1.21.4");
  assert.equal(smeltingData("1.21.1", shipped)?.version, "1.21");
  assert.equal(smeltingData("1.19.2", shipped), null);
});

test("the shipped 1.21.4 data knows glass, iron and stone", () => {
  assert.deepEqual(recipesFor("glass", "1.21.4").map((recipe) => recipe.inputs), [["sand", "red_sand"]]);
  assert.ok(recipesFor("iron_ingot", "1.21.4").some((recipe) => recipe.inputs.includes("raw_iron")));
  assert.deepEqual(recipesFor("stone", "1.21.4").map((recipe) => recipe.inputs), [["cobblestone"]]);
  assert.deepEqual(recipesFor("oak_planks", "1.21.4"), []);
});

const itemTags = itemTagData.tags as Record<string, readonly string[]>;
const VERSION = "1.21.4";

test("fuels smelt the game's number of items; nether wood does not burn", () => {
  assert.equal(fuelCapacity("coal", VERSION), 8);
  assert.equal(fuelCapacity("coal_block", VERSION), 80);
  assert.equal(fuelCapacity("oak_planks", VERSION), 1.5);
  assert.equal(fuelCapacity("spruce_log", VERSION), 1.5);
  assert.equal(fuelCapacity("stick", VERSION), 0.5);
  assert.equal(fuelCapacity("oak_slab", VERSION), 0.75);
  assert.equal(fuelCapacity("oak_boat", VERSION), 6);
  assert.equal(fuelCapacity("crimson_planks", VERSION), 0);
  assert.equal(fuelCapacity("warped_stem", VERSION), 0);
  assert.equal(fuelCapacity("sand", VERSION), 0);
});

test("the lava bucket smelts 100 items", () => {
  assert.equal(fuelCapacity("lava_bucket", VERSION), 100);
});

test("every log that burns is a fuel and a nether stem is not", () => {
  assert.ok(itemTags.logs_that_burn!.length > 0);
  for (const log of itemTags.logs_that_burn!) assert.equal(fuelCapacity(log, VERSION), 1.5, log);
  const nether = itemTags.non_flammable_wood!.filter((name) => itemTags.logs?.includes(name));
  assert.ok(nether.length > 0);
  for (const stem of nether) assert.equal(fuelCapacity(stem, VERSION), 0, stem);
});

test("a version with no shipped item tags knows only the fuels named by item: a plank is no fuel there", () => {
  assert.equal(fuelCapacity("coal", "1.20.1"), 8);
  assert.equal(fuelCapacity("lava_bucket", "1.20.1"), 100);
  assert.equal(fuelCapacity("oak_planks", "1.20.1"), 0);
});

test("a fuel smelts more items when the recipe cooks faster, and the cook time is the recipe's", () => {
  assert.equal(cookingTicksOf("raw_iron", VERSION), recipesFor("iron_ingot", VERSION).find((recipe) => recipe.inputs.includes("raw_iron"))!.cookingTicks);
  assert.equal(cookingTicksOf("oak_planks", VERSION), null);
  assert.equal(fuelCapacity("coal", VERSION, 100), 16);
});

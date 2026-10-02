import assert from "node:assert/strict";
import test from "node:test";
import { fuelCapacity, recipesFor, smeltingData } from "./smelting.js";

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

test("fuels smelt the game's number of items; nether wood does not burn", () => {
  assert.equal(fuelCapacity("coal"), 8);
  assert.equal(fuelCapacity("coal_block"), 80);
  assert.equal(fuelCapacity("oak_planks"), 1.5);
  assert.equal(fuelCapacity("spruce_log"), 1.5);
  assert.equal(fuelCapacity("stick"), 0.5);
  assert.equal(fuelCapacity("crimson_planks"), 0);
  assert.equal(fuelCapacity("warped_stem"), 0);
  assert.equal(fuelCapacity("sand"), 0);
});

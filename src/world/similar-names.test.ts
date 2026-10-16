import assert from "node:assert/strict";
import test from "node:test";
import { similarNames, withSimilar } from "./similar-names.js";

const NAMES = ["stick", "sticky_piston", "white_wool", "red_wool", "oak_planks", "spruce_planks", "water_bucket", "iron_ingot", "raw_iron"];

test("an unknown name is matched to the registry names holding its words, then to those a letter or two off", () => {
  assert.deepEqual(similarNames("sticks", NAMES), ["stick"]);
  assert.deepEqual(similarNames("wool", NAMES), ["red_wool", "white_wool"]);
  assert.deepEqual(similarNames("planks", NAMES), ["oak_planks", "spruce_planks"]);
  assert.deepEqual(similarNames("iron_ingots", NAMES), ["iron_ingot"]);
  assert.deepEqual(similarNames("water_source", NAMES), []);
  assert.equal(withSimilar("sticks", NAMES), "sticks (closest: stick)");
  assert.equal(withSimilar("moon_rock", NAMES), "moon_rock");
});

const TOOLS = ["wooden_sword", "stone_sword", "iron_sword", "golden_sword", "wooden_pickaxe", "stone_pickaxe", "wooden_hoe", "iron_hoe", "water_bucket", "iron_ingot", "oak_wood", "oak_planks", "stick"];

test("a wrong material is still matched to the items of the same kind, a bare kind to the names holding it", () => {
  assert.ok(similarNames("oak_sword", TOOLS).includes("wooden_sword"));
  assert.ok(similarNames("oak_sword", TOOLS).slice(0, 4).every((name) => name.endsWith("_sword")));
  assert.ok(similarNames("birch_pickaxe", TOOLS).includes("wooden_pickaxe"));
  assert.deepEqual(similarNames("hoe", TOOLS), ["iron_hoe", "wooden_hoe"]);
  assert.deepEqual(similarNames("water", TOOLS), ["water_bucket"]);
  assert.deepEqual(similarNames("sticks", TOOLS), ["stick"]);
});

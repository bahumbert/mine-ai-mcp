import assert from "node:assert/strict";
import test from "node:test";
import { blockDropsData, likeliestOrdinaryDrop, ordinaryDrops, ripeState, seedOf, sourcesOf } from "./block-drops.js";

test("the shipped data serves the server's version, or the nearest older one, or a newer patch, or none", () => {
  assert.equal(blockDropsData("1.21.4")?.version, "1.21.4");
  assert.equal(blockDropsData("1.21.9")?.version, "1.21.4");
  assert.equal(blockDropsData("1.21.1")?.version, "1.21.4");
  assert.equal(blockDropsData("1.20.1"), null);
});

test("an ordinary break drops what needs no tool: seeds from grass, cobblestone from stone", () => {
  assert.deepEqual(ordinaryDrops("short_grass", "1.21.4").map((drop) => drop.item), ["wheat_seeds"]);
  assert.deepEqual(ordinaryDrops("stone", "1.21.4").map((drop) => drop.item), ["cobblestone"]);
  assert.deepEqual(ordinaryDrops("not_a_block", "1.21.4"), []);
});

test("the likeliest ordinary drop is what a break most often yields, not the first listed", () => {
  assert.equal(likeliestOrdinaryDrop("gravel", "1.21.4"), "gravel");
  assert.equal(likeliestOrdinaryDrop("short_grass", "1.21.4"), "wheat_seeds");
  assert.equal(likeliestOrdinaryDrop("oak_leaves", "1.21.4"), "oak_sapling");
  assert.equal(likeliestOrdinaryDrop("air", "1.21.4"), null);
});

test("the sources of an item put wild blocks before crops someone planted, then the likeliest first", () => {
  const seeds = sourcesOf("wheat_seeds", "1.21.4");
  assert.deepEqual(seeds.slice(0, 4).map((source) => [source.block, source.chance, source.planted]).toSorted(), [
    ["fern", 0.125, false], ["large_fern", 0.125, false], ["short_grass", 0.125, false], ["tall_grass", 0.125, false],
  ]);
  assert.deepEqual(seeds.find((source) => source.block === "wheat"), { block: "wheat", chance: 1, planted: true, seed: "wheat_seeds" });
  assert.deepEqual(sourcesOf("raw_iron", "1.21.4").map((source) => source.block).toSorted(), ["deepslate_iron_ore", "iron_ore"]);
  assert.deepEqual(sourcesOf("sugar_cane", "1.21.4"), [{ block: "sugar_cane", chance: 1, planted: false }]);
  // A crop's harvest comes from a farm too, not only its seed.
  assert.deepEqual(sourcesOf("wheat", "1.21.4"), [{ block: "wheat", chance: 1, planted: true, seed: "wheat_seeds" }]);
  assert.deepEqual(sourcesOf("diamond_pickaxe", "1.21.4"), []);
});

test("a crop's ripe state and its seed come from its loot table", () => {
  assert.deepEqual(ripeState("wheat", "1.21.4"), { age: "7" });
  assert.deepEqual(ripeState("beetroots", "1.21.4"), { age: "3" });
  assert.equal(ripeState("sugar_cane", "1.21.4"), null);
  assert.equal(seedOf("wheat", "1.21.4"), "wheat_seeds");
  assert.equal(seedOf("carrots", "1.21.4"), "carrot");
  assert.equal(seedOf("potatoes", "1.21.4"), "potato");
  assert.equal(seedOf("beetroots", "1.21.4"), "beetroot_seeds");
});

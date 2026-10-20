import assert from "node:assert/strict";
import test from "node:test";
import { registry } from "../test-support/bot.js";
import blockTags from "./data/block-tags/1.21.4.json" with { type: "json" };
import {
  isAir,
  isDryPlacementSite,
  isLiquid,
  isReplaceableForPlacement,
  supportsFlatPlacement,
  type ClassifiedBlock,
} from "./block-classification.js";

const VERSION = "1.21.4";

const block = (name: string, boundingBox: ClassifiedBlock["boundingBox"] = "empty"): ClassifiedBlock => ({
  name,
  boundingBox,
});

/** A block as a world cell reports it: with its block-state properties. */
const stated = (name: string, properties: Record<string, string | number | boolean>): ClassifiedBlock => ({
  ...block(name),
  getProperties: () => properties,
});

test("classifies placement cells and support", () => {
  assert.equal(isAir(block("cave_air")), true);
  assert.equal(isLiquid(block("water")), true);
  assert.equal(isReplaceableForPlacement(block("tall_grass"), VERSION), true);
  assert.equal(isReplaceableForPlacement(block("seagrass"), VERSION), true);
  assert.equal(isReplaceableForPlacement(block("torch"), VERSION), false);
  assert.equal(supportsFlatPlacement(block("stone", "block")), true);
  assert.equal(supportsFlatPlacement(null), false);
});

test("a flower cell is not replaceable: the server refuses a block placed into it", () => {
  for (const flower of ["poppy", "orange_tulip", "dandelion", "wither_rose"]) assert.equal(isReplaceableForPlacement(block(flower), VERSION), false, flower);
});

test("a block is replaceable when the version's replaceable tag holds it, for every block of the registry", () => {
  const tagged = new Set(blockTags.tags.replaceable);
  assert.ok(tagged.size > 0);
  for (const entry of registry.blocksArray) {
    assert.equal(isReplaceableForPlacement(block(entry.name, entry.boundingBox as ClassifiedBlock["boundingBox"]), VERSION), tagged.has(entry.name), entry.name);
  }
});

test("a snow layer is replaceable only as the single layer; a cell that does not say its layers is trusted to the tag", () => {
  assert.equal(isReplaceableForPlacement(stated("snow", { layers: 1 }), VERSION), true);
  assert.equal(isReplaceableForPlacement(stated("snow", { layers: 3 }), VERSION), false);
  assert.equal(isReplaceableForPlacement(block("snow"), VERSION), true);
});

test("a version with no shipped tags replaces air and liquids only", () => {
  for (const name of ["air", "cave_air", "water", "lava"]) assert.equal(isReplaceableForPlacement(block(name), "1.20.1"), true, name);
  for (const name of ["short_grass", "tall_grass", "torch"]) assert.equal(isReplaceableForPlacement(block(name), "1.20.1"), false, name);
});

/**
 * Vanilla replaces a fluid cell with the block being placed, source included.
 * That is how a lava face is closed before a target break and how a pour cell
 * is made in solid rock. A *site chosen for* the bot is a different question.
 */
test("a fluid cell takes a placement, but is never chosen as a site", () => {
  for (const liquid of ["water", "lava"]) {
    assert.equal(isReplaceableForPlacement(block(liquid), VERSION), true);
    assert.equal(isDryPlacementSite(block(liquid), VERSION), false);
  }
  assert.equal(isDryPlacementSite(block("cave_air"), VERSION), true);
  assert.equal(isDryPlacementSite(block("torch"), VERSION), false);
});

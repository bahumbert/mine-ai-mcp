import assert from "node:assert/strict";
import minecraftData from "minecraft-data";
import test from "node:test";
import { DEFAULT_MINECRAFT_VERSION } from "../server/config.js";
import { bucketItem, bucketItems, EMPTY_BUCKET } from "./buckets.js";
import { LIQUIDS } from "./liquid.js";

const registry = minecraftData(DEFAULT_MINECRAFT_VERSION);

test("each liquid's full bucket is an item of the registry, and so is the empty one", () => {
  assert.ok(registry.itemsByName[EMPTY_BUCKET], `no item ${EMPTY_BUCKET}`);
  for (const liquid of LIQUIDS) {
    assert.ok(registry.blocksByName[liquid], `no block ${liquid}`);
    assert.ok(registry.itemsByName[bucketItem(liquid, true)], `no item ${bucketItem(liquid, true)}`);
  }
});

test("an empty bucket is the same item for every liquid", () => {
  for (const liquid of LIQUIDS) assert.equal(bucketItem(liquid, false), EMPTY_BUCKET);
});

test("the bucket items are the empty bucket, then each liquid's full one", () => {
  assert.deepEqual(bucketItems(), [EMPTY_BUCKET, ...LIQUIDS.map((liquid) => bucketItem(liquid, true))]);
});

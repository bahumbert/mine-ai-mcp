import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import minecraftData from "minecraft-data";
import test from "node:test";
import { DEFAULT_MINECRAFT_VERSION } from "../server/config.js";
import { bucketItem, bucketItems, EMPTY_BUCKET } from "./buckets.js";
import { EMPTY_BUCKET as EMPTY_BUCKET_LEAF } from "./empty-bucket.js";
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

test("buckets.ts re-exports the empty bucket's name from its leaf module, the one the brain imports", () => {
  assert.equal(EMPTY_BUCKET, EMPTY_BUCKET_LEAF);
});

test("the leaf module imports nothing: the brain's bundle pulls one constant, not buckets.ts's imports", () => {
  const source = readFileSync(new URL("./empty-bucket.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*(import|export\s+\*|export\s+\{[^}]*\}\s+from)\b/mu);
});

import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import { NEWEST_REGISTRY_VERSION, stackSizeOf } from "./newest-registry.ts";

test("the newest registry is one minecraft-data ships", () => {
  assert.equal(typeof NEWEST_REGISTRY_VERSION, "string");
  assert.notEqual(NEWEST_REGISTRY_VERSION, "");
  assert.notEqual(minecraftData(NEWEST_REGISTRY_VERSION), undefined);
});

test("stack sizes come from the registry: one for a lava bucket or a boat, 64 for coal, none for an unknown item", () => {
  assert.equal(stackSizeOf("lava_bucket"), 1);
  assert.equal(stackSizeOf("oak_boat"), 1);
  assert.equal(stackSizeOf("coal"), 64);
  assert.equal(stackSizeOf("not_an_item"), null);
});

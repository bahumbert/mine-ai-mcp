import assert from "node:assert/strict";
import test from "node:test";
import { itemTagsOf } from "./item-tags.js";

test("an item's tags come from the shipped item tags of the server's version, the nearest older one, or none", () => {
  assert.ok(itemTagsOf("oak_log", "1.21.4").includes("logs_that_burn"));
  assert.ok(itemTagsOf("oak_planks", "1.21.7").includes("planks"));
  assert.ok(itemTagsOf("crimson_stem", "1.21.4").includes("non_flammable_wood"));
  assert.ok(!itemTagsOf("crimson_stem", "1.21.4").includes("logs_that_burn"));
  assert.deepEqual(itemTagsOf("oak_log", "1.20.1"), []);
  assert.deepEqual(itemTagsOf("not_an_item", "1.21.4"), []);
});

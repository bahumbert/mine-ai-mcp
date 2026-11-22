import assert from "node:assert/strict";
import test from "node:test";
import { isArrowItem, itemTagsOf } from "./item-tags.js";

test("an item's tags come from the shipped item tags of the server's version, the nearest older one, or none", () => {
  assert.ok(itemTagsOf("oak_log", "1.21.4").includes("logs_that_burn"));
  assert.ok(itemTagsOf("oak_planks", "1.21.7").includes("planks"));
  assert.ok(itemTagsOf("crimson_stem", "1.21.4").includes("non_flammable_wood"));
  assert.ok(!itemTagsOf("crimson_stem", "1.21.4").includes("logs_that_burn"));
  assert.deepEqual(itemTagsOf("oak_log", "1.8.9"), []);
  assert.deepEqual(itemTagsOf("not_an_item", "1.21.4"), []);
});

test("every supported version is served its own item tags: 1.21.1 is not 1.21.4, and 1.20.4 and 1.19.4 arrows are arrows", () => {
  // `pale_oak_logs` is a 1.21.4 tag, `flowers` a 1.21.1 one (measured in the jars).
  assert.ok(itemTagsOf("pale_oak_log", "1.21.4").includes("pale_oak_logs"));
  assert.deepEqual(itemTagsOf("pale_oak_log", "1.21.1"), []);
  assert.ok(itemTagsOf("dandelion", "1.21.1").includes("flowers"));
  assert.ok(!itemTagsOf("dandelion", "1.21.4").includes("flowers"));
  for (const version of ["1.19.4", "1.20.1", "1.20.4", "1.20.6", "1.21.1"]) {
    for (const arrow of ["arrow", "spectral_arrow", "tipped_arrow"]) assert.equal(isArrowItem(arrow, version), true, `${arrow} ${version}`);
    assert.equal(isArrowItem("bow", version), false, version);
    assert.ok(itemTagsOf("oak_planks", version).includes("planks"), version);
  }
});

test("an arrow item is any member of the game's `arrows` tag, none for other items, unknown names or a version older than every shipped file", () => {
  for (const arrow of ["arrow", "spectral_arrow", "tipped_arrow"]) assert.equal(isArrowItem(arrow, "1.21.4"), true, arrow);
  assert.equal(isArrowItem("bow", "1.21.4"), false);
  assert.equal(isArrowItem("no_such_item", "1.21.4"), false);
  assert.equal(isArrowItem("arrow", "1.8.9"), false);
});

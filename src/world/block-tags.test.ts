import assert from "node:assert/strict";
import test from "node:test";
import { tagNamesOf, tagsOf } from "./block-tags.js";

test("a block's tags come from the shipped data of the server's version, the nearest older one, or a newer patch", () => {
  assert.ok(tagsOf("oak_log", "1.21.4").includes("logs"));
  assert.ok(tagsOf("warped_stem", "1.21.9").includes("logs"));
  assert.ok(tagsOf("spruce_log", "1.21.1").includes("logs"));
  assert.ok(tagsOf("wheat", "1.21.4").includes("crops"));
  assert.deepEqual(tagsOf("oak_log", "1.20.1"), []);
  assert.deepEqual(tagsOf("not_a_block", "1.21.4"), []);
});

test("a version's tag names are the shipped file's, sorted, and none without data", () => {
  const names = tagNamesOf("1.21.4");
  assert.ok(names.includes("logs") && names.includes("mineable/pickaxe"));
  assert.deepEqual([...names], [...names].sort());
  assert.deepEqual(tagNamesOf("1.20.1"), []);
});

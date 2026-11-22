import assert from "node:assert/strict";
import test from "node:test";
import { tagNamesOf, tagsOf } from "./block-tags.js";

test("a block's tags come from the shipped data of the server's version, the nearest older one, or a newer patch", () => {
  assert.ok(tagsOf("oak_log", "1.21.4").includes("logs"));
  assert.ok(tagsOf("warped_stem", "1.21.9").includes("logs"));
  assert.ok(tagsOf("spruce_log", "1.21.1").includes("logs"));
  assert.ok(tagsOf("wheat", "1.21.4").includes("crops"));
  assert.deepEqual(tagsOf("oak_log", "1.8.9"), []);
  assert.deepEqual(tagsOf("not_a_block", "1.21.4"), []);
});

test("every supported version has its own block tags", () => {
  for (const version of ["1.19.4", "1.20.1", "1.20.4", "1.20.6", "1.21.1"]) {
    assert.ok(tagsOf("oak_log", version).includes("logs"), version);
    assert.ok(tagsOf("wheat", version).includes("crops"), version);
  }
  // A 1.21.4 block is not in 1.21.1's own file (pale oak arrived after 1.21.1).
  assert.ok(tagsOf("pale_oak_log", "1.21.4").includes("logs"));
  assert.deepEqual(tagsOf("pale_oak_log", "1.21.1"), []);
});

test("a version's tag names are the shipped file's, sorted, and none without data", () => {
  const names = tagNamesOf("1.21.4");
  assert.ok(names.includes("logs") && names.includes("mineable/pickaxe"));
  assert.deepEqual([...names], [...names].sort());
  assert.deepEqual(tagNamesOf("1.8.9"), []);
});

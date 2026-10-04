import assert from "node:assert/strict";
import test from "node:test";
import { tagsOf } from "./block-tags.js";

test("a block's tags come from the shipped data of the server's version, or the nearest older one", () => {
  assert.ok(tagsOf("oak_log", "1.21.4").includes("logs"));
  assert.ok(tagsOf("warped_stem", "1.21.9").includes("logs"));
  assert.ok(tagsOf("wheat", "1.21.4").includes("crops"));
  assert.deepEqual(tagsOf("oak_log", "1.20.1"), []);
  assert.deepEqual(tagsOf("not_a_block", "1.21.4"), []);
});

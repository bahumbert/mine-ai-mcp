import assert from "node:assert/strict";
import test from "node:test";
import { isCanopy } from "./block-kinds.ts";

test("a block with the leaves tag is canopy, whatever its name; no kind, no tags or other tags are not", () => {
  assert.equal(isCanopy({ tool: null, solid: true, harvest: null, tags: ["leaves", "mineable/hoe"] }), true);
  assert.equal(isCanopy({ tool: null, solid: true, harvest: null, tags: ["logs"] }), false);
  assert.equal(isCanopy({ tool: null, solid: true, harvest: null }), false);
  assert.equal(isCanopy(undefined), false);
});

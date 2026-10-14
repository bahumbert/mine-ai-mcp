import assert from "node:assert/strict";
import test from "node:test";
import { describeProtectedRegion, protectedRegionAt, type ProtectedRegion } from "./protected-regions.js";

const house: ProtectedRegion = {
  regionId: 1, dimension: "overworld", min: { x: 0, y: 63, z: 0 }, max: { x: 6, y: 70, z: 4 }, owner: "Ayla", label: "small medieval house",
};

test("a region holds its cells inclusively, in its own dimension only", () => {
  assert.equal(protectedRegionAt([house], "overworld", 0, 63, 0), house);
  assert.equal(protectedRegionAt([house], "overworld", 6, 70, 4), house);
  assert.equal(protectedRegionAt([house], "overworld", 7, 70, 4), null);
  assert.equal(protectedRegionAt([house], "overworld", 3, 62, 2), null);
  assert.equal(protectedRegionAt([house], "the_nether", 3, 65, 2), null);
});

test("the owner's own build is exempt, whatever the name's case", () => {
  assert.equal(protectedRegionAt([house], "overworld", 3, 65, 2, "ayla"), null);
  assert.equal(protectedRegionAt([house], "overworld", 3, 65, 2, "Tom"), house);
  assert.equal(describeProtectedRegion(house), "protected region #1 'small medieval house' (owner Ayla)");
});

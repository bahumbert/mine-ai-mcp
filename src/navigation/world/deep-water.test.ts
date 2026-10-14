import assert from "node:assert/strict";
import test from "node:test";
import { holdsWater, isDeepOpenWater, type WaterAt } from "./deep-water.js";

/** Water in a box (inclusive), nothing else. */
function box(min: [number, number, number], max: [number, number, number]): WaterAt {
  return (x, y, z) => x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2];
}

test("an ocean three deep and wider than eight blocks is deep open water, at the surface and below", () => {
  const ocean = box([-50, 50, -50], [50, 62, 50]);
  assert.equal(isDeepOpenWater(ocean, 0, 62, 0), true);
  assert.equal(isDeepOpenWater(ocean, 10, 55, -3), true);
});

test("shallow water is waded, a river is swum along or across: neither is deep open water", () => {
  assert.equal(isDeepOpenWater(box([-50, 61, -50], [50, 62, 50]), 0, 62, 0), false, "two deep");
  // A river eight wide, long along z.
  assert.equal(isDeepOpenWater(box([0, 55, -100], [7, 62, 100]), 3, 62, 0), false);
  assert.equal(isDeepOpenWater(box([0, 55, 0], [8, 62, 8]), 4, 62, 4), true, "nine by nine");
  assert.equal(isDeepOpenWater(box([0, 55, 0], [8, 62, 7]), 4, 62, 4), false, "nine by eight");
});

test("a cell that is not water is never deep water", () => {
  assert.equal(isDeepOpenWater(() => false, 0, 62, 0), false);
});

test("kelp, seagrass and waterlogged blocks hold the sea's water; dry blocks do not", () => {
  // Live 2026-10-04: kelp at the surface read as dry ground stopped a boat ride after two blocks.
  for (const name of ["water", "kelp", "kelp_plant", "seagrass", "tall_seagrass", "bubble_column"]) assert.equal(holdsWater(name), true, name);
  assert.equal(holdsWater("oak_stairs", { waterlogged: true }), true);
  assert.equal(holdsWater("oak_stairs", { waterlogged: false }), false);
  assert.equal(holdsWater("sand"), false);
});

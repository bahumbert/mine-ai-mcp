import assert from "node:assert/strict";
import test from "node:test";
import { farmPlot, plotBehind } from "./plot.ts";

test("a farm is a square of soil around one water cell, every cell within 4 of the water", () => {
  const plot = farmPlot({ x: 10, y: 63, z: -5 }, 9);
  assert.deepEqual(plot, { centre: { x: 10, y: 63, z: -5 }, water: { x: 10, y: 63, z: -5 }, size: 9, min: { x: 6, z: -9 }, max: { x: 14, z: -1 } });
  for (let x = plot.min.x; x <= plot.max.x; x += 1) for (let z = plot.min.z; z <= plot.max.z; z += 1) {
    assert.ok(Math.max(Math.abs(x - plot.water.x), Math.abs(z - plot.water.z)) <= 4);
  }
  assert.deepEqual(farmPlot({ x: 0, y: 70, z: 0 }, 3).min, { x: -1, z: -1 });
});

test("a new farm lies behind the character, away from whoever asked, one free block between her and its near edge, its soil at the level she stands on", () => {
  // Tom stands north: the farm goes south.
  assert.deepEqual(plotBehind({ x: 0.5, y: 64, z: 0.5 }, { x: 0, y: 64, z: -10 }, 5).centre, { x: 0, y: 63, z: 4 });
  // Tom stands east: the farm goes west.
  assert.deepEqual(plotBehind({ x: 0.5, y: 64, z: 0.5 }, { x: 10, y: 64, z: 0 }, 9).centre, { x: -6, y: 63, z: 0 });
  // Nobody asked: like a house, it faces north, so the farm lies south.
  const alone = plotBehind({ x: 3.2, y: 70, z: -2.7 }, null, 9);
  assert.deepEqual(alone.centre, { x: 3, y: 69, z: 3 });
  assert.equal(alone.min.z, -1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { LANE_SPACING, LAST_BODY, controlChunkOf, laneOf } from "./lanes.ts";

test("lane k sits LANE_SPACING blocks along z, in a cell that holds its arena and scratch copy", () => {
  const lane = laneOf(3);
  assert.equal(lane.index, 3);
  assert.deepEqual(lane.offset, { x: 0, z: 3 * LANE_SPACING });
  assert.deepEqual(lane.cell, { minX: -512, maxX: 1535, minZ: 3 * LANE_SPACING - 256, maxZ: 3 * LANE_SPACING + 255 });
});

test("neighbouring cells touch without overlapping, so a boxed selector never sees the next lane", () => {
  const lower = laneOf(2).cell;
  const upper = laneOf(3).cell;
  assert.equal(lower.maxZ + 1, upper.minZ);
});

test("lane 0 is not a shared lane: it belongs to scenarios that were refused", () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => laneOf(bad), RangeError, String(bad));
});

test("a lane's body defaults to 0, keeps the lane's place and is a whole number below the base-36 limit", () => {
  assert.equal(laneOf(3).body, 0);
  const again = laneOf(3, 7);
  assert.equal(again.body, 7);
  assert.deepEqual({ ...again, body: 0 }, laneOf(3));
  assert.equal(laneOf(3, LAST_BODY).body, LAST_BODY);
  for (const bad of [-1, 1.5, Number.NaN, LAST_BODY + 1]) assert.throws(() => laneOf(3, bad), RangeError, String(bad));
});

test("the control chunk lies inside its lane's cell and outside every arena (x beyond -100, the widest arena's edge)", () => {
  const lane = laneOf(7);
  const control = controlChunkOf(lane);
  assert.deepEqual(control, { x: -496, z: 7 * LANE_SPACING - 240 });
  assert.ok(control.x >= lane.cell.minX && control.x <= lane.cell.maxX);
  assert.ok(control.z >= lane.cell.minZ && control.z <= lane.cell.maxZ);
  assert.ok(control.x < -100);
});

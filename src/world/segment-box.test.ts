// Finite segment intersections with inflated entity boxes.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { segmentHitsBox } from "./segment-box.js";

const box = { min: new Vec3(2, 2, 2), max: new Vec3(4, 4, 4) };
for (const [name, from, to, inflate, hit] of [
  ["through the centre", new Vec3(0, 3, 3), new Vec3(6, 3, 3), 0, true],
  ["0.1 outside the inflated face", new Vec3(0, 6.1, 3), new Vec3(6, 6.1, 3), 2, false],
  ["0.1 inside the inflated face", new Vec3(0, 5.9, 3), new Vec3(6, 5.9, 3), 2, true],
  ["parallel on the face", new Vec3(0, 4, 3), new Vec3(6, 4, 3), 0, true],
  ["parallel outside the face", new Vec3(0, 4.1, 3), new Vec3(6, 4.1, 3), 0, false],
  ["zero length inside", new Vec3(3, 3, 3), new Vec3(3, 3, 3), 0, true],
  ["zero length outside", new Vec3(1, 3, 3), new Vec3(1, 3, 3), 0, false],
  ["reversed endpoints", new Vec3(6, 3, 3), new Vec3(0, 3, 3), 0, true],
  ["box beyond the endpoint", new Vec3(0, 3, 3), new Vec3(1.9, 3, 3), 0, false],
  ["box behind the start", new Vec3(4.1, 3, 3), new Vec3(6, 3, 3), 0, false],
  ["touching the endpoint", new Vec3(0, 3, 3), new Vec3(2, 3, 3), 0, true],
  ["diagonal through the box", new Vec3(0, 0, 0), new Vec3(6, 6, 6), 0, true],
  ["disjoint slab intervals", new Vec3(0, 3, 0), new Vec3(6, 9, 6), 0, false],
] as const) test(`segment hits box: ${name}`, () => {
  assert.equal(segmentHitsBox(from, to, box, inflate), hit);
});

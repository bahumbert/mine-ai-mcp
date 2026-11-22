// Caller costs rank mining targets without refusing the last available target.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { weighTargets } from "./target-weighing.js";

test("weighTargets keeps near-equal choices, passes over expensive ones, and leaves ties stable", () => {
  const feet = new Vec3(0.5, 64.5, 0.5);
  const blocks = [1, 10, 14, 15, -10].map((x) => ({ position: new Vec3(x, 64, 0) }));
  const result = weighTargets(blocks, feet, (position) => position.x === 1 ? 64 : 0);
  assert.deepEqual(result.kept, [blocks[1], blocks[4], blocks[2]]);
  assert.deepEqual(result.passedOver, [blocks[3], blocks[0]]);
  assert.equal(result.unread, 0);
});

test("weighTargets never empties a costed set and defers null costs unless all are unread", () => {
  const blocks = [1, 5].map((x) => ({ position: new Vec3(x, 64, 0) }));
  const feet = new Vec3(0.5, 64.5, 0.5);
  for (const costs of [[null, 64], [null, null], [64, 64]] as const) {
    const result = weighTargets(blocks, feet, (position) => costs[position.x === 1 ? 0 : 1]);
    assert.deepEqual(result.kept, costs[1] === 64 && costs[0] === null ? [blocks[1]] : blocks);
    assert.deepEqual(result.passedOver, []);
    assert.equal(result.unread, costs.filter((cost) => cost === null).length);
  }
  assert.deepEqual(weighTargets([], feet, () => 0), { kept: [], passedOver: [], unread: 0 });
});

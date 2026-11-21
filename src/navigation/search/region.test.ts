// Tests the route geometry used by search evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { RegionClip, regionAllowances, routeDetour, searchRegion } from "./region.js";
import type { GoalRegion, ResolvedGoal } from "../goals/goal.js";

test("a region is used only with finite straight distances, at least one part and the goal's own predicate", () => {
  const root = { x: 0, y: 63, z: 0 };
  const satisfies = () => false;
  const goalWith = (region: GoalRegion, isSatisfied = satisfies) => ({
    kind: "active", revision: "r", heuristic: () => 0, isSatisfied, region: () => region,
  }) as Extract<ResolvedGoal, { kind: "active" }>;
  const part = (straight: number) => ({ straight, distance: () => 0 });
  assert.equal(searchRegion(goalWith({ satisfies, parts: [part(3)] }), root)?.parts.length, 1);
  assert.equal(searchRegion(goalWith({ satisfies, parts: [part(3), part(NaN)] }), root), null);
  assert.equal(searchRegion(goalWith({ satisfies, parts: [part(Infinity)] }), root), null);
  assert.equal(searchRegion(goalWith({ satisfies, parts: [] }), root), null);
  assert.equal(searchRegion(goalWith({ satisfies: () => true, parts: [part(3)] }), root), null);
});

test("route detour reads a route of any length", () => {
  const root = { x: 0, y: 63, z: 0 };
  const region = { satisfies: () => false, parts: [{ straight: 1, distance: () => 1 }] };
  // 1 000 000 cells: the smallest round size at which `Math.max(...cells)` throws in Bun 1.4.2 (500 000 still passes).
  const cells = Array.from({ length: 1_000_000 }, (_, i) => ({ x: 0, y: 63, z: i % 2 }));
  assert.equal(routeDetour(region, root, cells).detour, 2);
});

test("route detour uses the part nearest the route endpoint and includes the root", () => {
  const root = { x: 0, y: 63, z: 0 };
  const region = { satisfies: () => false, parts: [
    { straight: 2, distance: (p: typeof root) => Math.abs(p.x - 2) },
    { straight: 20, distance: (p: typeof root) => Math.abs(p.x - 20) },
  ] };
  const cells = [{ x: 0, y: 63, z: 3 }, { x: 20, y: 63, z: 0 }];
  assert.deepEqual(routeDetour(region, root, cells), { part: 1, straight: 20, detour: Math.hypot(0, 3) + 20 });
  assert.deepEqual(routeDetour(region, root, []), { part: 0, straight: 2, detour: 2 });
});

/** A part accepting only the cell (x, 63, 0): axis-aligned integer geometry, so the sums below are exact whole numbers. */
function partAt(x: number) {
  return { straight: Math.abs(x), distance: (p: { x: number; y: number; z: number }) => Math.hypot(p.x - x, p.y - 63, p.z) };
}
const ROOT = { x: 0, y: 63, z: 0 };

test("a clip admits through any part, counts each refusal and reports the largest refused sum of the part with the smallest straight distance", () => {
  const clip = new RegionClip({ satisfies: () => false, parts: [partAt(20), partAt(3)] }, ROOT, { stretch: 1, margin: 0 });
  assert.equal(clip.part, 1, "the part at 3 has the smallest straight distance");
  assert.equal(clip.allowance, 3);
  assert.equal(clip.admits({ x: 12, y: 63, z: 0 }), true, "12 + 8 = 20: inside the far part's allowance of 20 only");
  assert.equal(clip.admits({ x: 3, y: 63, z: 0 }), true, "a part's own cell sums to its straight distance");
  assert.equal(clip.refused, 0);
  const far = { x: 0, y: 63, z: 5 };
  assert.equal(clip.admits(far), false);
  assert.equal(clip.admits({ x: 0, y: 63, z: 4 }), false);
  assert.equal(clip.refused, 2);
  assert.equal(clip.observed, Math.hypot(0, 0, 5) + Math.hypot(-3, 0, 5), "the larger of the two refused sums, for part 1");
});

test("a clip at stretch 1 and margin 0 admits every cell on the straight line, whatever the square-root rounding", () => {
  // The goal (3, 63, 27) and the cell (1, 63, 9) lie on one line from the root: the cell's two Euclidean legs sum
  // one ulp over the straight distance (27.166155414412252 against 27.16615541441225).
  const goal = { x: 3, y: 63, z: 27 };
  const part = { straight: Math.hypot(goal.x, 0, goal.z), distance: (p: { x: number; y: number; z: number }) => Math.hypot(p.x - goal.x, p.y - goal.y, p.z - goal.z) };
  const clip = new RegionClip({ satisfies: () => false, parts: [part] }, ROOT, { stretch: 1, margin: 0 });
  assert.equal(clip.admits({ x: 1, y: 63, z: 9 }), true);
  assert.equal(clip.refused, 0);
  assert.equal(clip.admits({ x: 1, y: 63, z: 10 }), false, "a cell a tenth of a block off the line is a real detour");
});

test("a bound whose allowance overflows gives no allowance list, and a clip cannot be built on it", () => {
  const region = { satisfies: () => false, parts: [partAt(8)] };
  assert.deepEqual(regionAllowances(region, { stretch: 2, margin: 1 }), [17]);
  assert.equal(regionAllowances(region, { stretch: Number.MAX_VALUE, margin: 1 }), null);
  assert.throws(() => new RegionClip(region, ROOT, { stretch: Number.MAX_VALUE, margin: 1 }), RangeError);
});

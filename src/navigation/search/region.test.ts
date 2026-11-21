// Tests the route geometry used by search evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { routeDetour, searchRegion } from "./region.js";
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

import { MemoryWorld } from "../world/memory-world.js";
import { OverlayInterner, PlanningOverlay } from "./planning-overlay.js";
import assert from "node:assert/strict";
import test from "node:test";

test("equivalent overlay results share identity independent of edit order", () => {
  const interner = new OverlayInterner();
  const root = new PlanningOverlay(interner);
  const first = root
    .apply({ kind: "place", position: { x: 1, y: 2, z: 3 }, stateId: 4 })
    .apply({ kind: "break", position: { x: 2, y: 2, z: 3 }, stateId: 0 });
  const second = root
    .apply({ kind: "break", position: { x: 2, y: 2, z: 3 }, stateId: 0 })
    .apply({ kind: "place", position: { x: 1, y: 2, z: 3 }, stateId: 4 });
  assert.equal(first.identity, second.identity);
});

test("an opened door keeps its block's per-cell offset", () => {
  const world = new MemoryWorld();
  const at = { x: 3, y: 4, z: 5 };
  world.load(at, { stateId: 6, horizontalOffset: 0.25, traits: { empty: false, activationGroup: "door" } });
  const opened = new PlanningOverlay(new OverlayInterner()).apply({ kind: "activate", position: at, stateId: 7 }).blockAt(world, at.x, at.y, at.z);
  assert.equal(opened.kind === "loaded" && opened.horizontalOffset, 0.25);
  assert.equal(opened.kind === "loaded" && opened.traits.open, true);
});

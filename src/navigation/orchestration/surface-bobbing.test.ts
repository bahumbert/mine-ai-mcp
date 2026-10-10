import assert from "node:assert/strict";
import test from "node:test";
import { observation } from "../../test-support/navigation.js";
import { MemoryWorld } from "../world/memory-world.js";
import { isSurfaceBobbing } from "./surface-bobbing.js";

test("surface bobbing tolerates only a held swimmer in the same still-water column", () => {
  const world = new MemoryWorld();
  for (const y of [60, 61, 62]) world.load({ x: 0, y, z: 0 }, {
    stateId: 1, collisionShapes: [], traits: { liquid: "water", liquidSource: true },
  });
  world.load({ x: 0, y: 63, z: 0 }, { stateId: 0 });
  const start = { ...observation(), stance: "swimming" as const, position: { x: 0.5, y: 62.3, z: 0.5 } };
  const current = { ...start, position: { ...start.position, y: 61.76 } };
  assert.equal(isSurfaceBobbing(start, current, world), true);
  assert.equal(isSurfaceBobbing(current, start, world), true);
  assert.equal(isSurfaceBobbing(start, { ...current, stance: "airborne" }, world), true);
  assert.equal(isSurfaceBobbing({ ...start, stance: "airborne" }, current, world), false);
  for (const stance of ["supported", "climbing"] as const)
    assert.equal(isSurfaceBobbing(start, { ...current, stance }, world), false);
  for (const position of [{ x: 1.01, y: 62, z: 0.5 }, { x: 0.7, y: 62, z: 0.5 },
    { x: 0.5, y: 60.5, z: 0.5 }, { x: 0.5, y: 63.1, z: 0.5 }])
    assert.equal(isSurfaceBobbing(start, { ...current, position }, world), false);
  world.load({ x: 0, y: 62, z: 0 }, { stateId: 1, collisionShapes: [], traits: { liquid: "water", liquidSource: false } });
  assert.equal(isSurfaceBobbing(start, current, world), false);
});

test("a body hopping off the floor of a shallow flow is held; deep water and a current are not", () => {
  const world = new MemoryWorld();
  world.load({ x: 0, y: 59, z: 0 }, { stateId: 1 });
  world.load({ x: 0, y: 60, z: 0 }, { stateId: 1, collisionShapes: [], traits: { liquid: "water", liquidSource: false } });
  world.load({ x: 0, y: 61, z: 0 }, { stateId: 0 });
  const start = { ...observation(), stance: "supported" as const, position: { x: 0.5, y: 60, z: 0.5 } };
  const hop = { ...start, stance: "airborne" as const, position: { x: 0.5, y: 61.5, z: 0.5 } };
  assert.equal(isSurfaceBobbing(start, hop, world), true);
  assert.equal(isSurfaceBobbing(start, { ...hop, position: { x: 0.8, y: 61.5, z: 0.5 } }, world), false);
  assert.equal(isSurfaceBobbing(start, { ...hop, position: { x: 0.5, y: 63.5, z: 0.5 } }, world), false);
  assert.equal(isSurfaceBobbing({ ...start, stance: "airborne" }, hop, world), false);
  world.load({ x: 0, y: 59, z: 0 }, { stateId: 1, collisionShapes: [], traits: { liquid: "water", liquidSource: false } });
  assert.equal(isSurfaceBobbing(start, hop, world), false);
});

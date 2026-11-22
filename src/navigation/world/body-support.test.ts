// Support dependency across the body footprint and stance.
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryWorld } from "./memory-world.js";
import { bodyDependsOnBlock } from "./body-support.js";

test("body support follows footprint, alternate floor, height and floating stance", () => {
  const world = new MemoryWorld();
  const target = { x: 1, y: 62, z: 0 };
  const read = world.blockAt.bind(world);
  const cases = [
    { position: { x: 0.85, y: 63, z: 0.5 }, floating: false, expected: true },
    { position: { x: 0.7, y: 63, z: 0.5 }, floating: false, expected: false },
    { position: { x: 1.5, y: 63, z: -0.15 }, floating: false, expected: true },
    { position: { x: 0.85, y: 63, z: -0.15 }, floating: false, expected: true },
    { position: { x: 1.5, y: 63, z: 0.5 }, floating: false, expected: true },
    { position: { x: 0.85, y: 63.2, z: 0.5 }, floating: true, expected: false },
    { position: { x: 0.85, y: 63.2, z: 0.5 }, floating: false, expected: false },
    { position: { x: 0.85, y: 62.875, z: 0.5 }, floating: false, expected: true },
  ];
  for (const { position, floating, expected } of cases)
    assert.equal(bodyDependsOnBlock(position, floating, target, read), expected, JSON.stringify({ position, floating }));
  world.load({ x: 0, y: 62, z: 0 }, { stateId: 1, collisionShapes: [], traits: { empty: true } });
  assert.equal(bodyDependsOnBlock(cases[0]!.position, false, target, read), true, "air cannot carry the body");
  world.load({ x: 0, y: 62, z: 0 }, { stateId: 2, collisionShapes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }], traits: { empty: false } });
  assert.equal(bodyDependsOnBlock(cases[0]!.position, false, target, read), false, "a safe alternate floor carries the body");
});

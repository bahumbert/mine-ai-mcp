import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { MemoryWorld } from "./memory-world.js";
import { obstaclesOf, worldViewRaycaster } from "./line-of-sight.js";

/** Bamboo's 1.21.4 data box; placed at 191,292 it spans x 191.623..191.810, z 292.556..292.744. */
const BAMBOO_DATA = { minX: 0.15625, minY: 0, minZ: 0.15625, maxX: 0.34375, maxY: 1, maxZ: 0.34375 };

function stalkWorld(horizontalOffset: number) {
  const world = new MemoryWorld();
  for (let z = 290; z <= 295; z += 1) world.load({ x: 191, y: -60, z }, { stateId: 0 });
  world.load({ x: 191, y: -60, z: 292 }, { stateId: 5, collisionShapes: [BAMBOO_DATA], horizontalOffset });
  return worldViewRaycaster((x, y, z) => obstaclesOf(world.blockAt(x, y, z), x, z));
}

const ALONG_Z = new Vec3(0, 0, 1);

test("a ray along the data box misses the placed one", () => {
  const hit = stalkWorld(0.25).raycast(new Vec3(191.25, -59.5, 290.5), ALONG_Z, 5);
  assert.equal(hit, null);
});

test("a ray along the placed box hits it though the data box is elsewhere", () => {
  const hit = stalkWorld(0.25).raycast(new Vec3(191.7, -59.5, 290.5), ALONG_Z, 5);
  assert.deepEqual(hit, { position: { x: 191, y: -60, z: 292 } });
});

test("without an offset the rays answer from the data box", () => {
  assert.deepEqual(stalkWorld(0).raycast(new Vec3(191.25, -59.5, 290.5), ALONG_Z, 5), { position: { x: 191, y: -60, z: 292 } });
  assert.equal(stalkWorld(0).raycast(new Vec3(191.7, -59.5, 290.5), ALONG_Z, 5), null);
});

test("an unloaded cell is still unknown", () => {
  assert.equal(obstaclesOf(new MemoryWorld().blockAt(0, 0, 0), 0, 0), null);
});

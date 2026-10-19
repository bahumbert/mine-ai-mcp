import assert from "node:assert/strict";
import test from "node:test";
import { placeShapes } from "../../world/block-offset.js";
import { MemoryWorld } from "./memory-world.js";
import { collisionBoxesAt } from "./world.js";

/** Bamboo's 1.21.4 data box: vanilla's box moved by the origin cell's offset. */
const BAMBOO_DATA = { minX: 0.15625, minY: 0, minZ: 0.15625, maxX: 0.34375, maxY: 1, maxZ: 0.34375 };
const AT = { x: 191, y: -60, z: 292 };

function loaded(horizontalOffset: number) {
  const world = new MemoryWorld();
  world.load(AT, { stateId: 5, collisionShapes: [BAMBOO_DATA], horizontalOffset });
  const block = world.blockAt(AT.x, AT.y, AT.z);
  if (block.kind !== "loaded") throw new Error("not loaded");
  return block;
}

test("a block without offset hands back its own boxes, allocating nothing", () => {
  const block = loaded(0);
  assert.equal(collisionBoxesAt(block, AT.x, AT.z), block.collisionShapes);
});

test("an offset block's data box is placed where the server has it at Ayla's cell", () => {
  const [box] = collisionBoxesAt(loaded(0.25), AT.x, AT.z);
  const [expected] = placeShapes([[0.15625, 0, 0.15625, 0.34375, 1, 0.34375]], 0.25, AT.x, AT.z);
  assert.ok(box !== undefined && expected !== undefined);
  assert.deepEqual([box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ], expected);
  assert.ok(Math.abs(box.minX - 0.622917) < 1e-6 && Math.abs(box.minZ - 0.55625) < 1e-6, `${box.minX}, ${box.minZ}`);
});

test("placing never changes the observation's own boxes", () => {
  const block = loaded(0.25);
  collisionBoxesAt(block, AT.x, AT.z);
  assert.deepEqual(block.collisionShapes, [BAMBOO_DATA]);
});

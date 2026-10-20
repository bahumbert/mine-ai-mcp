import assert from "node:assert/strict";
import test from "node:test";
import { MemoryWorld } from "./memory-world.js";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import { loadNamedBlock } from "../../test-support/layered-world.js";
import { isSafeSupport, standsOnDryGround } from "./block-geometry.js";

/** A big dripleaf's flat leaf: full width, an eighth short of full height, so a tread by shape alone. */
const LEAF_SHAPE = [{ minX: 0, minY: 0.6875, minZ: 0, maxX: 1, maxY: 0.9375, maxZ: 1 }];

test("a yielding tread is not support, though the same shape is", () => {
  const world = new MemoryWorld();
  world.load({ x: 0, y: 0, z: 0 }, { stateId: 7, collisionShapes: LEAF_SHAPE, traits: { empty: false } });
  world.load({ x: 1, y: 0, z: 0 }, { stateId: 8, collisionShapes: LEAF_SHAPE, traits: { empty: false, yielding: true } });
  assert.equal(isSafeSupport(world.blockAt(0, 0, 0)), true, "a slab-topped block of this height is a floor");
  assert.equal(isSafeSupport(world.blockAt(1, 0, 0)), false, "a big dripleaf is not");
});

test("dry ground needs dry feet and head over safe support: a plant in the feet cell is not dry ground, a carpet floor cell is", () => {
  const registryBot = { registry: minecraftData("1.21.4") } as Pick<Bot, "registry">;
  const world = new MemoryWorld();
  const place = (x: number, y: number, name: string) => loadNamedBlock(world, registryBot, { x, y, z: 0 }, name);
  for (const x of [0, 1, 2]) {
    place(x, 59, "stone");
    place(x, 61, "air");
  }
  place(0, 60, "air");
  place(1, 60, "seagrass");
  place(2, 60, "white_carpet");
  const read = (x: number, y: number, z: number) => world.blockAt(x, y, z);
  assert.equal(standsOnDryGround(read, { x: 0, y: 60, z: 0 }), true, "air over stone");
  assert.equal(standsOnDryGround(read, { x: 1, y: 60, z: 0 }), false, "a water plant at the feet");
  assert.equal(standsOnDryGround(read, { x: 2, y: 60, z: 0 }), true, "a carpet at the feet, as routes see it");
  assert.equal(standsOnDryGround(read, { x: 5, y: 60, z: 0 }), false, "an unloaded cell");
});

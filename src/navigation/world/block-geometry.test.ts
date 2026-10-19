import assert from "node:assert/strict";
import test from "node:test";
import { MemoryWorld } from "./memory-world.js";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import { blockClass, observeMineflayerBlock } from "../mineflayer/world.js";
import { offsetBlocks } from "../../world/block-offset.js";
import { describeBlockGeometry, isSafeSupport, observationBits } from "./block-geometry.js";
import { collisionBoxesAt } from "./world.js";

/** A big dripleaf's flat leaf: full width, an eighth short of full height, so a tread by shape alone. */
const LEAF_SHAPE = [{ minX: 0, minY: 0.6875, minZ: 0, maxX: 1, maxY: 0.9375, maxZ: 1 }];

test("a yielding tread is not support, though the same shape is", () => {
  const world = new MemoryWorld();
  world.load({ x: 0, y: 0, z: 0 }, { stateId: 7, collisionShapes: LEAF_SHAPE, traits: { empty: false } });
  world.load({ x: 1, y: 0, z: 0 }, { stateId: 8, collisionShapes: LEAF_SHAPE, traits: { empty: false, yielding: true } });
  assert.equal(isSafeSupport(world.blockAt(0, 0, 0)), true, "a slab-topped block of this height is a floor");
  assert.equal(isSafeSupport(world.blockAt(1, 0, 0)), false, "a big dripleaf is not");
});

test("placing an offset block's boxes changes no geometry bit, in any state or cell", () => {
  const registry = minecraftData("1.21.4");
  const Block = blockClass({ registry } as unknown as Pick<Bot, "registry">);
  const offsets = offsetBlocks(registry);
  assert.deepEqual([...offsets.keys()].sort(), ["bamboo", "pointed_dripstone"]);
  let compared = 0;
  for (const [name, max] of offsets) {
    const { minStateId, maxStateId } = registry.blocksByName[name]!;
    for (let stateId = minStateId; stateId <= maxStateId; stateId += 1) {
      const data = observeMineflayerBlock(Block.fromStateId(stateId, 0), max);
      for (let x = 0; x < 16; x += 1)
        for (let z = 0; z < 16; z += 1) {
          const placed = collisionBoxesAt(data, x, z);
          const geometry = describeBlockGeometry(data.traits, placed);
          assert.deepEqual(geometry, data.geometry, `${name} state ${stateId} at ${x},${z}`);
          assert.equal(observationBits(geometry, data.traits), data.bits);
          compared += 1;
        }
    }
  }
  assert.ok(compared > 0);
});

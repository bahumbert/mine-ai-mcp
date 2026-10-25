import assert from "node:assert/strict";
import test from "node:test";
import { MemoryWorld } from "./memory-world.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { loadNamedBlock } from "../../test-support/layered-world.js";
import { liveBlockReader } from "../mineflayer/world.js";
import { heldByBlockAt, isSafeSupport, standsOnDryGround } from "./block-geometry.js";

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
  const { bot: registryBot } = createFakeBot();
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

/** A flat world of the named blocks at y 62 (z 0, x 0..3), water over x 2..3 so a footprint can straddle a bank; the rest unloaded. */
function groundAt62(ground: { readonly [x: number]: string }) {
  const { bot } = createFakeBot();
  const world = new MemoryWorld();
  for (const [x, name] of Object.entries(ground)) {
    loadNamedBlock(world, bot, { x: Number(x), y: 62, z: 0 }, name);
    loadNamedBlock(world, bot, { x: Number(x), y: 61, z: 0 }, name === "water" ? "water" : "stone");
    loadNamedBlock(world, bot, { x: Number(x), y: 63, z: 0 }, "air");
  }
  return (x: number, y: number, z: number) => world.blockAt(x, y, z);
}

test("a body is held by a block when a collision top sits at its feet: stone, a bottom slab, soul sand; not a carpet it hovers over", () => {
  // The body rests on a block, not on an entity: a boat under her feet floats 0.56 above a carpet or a slab.
  const read = groundAt62({ 0: "stone", 1: "oak_slab", 2: "soul_sand", 3: "white_carpet" });
  assert.equal(heldByBlockAt(read, { x: 0.5, y: 63, z: 0.5 }), true, "stone top");
  assert.equal(heldByBlockAt(read, { x: 1.5, y: 62.5, z: 0.5 }), true, "bottom slab top");
  assert.equal(heldByBlockAt(read, { x: 1.5, y: 63.06, z: 0.5 }), false, "0.56 above the slab");
  assert.equal(heldByBlockAt(read, { x: 2.5, y: 62.875, z: 0.5 }), true, "soul sand top, 0.875");
  assert.equal(heldByBlockAt(read, { x: 3.5, y: 62.62, z: 0.5 }), false, "0.56 above a carpet top");
  assert.equal(heldByBlockAt(read, { x: 3.5, y: 62.0625, z: 0.5 }), true, "on the carpet itself");
});

test("a body with its centre over water is held when its footprint reaches a bank top; over water only it is not; an unloaded cell under the footprint is unknown", () => {
  const read = groundAt62({ 0: "stone", 1: "water", 2: "water" });
  assert.equal(heldByBlockAt(read, { x: 1.1, y: 63, z: 0.5 }), true, "x 0.8..1.4: the bank's cell is under the left edge");
  assert.equal(heldByBlockAt(read, { x: 1.9, y: 63, z: 0.5 }), false, "water only");
  assert.equal(heldByBlockAt(read, { x: 2.9, y: 63, z: 0.5 }), null, "x 3 is not loaded");
  assert.equal(heldByBlockAt(read, { x: -0.1, y: 63, z: 0.5 }), true, "a block under one edge holds her though x -1 is not loaded");
});

test("a floor lower than a tenth of a block holds her too: two layers of snow, a lily pad on water", () => {
  const { bot } = createFakeBot({
    groundY: 61,
    cells: { "0,62,0": "water", "0,63,0": { name: "snow", properties: { layers: 2 } }, "1,62,0": "water", "1,63,0": "lily_pad" },
  });
  const read = liveBlockReader(bot);
  assert.equal(heldByBlockAt(read, { x: 0.5, y: 63.125, z: 0.5 }), true, "snow, layers 2: top 0.125");
  assert.equal(heldByBlockAt(read, { x: 1.5, y: 63.09375, z: 0.5 }), true, "a lily pad: top 0.09375");
  assert.equal(heldByBlockAt(read, { x: 1.5, y: 63.6, z: 0.5 }), false, "0.5 above the pad");
});

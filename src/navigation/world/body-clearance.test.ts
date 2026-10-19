import assert from "node:assert/strict";
import test from "node:test";
import { partialCellAt, partialCellExit } from "./body-clearance.js";
import { MemoryWorld, type MemoryBlock } from "./memory-world.js";

const FLOOR_Y = 62;
const FEET_Y = 63;
/** Bamboo's 1.21.4 data box; placed at 191,292 it spans x 191.623..191.810, z 292.556..292.744 (offset +0.2167, +0.15). */
const BAMBOO: MemoryBlock = {
  stateId: 5,
  collisionShapes: [{ minX: 0.15625, minY: 0, minZ: 0.15625, maxX: 0.34375, maxY: 1, maxZ: 0.34375 }],
  horizontalOffset: 0.25,
};
const STONE: MemoryBlock = { stateId: 1 };
const AIR: MemoryBlock = { stateId: 0 };
/** Ayla's stop beside the stalk: flush with its placed box on x, the centre inside the stalk's cell. */
const AYLA = { x: 191.249, y: FEET_Y, z: 292.64375 };

/** A stone floor 7×7 around 191,292 with air above, and a two-high bamboo stalk at the middle. */
function grove(walled: readonly string[] = []) {
  const world = new MemoryWorld();
  for (let x = 188; x <= 194; x += 1)
    for (let z = 289; z <= 295; z += 1) {
      world.load({ x, y: FLOOR_Y, z }, STONE);
      for (let y = FEET_Y; y <= FEET_Y + 3; y += 1) world.load({ x, y, z }, AIR);
    }
  for (const y of [FEET_Y, FEET_Y + 1]) world.load({ x: 191, y, z: 292 }, BAMBOO);
  for (const side of walled) {
    const [x, z] = { west: [190, 292], east: [192, 292], north: [191, 291], south: [191, 293] }[side]!;
    for (const y of [FEET_Y, FEET_Y + 1]) world.load({ x: x!, y, z: z! }, STONE);
  }
  return world;
}

test("a body beside a stalk with its centre in the stalk's cell stands in a partial cell", () => {
  assert.deepEqual(partialCellAt(grove(), AYLA), { x: 191, y: FEET_Y, z: 292 });
});

test("the nearest clear side is the exit, here west", () => {
  assert.deepEqual(partialCellExit(grove(), AYLA), { x: 190, y: FEET_Y, z: 292 });
});

test("with west walled every other straight way out crosses the stalk", () => {
  assert.equal(partialCellExit(grove(["west"]), AYLA), null);
});

test("a body walled in on all four sides has no exit", () => {
  assert.equal(partialCellExit(grove(["west", "east", "north", "south"]), AYLA), null);
});

test("a stalk more than 0.3 from the body's square is not a partial cell", () => {
  assert.equal(partialCellAt(grove(), { x: 191.0, y: FEET_Y, z: 292.1 }), null);
  assert.equal(partialCellAt(grove(), { x: 190.5, y: FEET_Y, z: 292.5 }), null, "an ordinary free cell");
});

test("a box the body already overlaps does not block the way out", () => {
  // Inside the placed box on x: sweeping out of it, or on through it to a side, is allowed; only a new overlap is refused.
  const inside = { x: 191.7, y: FEET_Y, z: 292.65 };
  assert.deepEqual(partialCellExit(grove(), inside), { x: 192, y: FEET_Y, z: 292 });
  assert.deepEqual(partialCellExit(grove(["east"]), inside), { x: 191, y: FEET_Y, z: 293 });
});

test("an unloaded cell on the way is not clear", () => {
  const world = new MemoryWorld();
  world.load({ x: 191, y: FLOOR_Y, z: 292 }, STONE);
  for (const y of [FEET_Y, FEET_Y + 1]) world.load({ x: 191, y, z: 292 }, BAMBOO);
  assert.equal(partialCellExit(world, AYLA), null);
});

const BOTTOM_SLAB: MemoryBlock = { stateId: 2, collisionShapes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.5, maxZ: 1 }] };
const STAIR: MemoryBlock = {
  stateId: 3,
  collisionShapes: [
    { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.5, maxZ: 1 },
    { minX: 0.5, minY: 0.5, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
  ],
};
const BED: MemoryBlock = { stateId: 4, collisionShapes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.5625, maxZ: 1 }] };

function standingIn(block: MemoryBlock, traits: MemoryBlock["traits"] = {}) {
  const world = grove();
  world.load({ x: 191, y: FEET_Y, z: 292 }, { ...block, traits });
  world.load({ x: 191, y: FEET_Y + 1, z: 292 }, AIR);
  return world;
}

test("standing on a bottom slab, a stair's low step or a bed is standing on the block, not inside it", () => {
  assert.equal(partialCellAt(standingIn(BOTTOM_SLAB), { x: 191.5, y: FEET_Y + 0.5, z: 292.5 }), null, "slab");
  assert.equal(partialCellAt(standingIn(STAIR), { x: 191.25, y: FEET_Y + 0.5, z: 292.5 }), null, "stair low step");
  assert.equal(partialCellAt(standingIn(BED), { x: 191.5, y: FEET_Y + 0.5625, z: 292.5 }), null, "bed");
});

test("a cell the body passes through is never partial: carpet, snow layer, ladder, open door, water", () => {
  const carpet = { stateId: 6, collisionShapes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.0625, maxZ: 1 }] };
  const centre = { x: 191.5, y: FEET_Y, z: 292.5 };
  assert.equal(partialCellAt(standingIn(carpet), centre), null, "carpet or snow layer");
  assert.equal(partialCellAt(standingIn({ stateId: 7, collisionShapes: [] }, { climbable: true }), centre), null, "ladder");
  assert.equal(partialCellAt(standingIn({ stateId: 8, collisionShapes: [] }, { openable: true, open: true }), centre), null, "open door");
  assert.equal(partialCellAt(standingIn({ stateId: 9, collisionShapes: [] }, { liquid: "water", liquidSource: true }), centre), null, "water");
});

test("an unloaded feet cell is not a partial cell", () => {
  assert.equal(partialCellAt(new MemoryWorld(), AYLA), null);
});

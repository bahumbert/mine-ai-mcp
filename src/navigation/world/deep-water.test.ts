import assert from "node:assert/strict";
import test from "node:test";
import { feetAtSea, holdsWater, isDeepOpenWater, type WaterAt } from "./deep-water.js";
import { MemoryWorld } from "./memory-world.js";
import { UNLOADED } from "./world.js";

/** Water in a box (inclusive), nothing else. */
function box(min: [number, number, number], max: [number, number, number]): WaterAt {
  return (x, y, z) => x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2];
}

test("an ocean three deep and wider than eight blocks is deep open water, at the surface and below", () => {
  const ocean = box([-50, 50, -50], [50, 62, 50]);
  assert.equal(isDeepOpenWater(ocean, 0, 62, 0), true);
  assert.equal(isDeepOpenWater(ocean, 10, 55, -3), true);
});

test("shallow water is waded, a river is swum along or across: neither is deep open water", () => {
  assert.equal(isDeepOpenWater(box([-50, 61, -50], [50, 62, 50]), 0, 62, 0), false, "two deep");
  // A river eight wide, long along z.
  assert.equal(isDeepOpenWater(box([0, 55, -100], [7, 62, 100]), 3, 62, 0), false);
  assert.equal(isDeepOpenWater(box([0, 55, 0], [8, 62, 8]), 4, 62, 4), true, "nine by nine");
  assert.equal(isDeepOpenWater(box([0, 55, 0], [8, 62, 7]), 4, 62, 4), false, "nine by eight");
});

test("a cell that is not water is never deep water", () => {
  assert.equal(isDeepOpenWater(() => false, 0, 62, 0), false);
});

test("kelp, seagrass and waterlogged blocks hold the sea's water; dry blocks do not", () => {
  // Live 2026-10-04: kelp at the surface read as dry ground stopped a boat ride after two blocks.
  for (const name of ["water", "kelp", "kelp_plant", "seagrass", "tall_seagrass", "bubble_column"]) assert.equal(holdsWater(name), true, name);
  assert.equal(holdsWater("oak_stairs", { waterlogged: true }), true);
  assert.equal(holdsWater("oak_stairs", { waterlogged: false }), false);
  assert.equal(holdsWater("sand"), false);
});

const cellKinds = (() => {
  const world = new MemoryWorld();
  world.load({ x: 0, y: 0, z: 0 }, { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: true, safeToBreak: false } });
  world.load({ x: 1, y: 0, z: 0 }, { stateId: 1 });
  world.load({ x: 2, y: 0, z: 0 }, { stateId: 0 });
  return { water: world.blockAt(0, 0, 0), stone: world.blockAt(1, 0, 0), air: world.blockAt(2, 0, 0) };
})();

/** Water where `water` says, stone under y 50 elsewhere, air above; cells `unloaded` says are not loaded. */
function seaReader(water: WaterAt, unloaded: (x: number, z: number) => boolean = () => false) {
  return (x: number, y: number, z: number) =>
    unloaded(x, z) ? UNLOADED : water(x, y, z) ? cellKinds.water : y < 50 ? cellKinds.stone : cellKinds.air;
}

/** A sea 13 deep (y 50..62) with a shelf one deep (water at y 62 only) from x -4 to `shelfEnd`, z -4 to 4, round the start. */
function shelfSea(shelfEnd: number): WaterAt {
  const sea = box([-30, 50, -30], [30, 62, 30]);
  return (x, y, z) => sea(x, y, z) && (y === 62 || x < -4 || x > shelfEnd || Math.abs(z) > 4);
}

test("a sandbar start one deep, joined to deep open water within three water cells, is at sea", () => {
  assert.equal(feetAtSea(seaReader(shelfSea(0)), { x: 0, y: 62, z: 0 }), true);
  assert.equal(feetAtSea(seaReader(shelfSea(2)), { x: 0, y: 62, z: 0 }), true, "three cells along the shelf");
});

test("a wade four water cells from deep open water is not at sea, nor a pond two deep and five wide", () => {
  assert.equal(feetAtSea(seaReader(shelfSea(3)), { x: 0, y: 62, z: 0 }), false);
  assert.equal(feetAtSea(seaReader(box([-2, 61, -2], [2, 62, 2])), { x: 0, y: 62, z: 0 }), false);
});

test("water past a cell that is not loaded does not join the start to the sea", () => {
  assert.equal(feetAtSea(seaReader(shelfSea(0), (x) => x === 1), { x: 0, y: 62, z: 0 }), false);
});

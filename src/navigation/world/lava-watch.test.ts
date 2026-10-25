import assert from "node:assert/strict";
import test from "node:test";
import { flatWorld } from "../../test-support/navigation.js";
import { blockKey } from "./world.js";
import { lavaWatchCells } from "./lava-watch.js";

/** The flat world's feet cell is y 63 and its head cell y 64; lava is put by hand. */
const ARRIVAL = { x: 0, y: 63, z: 0 };

function withLava(at: { x: number; y: number; z: number }) {
  const world = flatWorld();
  world.load(at, { stateId: 10, collisionShapes: [], traits: { empty: true, liquid: "lava", liquidLevel: 8, damaging: true } });
  return world;
}

test("a route cell with no lava near it watches nothing", () => {
  assert.deepEqual(lavaWatchCells(flatWorld(), ARRIVAL), []);
});

test("lava within two cells, or falling from above, makes the cells lava could next flow into worth watching", () => {
  for (const lava of [{ x: 2, y: 63, z: 0 }, { x: 0, y: 64, z: -2 }, { x: 1, y: 66, z: 1 }]) {
    const keys = new Set(lavaWatchCells(withLava(lava), ARRIVAL).map(blockKey));
    for (const cell of [{ x: 1, y: 63, z: 0 }, { x: -1, y: 64, z: 0 }, { x: 0, y: 63, z: 1 }, { x: 0, y: 65, z: 0 }])
      assert.ok(keys.has(blockKey(cell)), `lava at ${JSON.stringify(lava)}: ${JSON.stringify(cell)}`);
  }
});

test("lava far from the cell, or under its floor, is not watched", () => {
  for (const lava of [{ x: 4, y: 63, z: 0 }, { x: 0, y: 59, z: 0 }]) assert.deepEqual(lavaWatchCells(withLava(lava), ARRIVAL), [], JSON.stringify(lava));
});

test("an unloaded neighbourhood watches nothing", () => {
  assert.deepEqual(lavaWatchCells(flatWorld(), { x: 100, y: 63, z: 100 }), []);
});

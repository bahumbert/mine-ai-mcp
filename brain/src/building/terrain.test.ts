import assert from "node:assert/strict";
import test from "node:test";
import type { BlockArea } from "../runtime-client.ts";
import { LEVEL_LIMITS, levelBox, levelPlan, type Zone } from "./terrain.ts";

const KINDS: BlockArea["kinds"] = {
  air: { tool: null, solid: false, harvest: null },
  water: { tool: null, solid: false, harvest: null },
  short_grass: { tool: null, solid: false, harvest: null },
  dirt: { tool: "shovel", solid: true, harvest: null },
  grass_block: { tool: "shovel", solid: true, harvest: null },
  stone: { tool: "pickaxe", solid: true, harvest: null },
  oak_log: { tool: "axe", solid: true, harvest: null, tags: ["logs"] },
  crimson_stem: { tool: "axe", solid: true, harvest: null, tags: ["logs"] },
  oak_planks: { tool: "axe", solid: true, harvest: null, tags: ["planks"] },
  oak_leaves: { tool: null, solid: true, harvest: null, tags: ["leaves"] },
  gold_block: { tool: "pickaxe", solid: true, harvest: null },
};

/** A world of flat dirt with its surface at y 63 (walking level 64), changed by `cells`; one column past the zone is read, as the brain reads it. */
function area(zone: Zone, level: number, cells: Record<string, string> = {}): BlockArea {
  const { min, max } = levelBox(zone, level);
  const blocks = new Map<string, string>();
  for (let x = min.x - 1; x <= max.x + 1; x += 1) for (let y = min.y; y <= max.y; y += 1) for (let z = min.z - 1; z <= max.z + 1; z += 1) {
    blocks.set(`${x},${y},${z}`, cells[`${x},${y},${z}`] ?? (y <= 63 ? "dirt" : "air"));
  }
  return { blocks, kinds: KINDS };
}

const ZONE = { minX: 0, maxX: 2, minZ: 0, maxZ: 1 };

test("flat ground at the level needs nothing", () => {
  const plan = levelPlan(ZONE, 64, area(ZONE, 64), "dirt");
  assert.deepEqual(plan, { batches: [], phases: { fillFirst: [], dig: [], fillAfter: [] }, filled: 0, dug: 0, pit: 0, support: 0, floating: false, tools: [] });
});

test("a hill is dug top layer first, with the tools its blocks need", () => {
  const plan = levelPlan(ZONE, 64, area(ZONE, 64, { "0,64,0": "grass_block", "0,65,0": "stone", "1,64,1": "oak_log" }), "dirt");
  assert.equal(plan.filled, 0);
  assert.deepEqual(plan.batches.map((batch) => batch.map(({ x, y, z, block }) => `${x},${y},${z} ${block}`)), [
    ["0,65,0 air"],
    ["0,64,0 air", "1,64,1 air"],
  ]);
  assert.deepEqual(plan.tools, ["axe", "pickaxe", "shovel"]);
});

test("a hole is filled bottom up to the first solid block, grass on it included, never deeper than the limit", () => {
  const plan = levelPlan(ZONE, 64, area(ZONE, 64, { "1,63,0": "short_grass", "1,62,0": "air", "2,63,1": "air", "2,62,1": "air", "2,61,1": "air", "2,60,1": "air" }), "dirt");
  const cells = plan.batches.flat();
  assert.deepEqual(cells.filter((cell) => cell.x === 1).map((cell) => cell.y), [62, 63]);
  // Four deep at most: 63, 62, 61, 60.
  assert.deepEqual(cells.filter((cell) => cell.x === 2).map((cell) => cell.y), [60, 61, 62, 63]);
  assert.equal(Math.min(...cells.map((cell) => cell.y)), 64 - LEVEL_LIMITS.below);
  assert.ok(cells.every((cell) => cell.block === "dirt"));
});

test("water above the level is filled before it is dug; holes and water below are filled after the dig, with its drops", () => {
  const plan = levelPlan(ZONE, 64, area(ZONE, 64, { "0,64,0": "water", "0,63,0": "water", "0,62,0": "stone" }), "dirt");
  const steps = plan.batches.flat().map(({ y, block }) => `${y} ${block}`);
  assert.deepEqual(steps, ["64 dirt", "64 air", "63 dirt"]);
  assert.deepEqual(plan.phases.fillAfter.flat().map(({ y }) => y), [63]);
  assert.deepEqual(plan.tools, ["shovel"]);
});

test("the players' markers are kept, and batches never exceed 256 cells", () => {
  const big = { minX: 0, maxX: 31, minZ: 0, maxZ: 31 };
  const cells: Record<string, string> = { "0,64,0": "gold_block", "31,64,31": "gold_block" };
  for (let x = 0; x < 32; x += 1) for (let z = 0; z < 32; z += 1) if (!cells[`${x},64,${z}`]) cells[`${x},64,${z}`] = "dirt";
  const plan = levelPlan(big, 64, area(big, 64, cells), "dirt", { keep: new Set(["0,64,0", "31,64,31"]) });
  assert.equal(plan.dug, 32 * 32 - 2);
  assert.ok(plan.batches.every((batch) => batch.length <= 256));
  assert.ok(!plan.batches.flat().some((cell) => (cell.x === 0 && cell.z === 0) || (cell.x === 31 && cell.z === 31)));
});

test("a house's site is filled one layer deep, and never where the house puts its own blocks", () => {
  const pond: Record<string, string> = {};
  for (let x = 0; x <= 2; x += 1) for (let z = 0; z <= 1; z += 1) for (let y = 60; y <= 63; y += 1) pond[`${x},${y},${z}`] = "water";
  const plan = levelPlan(ZONE, 64, area(ZONE, 64, pond), "dirt", { below: 1, placedLater: new Set(["1,63,0", "1,63,1"]) });
  const cells = plan.batches.flat();
  assert.ok(cells.every((cell) => cell.y === 63), "only the layer under the walking level");
  assert.equal(plan.filled, 6 - 2);
  assert.ok(!cells.some((cell) => cell.x === 1), "the house's own floor goes in itself");
});

test("water under the level is capped by its top cell, never filled under water; an air pocket over it is filled", () => {
  const plan = levelPlan(ZONE, 64, area(ZONE, 64, { "0,63,0": "water", "0,62,0": "water", "0,61,0": "water", "2,63,1": "air", "2,62,1": "water", "2,61,1": "water" }), "dirt");
  assert.deepEqual(plan.batches.flat().map(({ x, y, z }) => `${x},${y},${z}`), ["2,62,1", "0,63,0", "2,63,1"]);
});

/** A zone of columns with `cells` set: air everywhere in the layers of the level and above, `ground` below. */
function sky(zone: Zone, level: number, cells: Record<string, string> = {}, ground = 59): BlockArea {
  const { min, max } = levelBox(zone, level);
  const blocks = new Map<string, string>();
  for (let x = min.x - 1; x <= max.x + 1; x += 1) for (let y = ground - 2; y <= max.y; y += 1) for (let z = min.z - 1; z <= max.z + 1; z += 1) {
    blocks.set(`${x},${y},${z}`, cells[`${x},${y},${z}`] ?? (y <= ground ? "dirt" : "air"));
  }
  return { blocks, kinds: KINDS };
}

const FIVE = { minX: 0, maxX: 4, minZ: 0, maxZ: 4 };
const where = (cells: readonly { x: number; y: number; z: number }[]) => cells.map(({ x, y, z }) => `${x},${y},${z}`);

test("cutting a hill is no pit; a hole four deep all around is, and the pit note is its depth", () => {
  // A hill: 4 high in the middle, open to the level at its edges (every column of the edge dug 0 or 1 deep).
  const hill: Record<string, string> = {};
  for (let y = 64; y <= 67; y += 1) hill[`2,${y},2`] = "dirt";
  hill["0,64,0"] = "dirt";
  assert.equal(levelPlan(FIVE, 64, area(FIVE, 64, hill), "dirt").pit, 0);
  // A hillside: dug 4 deep on one side, open on the other.
  const slope: Record<string, string> = {};
  for (let x = 0; x <= 4; x += 1) for (let z = 0; z <= 4; z += 1) for (let y = 64; y < 64 + (4 - x); y += 1) slope[`${x},${y},${z}`] = "dirt";
  assert.equal(levelPlan(FIVE, 64, area(FIVE, 64, slope), "dirt").pit, 0);
  // A 4-deep hole: the ground at 63 and the level at 60, walls on every side.
  const hole = levelPlan(FIVE, 60, area(FIVE, 60), "dirt");
  assert.equal(hole.dug, 5 * 5 * 4);
  assert.equal(hole.pit, 4);
  // 3 deep is only a dig.
  assert.equal(levelPlan(FIVE, 61, area(FIVE, 61), "dirt").pit, 0);
});

test("a tree beside the zone is no pit wall: only the ground run up from the level counts", () => {
  // A flat level 64 ringed by trunks 5 high (a grove all around the zone): no pit.
  const grove: Record<string, string> = {};
  for (let x = -1; x <= 5; x += 1) for (let z = -1; z <= 5; z += 1) {
    if (x >= 0 && x <= 4 && z >= 0 && z <= 4) continue;
    for (let y = 64; y <= 68; y += 1) grove[`${x},${y},${z}`] = "oak_log";
  }
  assert.equal(levelPlan(FIVE, 64, area(FIVE, 64, grove), "dirt").pit, 0);
  // A 4-deep hole whose rim carries trunks: the pit is the ground, 4 deep, not the trunk on top.
  const rim: Record<string, string> = {};
  for (let x = -1; x <= 5; x += 1) for (let z = -1; z <= 5; z += 1) {
    if (x >= 0 && x <= 4 && z >= 0 && z <= 4) continue;
    for (let y = 64; y <= 68; y += 1) rim[`${x},${y},${z}`] = "oak_log";
  }
  assert.equal(levelPlan(FIVE, 60, area(FIVE, 60, rim), "dirt").pit, 4);
});

test("a pit beside a wooden house wall (planks) is told: only logs and leaves are a tree", () => {
  // A 4-deep hole whose west side is a planks wall (a house) and whose other sides are ground: still a pit, 4 deep.
  const house: Record<string, string> = {};
  for (let z = 0; z <= 4; z += 1) for (let y = 60; y <= 66; y += 1) house[`-1,${y},${z}`] = "oak_planks";
  assert.equal(levelPlan(FIVE, 60, area(FIVE, 60, house), "dirt").pit, 4);
});

test("a wall of logs, of nether stems or of leaves is a tree (by the game's tags), not a pit wall", () => {
  // West side only: logs up from the level (7 high) but the ground run on the other sides is 4: the run on the west ends at once, so no pit.
  for (const block of ["oak_log", "crimson_stem", "oak_leaves"]) {
    const wall: Record<string, string> = {};
    for (let z = 0; z <= 4; z += 1) for (let y = 60; y <= 66; y += 1) wall[`-1,${y},${z}`] = block;
    assert.equal(levelPlan(FIVE, 60, area(FIVE, 60, wall), "dirt").pit, 0, block);
  }
});

test("a platform in the air gets one support column from the ground under the cell nearest the middle, then fills outward from it", () => {
  // Ground at 59; the layer to fill (below 1 under the level 64) is y 63, air from 60 up, nothing solid beside it.
  const plan = levelPlan(FIVE, 64, sky(FIVE, 64), "dirt", { below: 1 });
  assert.equal(plan.floating, false);
  assert.equal(plan.support, 3);
  assert.equal(plan.filled, 25 + 3);
  const [column, ...layer] = plan.phases.fillAfter;
  assert.deepEqual(where(column!), ["2,60,2", "2,61,2", "2,62,2"], "the column, bottom up, in the middle");
  const cells = layer.flat();
  assert.equal(cells.length, 25);
  assert.equal(`${cells[0]!.x},${cells[0]!.y},${cells[0]!.z}`, "2,63,2", "the first cell of the layer sits on the column");
  // Every later cell touches an earlier one in its layer.
  const seen = new Set(["2,63,2"]);
  for (const cell of cells.slice(1)) {
    assert.ok([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => seen.has(`${cell.x + dx!},${cell.y},${cell.z + dz!}`)), `${where([cell])[0]} touches a placed cell`);
    seen.add(`${cell.x},${cell.y},${cell.z}`);
  }
});

test("a layer with no ground in the area is floating until the area reaches the ground", () => {
  const area60 = area(FIVE, 64, Object.fromEntries([60, 61, 62, 63].flatMap((y) => [-1, 0, 1, 2, 3, 4, 5].flatMap((x) => [-1, 0, 1, 2, 3, 4, 5].map((z) => [`${x},${y},${z}`, "air"])))));
  const plan = levelPlan(FIVE, 64, area60, "dirt", { below: 1 });
  assert.equal(plan.floating, true);
  assert.equal(plan.support, 0);
  assert.equal(levelPlan(FIVE, 64, sky(FIVE, 64), "dirt", { below: 1 }).floating, false);
});

test("a layer that touches a slope fills from that side", () => {
  // The east edge is a rise (solid at the layer's height, x 4); the rest of the layer is air over air.
  const cells: Record<string, string> = {};
  for (let x = -1; x <= 3; x += 1) for (let z = -1; z <= 5; z += 1) for (let y = 60; y <= 63; y += 1) cells[`${x},${y},${z}`] = "air";
  const plan = levelPlan(FIVE, 64, area(FIVE, 64, cells), "dirt", { below: 1 });
  assert.equal(plan.support, 0, "it touches solid ground: no column");
  assert.deepEqual(plan.phases.fillAfter.flat().map((cell) => cell.x), [3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
});

test("a layer over a pond fills outward from the shore, with no column under water", () => {
  // Water over the whole zone but a dirt ring cell at the east edge: shore at x 4.
  const cells: Record<string, string> = {};
  for (let x = -1; x <= 3; x += 1) for (let z = -1; z <= 5; z += 1) for (let y = 60; y <= 63; y += 1) cells[`${x},${y},${z}`] = "water";
  const plan = levelPlan(FIVE, 64, area(FIVE, 64, cells), "dirt", { below: 1 });
  assert.equal(plan.support, 0);
  assert.equal(plan.phases.fillAfter.flat()[0]!.x, 3);
});

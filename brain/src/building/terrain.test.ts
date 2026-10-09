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
  oak_log: { tool: "axe", solid: true, harvest: null },
  gold_block: { tool: "pickaxe", solid: true, harvest: null },
};

/** A world of flat dirt with its surface at y 63 (walking level 64), changed by `cells`. */
function area(zone: Zone, level: number, cells: Record<string, string> = {}): BlockArea {
  const { min, max } = levelBox(zone, level);
  const blocks = new Map<string, string>();
  for (let x = min.x; x <= max.x; x += 1) for (let y = min.y; y <= max.y; y += 1) for (let z = min.z; z <= max.z; z += 1) {
    blocks.set(`${x},${y},${z}`, cells[`${x},${y},${z}`] ?? (y <= 63 ? "dirt" : "air"));
  }
  return { blocks, kinds: KINDS };
}

const ZONE = { minX: 0, maxX: 2, minZ: 0, maxZ: 1 };

test("flat ground at the level needs nothing", () => {
  const plan = levelPlan(ZONE, 64, area(ZONE, 64), "dirt");
  assert.deepEqual(plan, { batches: [], phases: { fillFirst: [], dig: [], fillAfter: [] }, filled: 0, dug: 0, tools: [] });
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

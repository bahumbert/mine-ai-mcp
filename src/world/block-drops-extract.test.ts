import assert from "node:assert/strict";
import test from "node:test";
import { zip } from "../test-support/zip.js";
import { extractBlockDrops } from "./block-drops-extract.js";

const SILK = { condition: "minecraft:match_tool", predicate: { predicates: { "minecraft:enchantments": [{ enchantments: "minecraft:silk_touch", levels: { min: 1 } }] } } };
const SHEARS = { condition: "minecraft:match_tool", predicate: { items: "minecraft:shears" } };
const table = (block: string, pools: unknown[]) => ({ [`data/minecraft/loot_table/blocks/${block}.json`]: JSON.stringify({ type: "minecraft:block", pools }) });
const item = (name: string, conditions: unknown[] = []) => ({ type: "minecraft:item", name: `minecraft:${name}`, ...(conditions.length > 0 && { conditions }) });
const alternatives = (children: unknown[], conditions: unknown[] = []) => ({ type: "minecraft:alternatives", children, ...(conditions.length > 0 && { conditions }) });

// Trimmed from the 1.21.4 server jar's own loot tables.
const JAR = zip({
  ...table("short_grass", [{ rolls: 1, entries: [alternatives([item("short_grass", [SHEARS]), item("wheat_seeds", [{ condition: "minecraft:random_chance", chance: 0.125 }])])] }]),
  ...table("wheat", [
    { rolls: 1, entries: [alternatives([item("wheat", [{ condition: "minecraft:block_state_property", block: "minecraft:wheat", properties: { age: "7" } }]), item("wheat_seeds")])] },
    { rolls: 1, conditions: [{ condition: "minecraft:block_state_property", block: "minecraft:wheat", properties: { age: "7" } }], entries: [item("wheat_seeds")] },
  ]),
  ...table("stone", [{ rolls: 1, entries: [alternatives([item("stone", [SILK]), item("cobblestone", [{ condition: "minecraft:survives_explosion" }])])] }]),
  ...table("cobweb", [{ rolls: 1, entries: [alternatives([item("cobweb", [{ condition: "minecraft:any_of", terms: [SHEARS, SILK] }]), item("string")])] }]),
  ...table("oak_leaves", [
    { rolls: 1, entries: [alternatives([item("oak_leaves", [{ condition: "minecraft:any_of", terms: [SHEARS, SILK] }]), item("oak_sapling", [{ condition: "minecraft:table_bonus", chances: [0.05, 0.0625] }])])] },
    { rolls: 1, conditions: [{ condition: "minecraft:inverted", term: { condition: "minecraft:any_of", terms: [SHEARS, SILK] } }], entries: [item("stick", [{ condition: "minecraft:table_bonus", chances: [0.02, 0.0222] }])] },
  ]),
  ...table("gravel", [{ rolls: 1, entries: [alternatives([item("gravel", [SILK]), alternatives([item("flint", [{ condition: "minecraft:table_bonus", chances: [0.1, 0.14] }]), item("gravel")], [{ condition: "minecraft:survives_explosion" }])])] }]),
  ...table("air", []),
  "data/minecraft/loot_table/entities/zombie.json": JSON.stringify({ type: "minecraft:entity", pools: [] }),
});

test("block loot tables become each block's drops in loot order, with chance, tool and state", () => {
  const drops = extractBlockDrops(JAR);
  assert.deepEqual(drops.short_grass, [
    { item: "short_grass", chance: 1, tool: "shears" },
    { item: "wheat_seeds", chance: 0.125 },
  ]);
  assert.deepEqual(drops.wheat, [
    { item: "wheat", chance: 1, state: { age: "7" } },
    { item: "wheat_seeds", chance: 1 },
    { item: "wheat_seeds", chance: 1, state: { age: "7" } },
  ]);
  assert.deepEqual(drops.stone, [{ item: "stone", chance: 1, tool: "silk_touch" }, { item: "cobblestone", chance: 1 }]);
  assert.deepEqual(drops.cobweb, [{ item: "cobweb", chance: 1, tool: "shears or silk_touch" }, { item: "string", chance: 1 }]);
});

test("table bonus counts at no fortune, an inverted tool condition is an ordinary break, and nested alternatives flatten", () => {
  const drops = extractBlockDrops(JAR);
  assert.deepEqual(drops.oak_leaves, [
    { item: "oak_leaves", chance: 1, tool: "shears or silk_touch" },
    { item: "oak_sapling", chance: 0.05 },
    { item: "stick", chance: 0.02 },
  ]);
  assert.deepEqual(drops.gravel, [
    { item: "gravel", chance: 1, tool: "silk_touch" },
    { item: "flint", chance: 0.1 },
    { item: "gravel", chance: 1 },
  ]);
});

test("a block with an empty table drops nothing, and entity tables are not blocks", () => {
  const drops = extractBlockDrops(JAR);
  assert.deepEqual(drops.air, []);
  assert.equal(drops.zombie, undefined);
  assert.deepEqual(Object.keys(drops), Object.keys(drops).toSorted());
});

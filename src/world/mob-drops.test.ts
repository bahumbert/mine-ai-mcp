import assert from "node:assert/strict";
import test from "node:test";
import { zip } from "../test-support/zip.js";
import { mobSourcesOf } from "./mob-drops.js";
import { extractMobDrops } from "./mob-drops-extract.js";

const entity = (path: string, items: readonly string[]) => ({
  [`data/minecraft/loot_table/entities/${path}.json`]: JSON.stringify({
    type: "minecraft:entity",
    pools: items.map((name) => ({ rolls: 1, conditions: [{ condition: "minecraft:killed_by_player" }], entries: [{ type: "minecraft:item", name: `minecraft:${name}` }] })),
  }),
});

test("entity loot tables become each mob's drops; a variant's own table (a sheep's wool) counts for its mob", () => {
  const mobs = extractMobDrops(zip({
    ...entity("cow", ["beef", "leather"]),
    ...entity("sheep", ["mutton"]),
    ...entity("sheep/white", ["white_wool"]),
    ...entity("allay", []),
    "data/minecraft/loot_table/blocks/stone.json": JSON.stringify({ type: "minecraft:block", pools: [] }),
  }));
  assert.deepEqual(mobs, {
    cow: [{ item: "beef", chance: 1 }, { item: "leather", chance: 1 }],
    sheep: [{ item: "mutton", chance: 1 }, { item: "white_wool", chance: 1 }],
  });
});

test("the shipped data names the mobs an item is hunted from, likeliest first", () => {
  assert.deepEqual(mobSourcesOf("white_wool", "1.21.4"), [{ mob: "sheep", chance: 1 }]);
  assert.ok(mobSourcesOf("beef", "1.21.4").some((source) => source.mob === "cow"));
  assert.deepEqual(mobSourcesOf("oak_log", "1.21.4"), []);
});

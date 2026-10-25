import assert from "node:assert/strict";
import test from "node:test";
import { zip } from "../test-support/zip.js";
import { spawnsIn } from "./mob-spawns.js";
import { extractMobSpawns } from "./mob-spawns-extract.js";

const biome = (name: string, spawners: Readonly<Record<string, readonly string[]>>) => ({
  [`data/minecraft/worldgen/biome/${name}.json`]: JSON.stringify({
    spawners: Object.fromEntries(Object.entries(spawners).map(([category, mobs]) => [category, mobs.map((type) => ({ type: `minecraft:${type}`, weight: 1, minCount: 1, maxCount: 2 }))])),
  }),
});

test("every biome's spawner lists, all categories together, become that biome's mobs", () => {
  const biomes = extractMobSpawns(zip({
    ...biome("plains", { creature: ["pig", "cow"], monster: ["zombie", "pig"], ambient: [] }),
    ...biome("crimson_forest", { monster: ["hoglin"] }),
    ...biome("the_void", {}),
    "data/minecraft/worldgen/configured_feature/oak.json": "{}",
  }));
  assert.deepEqual(biomes, { crimson_forest: ["hoglin"], plains: ["cow", "pig", "zombie"] });
});

test("a mob spawns in a dimension when one of that dimension's biomes lists it", () => {
  assert.equal(spawnsIn("pig", "overworld", "1.21.4"), true);
  assert.equal(spawnsIn("hoglin", "overworld", "1.21.4"), false);
  assert.equal(spawnsIn("hoglin", "the_nether", "1.21.4"), true);
  assert.equal(spawnsIn("pig", "minecraft:the_nether", "1.21.4"), false);
  assert.equal(spawnsIn("enderman", "the_end", "1.21.4"), true);
});

test("no shipped data for the version, or an unknown dimension, says it does not spawn", () => {
  assert.equal(spawnsIn("pig", "overworld", "1.8"), false);
  assert.equal(spawnsIn("pig", undefined, "1.21.4"), false);
});

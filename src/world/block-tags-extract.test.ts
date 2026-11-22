import assert from "node:assert/strict";
import test from "node:test";
import { zip } from "../test-support/zip.js";
import { extractBlockTags, extractTags } from "./block-tags-extract.js";

const tag = (name: string, values: unknown[]) => ({ [`data/minecraft/tags/block/${name}.json`]: JSON.stringify({ values }) });

// Trimmed from the 1.21.4 server jar's own block tags.
const JAR = zip({
  ...tag("oak_logs", ["minecraft:oak_log", "minecraft:oak_wood", "minecraft:stripped_oak_log"]),
  ...tag("crimson_stems", ["minecraft:crimson_stem", "minecraft:stripped_crimson_stem"]),
  ...tag("logs_that_burn", ["#minecraft:oak_logs"]),
  ...tag("logs", ["#minecraft:logs_that_burn", "#minecraft:crimson_stems"]),
  ...tag("mineable/axe", ["#minecraft:logs", "minecraft:pumpkin", { id: "minecraft:modded_block", required: false }]),
  ...tag("loop_a", ["#minecraft:loop_b", "minecraft:stone"]),
  ...tag("loop_b", ["#minecraft:loop_a"]),
  "data/minecraft/tags/item/logs.json": JSON.stringify({ values: ["minecraft:oak_log"] }),
}, ["data/minecraft/tags/block/logs.json"]);

test("block tags resolve nested tags into sorted block ids, item tags left out", () => {
  const tags = extractBlockTags(JAR);
  assert.deepEqual(tags.logs, ["crimson_stem", "oak_log", "oak_wood", "stripped_crimson_stem", "stripped_oak_log"]);
  assert.deepEqual(tags["mineable/axe"], ["crimson_stem", "modded_block", "oak_log", "oak_wood", "pumpkin", "stripped_crimson_stem", "stripped_oak_log"]);
  assert.deepEqual(Object.keys(tags), ["crimson_stems", "logs", "logs_that_burn", "loop_a", "loop_b", "mineable/axe", "oak_logs"]);
});

test("a tag that includes itself through another ends instead of looping", () => {
  const tags = extractBlockTags(JAR);
  assert.deepEqual(tags.loop_a, ["stone"]);
  assert.deepEqual(tags.loop_b, ["stone"]);
});

test("the same extraction reads the item tags of the jar, block tags left out", () => {
  const tags = extractTags(JAR, "item");
  assert.deepEqual(tags, { logs: ["oak_log"] });
});

test("the entity_type kind reads data/minecraft/tags/entity_type/, nested tags resolved", () => {
  const jar = zip({
    "data/minecraft/tags/entity_type/arrows.json": JSON.stringify({ values: ["minecraft:arrow", "minecraft:spectral_arrow"] }),
    "data/minecraft/tags/entity_type/impact_projectiles.json": JSON.stringify({ values: ["#minecraft:arrows", "minecraft:snowball"] }),
    "data/minecraft/tags/item/arrows.json": JSON.stringify({ values: ["minecraft:arrow"] }),
  });
  assert.deepEqual(extractTags(jar, "entity_type"), {
    arrows: ["arrow", "spectral_arrow"],
    impact_projectiles: ["arrow", "snowball", "spectral_arrow"],
  });
});

test("plural folder jars (1.19.4 to 1.20.6: tags/items, tags/blocks, tags/entity_types) extract like singular ones", () => {
  const jar = zip({
    "data/minecraft/tags/items/arrows.json": JSON.stringify({ values: ["minecraft:arrow", "minecraft:tipped_arrow"] }),
    "data/minecraft/tags/items/planks.json": JSON.stringify({ values: ["minecraft:oak_planks"] }),
    "data/minecraft/tags/blocks/logs.json": JSON.stringify({ values: ["minecraft:oak_log"] }),
    "data/minecraft/tags/entity_types/arrows.json": JSON.stringify({ values: ["minecraft:arrow"] }),
  });
  assert.deepEqual(extractTags(jar, "item"), { arrows: ["arrow", "tipped_arrow"], planks: ["oak_planks"] });
  assert.deepEqual(extractTags(jar, "block"), { logs: ["oak_log"] });
  assert.deepEqual(extractTags(jar, "entity_type"), { arrows: ["arrow"] });
});

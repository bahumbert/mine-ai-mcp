import assert from "node:assert/strict";
import test from "node:test";
import { zip } from "../test-support/zip.js";
import { extractBlockTags } from "./block-tags-extract.js";

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

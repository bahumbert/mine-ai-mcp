import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import { formatViewBlockDropsResult, parseViewBlockDropsRequest, viewBlockDrops } from "./index.js";

function bot(version: string): Pick<Bot, "registry" | "version"> {
  return { version, registry: minecraftData("1.21.4") as unknown as Bot["registry"] };
}

test("items list the blocks an ordinary break gathers them from; blocks list everything they drop", async () => {
  const result = await viewBlockDrops(bot("1.21.4"), parseViewBlockDropsRequest({ items: ["raw_iron", "wheat_seeds"], blocks: ["wheat"] }), {});
  assert.equal(result.status, "succeeded");
  assert.equal(result.drops.dataVersion, "1.21.4");
  assert.deepEqual(result.drops.items.find((entry) => entry.item === "raw_iron")?.sources.map((source) => source.block).toSorted(), ["deepslate_iron_ore", "iron_ore"]);
  const seeds = result.drops.items.find((entry) => entry.item === "wheat_seeds")!.sources;
  assert.deepEqual(seeds[0], { block: seeds[0]!.block, chance: 0.125, planted: false });
  assert.deepEqual(seeds.at(-1), { block: "wheat", chance: 1, planted: true });
  assert.deepEqual(result.drops.blocks, [{
    block: "wheat",
    drops: [
      { item: "wheat", chance: 1, state: { age: "7" } },
      { item: "wheat_seeds", chance: 1 },
      { item: "wheat_seeds", chance: 1, state: { age: "7" } },
    ],
  }]);
  const text = formatViewBlockDropsResult(result);
  assert.match(text, /raw_iron: from (deepslate_iron_ore|iron_ore)/u);
  assert.match(text, /wheat: wheat when age=7; wheat_seeds; wheat_seeds when age=7/u);
  assert.match(text, /wheat \(planted crop\)/u);
});

test("items also list the mobs that drop them, hostile ones marked", async () => {
  // Live 2026-10-04: with block loot tables only, a bed's wool was planned from string, never from sheep.
  const result = await viewBlockDrops(bot("1.21.4"), parseViewBlockDropsRequest({ items: ["white_wool", "beef", "string"] }), {});
  const mobs = (item: string) => result.drops.items.find((entry) => entry.item === item)!.mobs;
  assert.deepEqual(mobs("white_wool"), [{ mob: "sheep", chance: 1, hostile: false }]);
  assert.ok(mobs("beef").some((source) => source.mob === "cow" && !source.hostile));
  assert.ok(mobs("string").some((source) => source.mob === "spider" && source.hostile));
  assert.match(formatViewBlockDropsResult(result), /white_wool: from white_wool; hunted from sheep/u);
});

test("at least one item or block is asked; unknown names and versions without data are reported", async () => {
  assert.throws(() => parseViewBlockDropsRequest({}), /items or blocks/u);
  const unknown = await viewBlockDrops(bot("1.21.4"), parseViewBlockDropsRequest({ items: ["moon_rock"], blocks: ["stone", "moon_block"] }), {});
  assert.equal(unknown.status, "failed");
  assert.match(unknown.error ?? "", /^\[UNKNOWN_DROP_NAMES\] .*moon_rock, moon_block/u);
  assert.deepEqual(unknown.drops.blocks.map(({ block }) => block), ["stone"]);

  const older = await viewBlockDrops(bot("1.20.1"), parseViewBlockDropsRequest({ items: ["raw_iron"] }), {});
  assert.equal(older.status, "failed");
  assert.match(older.error ?? "", /^\[DROP_DATA_UNAVAILABLE\]/u);
});

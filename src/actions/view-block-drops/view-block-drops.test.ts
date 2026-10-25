import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { formatViewBlockDropsResult, parseViewBlockDropsRequest, viewBlockDrops } from "./index.js";

/** A bot on 1.21.4's registry that reports `version` as its server's, in `dimension`, with the `loaded` mobs around it. */
function bot(version: string, dimension = "overworld", loaded: readonly string[] = []) {
  const entities = Object.fromEntries(loaded.map((name, index) => [index + 2, { name, position: new Vec3(index + 3, 64, 0) }]));
  const { bot } = createFakeBot({ version: "1.21.4", dimension, entities });
  bot.version = version;
  return bot;
}

test("items list the blocks an ordinary break gathers them from; blocks list everything they drop", async () => {
  const result = await viewBlockDrops(bot("1.21.4"), parseViewBlockDropsRequest({ items: ["raw_iron", "wheat_seeds"], blocks: ["wheat"] }), {});
  assert.equal(result.status, "succeeded");
  assert.equal(result.drops.dataVersion, "1.21.4");
  assert.deepEqual(result.drops.items.find((entry) => entry.item === "raw_iron")?.sources.map((source) => source.block).toSorted(), ["deepslate_iron_ore", "iron_ore"]);
  const seeds = result.drops.items.find((entry) => entry.item === "wheat_seeds")!.sources;
  assert.deepEqual(seeds[0], { block: seeds[0]!.block, chance: 0.125, planted: false });
  assert.deepEqual(seeds.at(-1), { block: "wheat", chance: 1, planted: true, seed: "wheat_seeds" });
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
  assert.match(text, /wheat \(planted crop, from wheat_seeds\)/u);
});

test("a planted source names the item the crop is planted from, a wild one names none", async () => {
  const result = await viewBlockDrops(bot("1.21.4"), parseViewBlockDropsRequest({ items: ["wheat", "wheat_seeds", "carrot", "beetroot"] }), {});
  const sources = (item: string) => result.drops.items.find((entry) => entry.item === item)!.sources;
  assert.deepEqual(sources("wheat").filter((source) => source.planted).map(({ block, seed }) => ({ block, seed })), [{ block: "wheat", seed: "wheat_seeds" }]);
  assert.ok(sources("wheat_seeds").filter((source) => !source.planted).every((source) => !("seed" in source)));
  assert.equal(sources("wheat_seeds").find((source) => source.block === "wheat")?.seed, "wheat_seeds");
  assert.equal(sources("carrot").find((source) => source.block === "carrots")?.seed, "carrot");
  assert.equal(sources("beetroot").find((source) => source.block === "beetroots")?.seed, "beetroot_seeds");
});

test("items also list the mobs that drop them, hostile ones marked", async () => {
  // Live 2026-10-04: with block loot tables only, a bed's wool was planned from string, never from sheep.
  const result = await viewBlockDrops(bot("1.21.4"), parseViewBlockDropsRequest({ items: ["white_wool", "beef", "string"] }), {});
  const mobs = (item: string) => result.drops.items.find((entry) => entry.item === item)!.mobs;
  assert.deepEqual(mobs("white_wool"), [{ mob: "sheep", chance: 1, hostile: false, spawnsInDimension: true, loaded: 0 }]);
  assert.ok(mobs("beef").some((source) => source.mob === "cow" && !source.hostile));
  assert.ok(mobs("string").some((source) => source.mob === "spider" && source.hostile));
  assert.match(formatViewBlockDropsResult(result), /white_wool: from white_wool; hunted from sheep/u);
});

test("mob sources are ordered by loaded, then spawning in the bot's dimension, with hostile from the hunt category", async () => {
  const request = parseViewBlockDropsRequest({ items: ["porkchop"] });
  const mobs = async (dimension: string, loaded: readonly string[] = []) =>
    (await viewBlockDrops(bot("1.21.4", dimension, loaded), request, {})).drops.items[0]!.mobs;
  assert.equal((await mobs("overworld"))[0]!.mob, "pig");
  assert.equal((await mobs("the_nether"))[0]!.mob, "hoglin");
  assert.equal((await mobs("overworld", ["hoglin", "hoglin"]))[0]!.mob, "hoglin");
  assert.equal((await mobs("overworld", ["hoglin", "hoglin"]))[0]!.loaded, 2);
  const hoglin = (await mobs("overworld")).find((source) => source.mob === "hoglin")!;
  assert.deepEqual({ hostile: hoglin.hostile, spawnsInDimension: hoglin.spawnsInDimension }, { hostile: true, spawnsInDimension: false });
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

test("the text names the loaded count and a source that does not spawn in this dimension", async () => {
  const result = await viewBlockDrops(bot("1.21.4", "overworld", ["hoglin"]), parseViewBlockDropsRequest({ items: ["porkchop"] }), {});
  assert.match(formatViewBlockDropsResult(result), /hunted from hoglin \(hostile\) \(1 loaded nearby\), pig/u);
  const quiet = await viewBlockDrops(bot("1.21.4"), parseViewBlockDropsRequest({ items: ["porkchop"] }), {});
  assert.match(formatViewBlockDropsResult(quiet), /pig, hoglin \(hostile\) \(does not spawn in this dimension\)/u);
});

test("an unknown item that is a mob is answered with its drops", async () => {
  const unknown = await viewBlockDrops(bot("1.21.4"), parseViewBlockDropsRequest({ items: ["cow", "raw_beef"] }), {});
  assert.equal(unknown.status, "failed");
  assert.match(unknown.error ?? "", /cow is a mob, not an item: it drops beef, leather \(get_items beef hunts it\), raw_beef \(closest: beef, cooked_beef\)/u);
});

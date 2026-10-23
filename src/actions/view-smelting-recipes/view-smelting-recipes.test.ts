import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { formatViewSmeltingRecipesResult, parseViewSmeltingRecipesRequest, viewSmeltingRecipes } from "./index.js";

/** A bot on 1.21.4's registry that reports `version` as its server's. */
function bot(version: string) {
  const { bot } = createFakeBot({ version: "1.21.4" });
  bot.version = version;
  return bot;
}

test("furnace recipes come from the version's data, with every fuel and its worth", async () => {
  const result = await viewSmeltingRecipes(bot("1.21.4"), parseViewSmeltingRecipesRequest({ items: ["glass", "oak_planks", "glass"] }), {});
  assert.equal(result.status, "succeeded");
  assert.equal(result.smelting.dataVersion, "1.21.4");
  assert.deepEqual(result.smelting.items, [
    { item: "glass", recipes: [{ output: "glass", count: 1, inputs: ["sand", "red_sand"], cookingTicks: 200 }] },
    { item: "oak_planks", recipes: [] },
  ]);
  const fuel = (item: string) => result.smelting.fuels.find((entry) => entry.item === item)?.itemsSmelted;
  assert.equal(fuel("coal"), 8);
  assert.equal(fuel("spruce_planks"), 1.5);
  assert.equal(fuel("crimson_planks"), undefined);
  assert.match(formatViewSmeltingRecipesResult(result), /glass: one of sand, red_sand → 1 \(200 ticks\)/u);
  assert.match(formatViewSmeltingRecipesResult(result), /oak_planks: no furnace recipe/u);
});

test("a newer server uses the nearest older data; unknown items and versions without data are reported", async () => {
  const newer = await viewSmeltingRecipes(bot("1.21.8"), parseViewSmeltingRecipesRequest({ items: ["glass"] }), {});
  assert.equal(newer.status, "succeeded");
  assert.equal(newer.smelting.dataVersion, "1.21.4");

  const unknown = await viewSmeltingRecipes(bot("1.21.4"), parseViewSmeltingRecipesRequest({ items: ["glass", "moon_rock"] }), {});
  assert.equal(unknown.status, "failed");
  assert.match(unknown.error ?? "", /^\[UNKNOWN_SMELT_ITEMS\] .*moon_rock/u);
  assert.deepEqual(unknown.smelting.items.map(({ item }) => item), ["glass"]);

  const older = await viewSmeltingRecipes(bot("1.20.1"), parseViewSmeltingRecipesRequest({ items: ["glass"] }), {});
  assert.equal(older.status, "failed");
  assert.match(older.error ?? "", /^\[SMELTING_DATA_UNAVAILABLE\]/u);
});

test("the fuels line names each worth once with a few examples, and the lava bucket is among them", async () => {
  const result = await viewSmeltingRecipes(bot("1.21.4"), parseViewSmeltingRecipesRequest({ items: ["glass"] }), {});
  assert.ok(result.smelting.fuels.length > 100, "the evidence keeps every fuel item for the brain's choice");
  const line = formatViewSmeltingRecipesResult(result).split("\n").find((entry) => entry.startsWith("- Fuels"))!;
  assert.ok(line.length < 700, `${line.length} characters: ${line}`);
  assert.match(line, /100: lava_bucket/u);
  assert.match(line, /8: .*coal/u);
  assert.match(line, /and \d+ more/u);
  assert.doesNotMatch(line, /crimson_planks/u);
});

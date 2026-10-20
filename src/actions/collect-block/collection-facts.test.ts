import assert from "node:assert/strict";
import { test } from "node:test";
import { botFixture, registry } from "../../test-support/bot.js";

import { tagsOf } from "../../world/block-tags.js";
import { blockMatchesSelector, expectedDropName, inventoryCounts, inventoryGains, selectorKnown } from "./collection-facts.js";

function factsBot(
  items: Array<{ name: string; count: number; type: number }> = [],
  heldItem: { enchants: Array<{ name: string; lvl: number }> } | null = null,
) {
  // The version selects the shipped loot tables (src/world/block-drops.ts); the fixture's registry is 1.21.4.
  return Object.assign(botFixture({ items }, { heldItem }), { version: "1.21.4" });
}

test("a block name selects itself, and an ore also its deepslate twin", () => {
  const bot = factsBot();
  assert.equal(blockMatchesSelector("oak_log", "oak_log", bot), true);
  assert.equal(blockMatchesSelector("stripped_oak_log", "oak_log", bot), false);
  assert.equal(blockMatchesSelector("deepslate_iron_ore", "iron_ore", bot), true);
  assert.equal(blockMatchesSelector("deepslate", "stone", bot), false);
});

test("the tag logs selects the game's natural logs: no stripped log, no wood block, no stem", () => {
  const bot = factsBot();
  const natural = Object.keys(registry.blocksByName).filter((name) => tagsOf(name, "1.21.4").includes("overworld_natural_logs"));
  assert.ok(natural.includes("oak_log") && natural.includes("mangrove_log"));
  const selected = Object.keys(registry.blocksByName).filter((name) => blockMatchesSelector(name, "logs", bot));
  assert.deepEqual(selected.sort(), natural.sort());
  for (const name of ["stripped_oak_log", "oak_wood", "crimson_stem"]) assert.equal(blockMatchesSelector(name, "logs", bot), false);
});

test("any other game tag selects its members: the tag name is the selector", () => {
  const bot = factsBot();
  const members = Object.keys(registry.blocksByName).filter((name) => tagsOf(name, "1.21.4").includes("wool"));
  assert.ok(members.length > 10);
  assert.deepEqual(
    Object.keys(registry.blocksByName).filter((name) => blockMatchesSelector(name, "wool", bot)),
    members,
  );
});

test("a block name that is also a tag name selects only that block", () => {
  const bot = factsBot();
  assert.ok(Object.keys(registry.blocksByName).some((name) => tagsOf(name, "1.21.4").includes("dirt")));
  assert.equal(blockMatchesSelector("dirt", "dirt", bot), true);
  assert.equal(blockMatchesSelector("podzol", "dirt", bot), false);
  assert.equal(blockMatchesSelector("grass_block", "dirt", bot), false);
});

test("the singular log selects nothing: it is no block and no tag", () => {
  const bot = factsBot();
  assert.equal(Object.keys(registry.blocksByName).some((name) => blockMatchesSelector(name, "log", bot)), false);
  assert.equal(selectorKnown(bot, "log"), false);
  assert.equal(selectorKnown(bot, "logs"), true);
  assert.equal(selectorKnown(bot, "oak_log"), true);
  assert.equal(selectorKnown(bot, "mineable/pickaxe"), true);
});

test("a version with no shipped tags matches exact names only", () => {
  const bot = Object.assign(factsBot(), { version: "1.19.4" });
  assert.equal(blockMatchesSelector("oak_log", "logs", bot), false);
  assert.equal(selectorKnown(bot, "logs"), false);
  assert.equal(blockMatchesSelector("oak_log", "oak_log", bot), true);
});

test("chooses the equipped tool's drop: cobblestone, or stone with silk touch; seeds from grass, string from cobweb", () => {
  assert.equal(expectedDropName(factsBot(), "stone"), "cobblestone");
  assert.equal(expectedDropName(factsBot(), "clay"), "clay_ball");
  assert.equal(expectedDropName(factsBot([], { enchants: [{ name: "silk_touch", lvl: 1 }] }), "stone"), "stone");
  assert.equal(expectedDropName(factsBot(), "short_grass"), "wheat_seeds");
  assert.equal(expectedDropName(factsBot(), "cobweb"), "string");
});

test("reads the version's own loot tables: the likeliest ordinary drop, grass under its 1.21 names", () => {
  assert.equal(expectedDropName(factsBot(), "gravel"), "gravel");
  assert.equal(expectedDropName(factsBot(), "oak_leaves"), "oak_sapling");
  assert.equal(expectedDropName(factsBot(), "large_fern"), "wheat_seeds");
  assert.equal(expectedDropName(factsBot(), "pitcher_crop"), "pitcher_pod");
  assert.equal(expectedDropName(factsBot([], { enchants: [{ name: "silk_touch", lvl: 1 }] }), "iron_ore"), "iron_ore");
  assert.equal(expectedDropName(factsBot(), "iron_ore"), "raw_iron");
});

test("adds only Collect's before-and-after interpretation to Mineflayer inventory facts", () => {
  const items = [
    { name: "oak_log", count: 2, type: registry.itemsByName.oak_log.id },
    { name: "oak_log", count: 3, type: registry.itemsByName.oak_log.id },
    { name: "dirt", count: 4, type: registry.itemsByName.dirt.id },
  ];
  const bot = factsBot(items);

  assert.deepEqual(inventoryCounts(bot), { oak_log: 5, dirt: 4 });
  assert.deepEqual(inventoryGains(bot, { oak_log: 1, dirt: 8 }, ["dirt", "oak_log", "oak_log"]), { oak_log: 4 });
});

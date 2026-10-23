import assert from "node:assert/strict";
import { test } from "node:test";
import { type FakeBotOptions, createFakeBot } from "../../test-support/fake-bot/index.js";

import { tagsOf } from "../../world/block-tags.js";
import { blockMatchesSelector, expectedDropName, inventoryCounts, inventoryGains, selectorKnown } from "./collection-facts.js";

const { registry } = createFakeBot().bot;

/** A bot on the runtime's default version (1.21.4), whose shipped loot tables and tags the facts read (src/world/block-drops.ts). */
function factsBot(options: FakeBotOptions = {}) {
  return createFakeBot(options).bot;
}

/** A bot holding a pickaxe enchanted with silk touch, in the 1.21 component shape the server sends (`item.enchants` returns it raw). */
function silkTouchBot() {
  const bot = factsBot({ slots: { 36: { name: "diamond_pickaxe" } } });
  const pickaxe = bot.heldItem!;
  (pickaxe as typeof pickaxe & { componentMap: Map<string, unknown> }).componentMap.set("enchantments", {
    type: "enchantments",
    data: { enchantments: [{ id: registry.enchantmentsByName.silk_touch!.id, level: 1 }] },
  });
  return bot;
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
  const bot = factsBot({ version: "1.19.4" });
  assert.equal(blockMatchesSelector("oak_log", "logs", bot), false);
  assert.equal(selectorKnown(bot, "logs"), false);
  assert.equal(blockMatchesSelector("oak_log", "oak_log", bot), true);
});

test("chooses the equipped tool's drop: cobblestone, or stone with silk touch; seeds from grass, string from cobweb", () => {
  assert.equal(expectedDropName(factsBot(), "stone"), "cobblestone");
  assert.equal(expectedDropName(factsBot(), "clay"), "clay_ball");
  assert.equal(expectedDropName(silkTouchBot(), "stone"), "stone");
  assert.equal(expectedDropName(factsBot(), "short_grass"), "wheat_seeds");
  assert.equal(expectedDropName(factsBot(), "cobweb"), "string");
});

test("reads the version's own loot tables: the likeliest ordinary drop, grass under its 1.21 names", () => {
  assert.equal(expectedDropName(factsBot(), "gravel"), "gravel");
  assert.equal(expectedDropName(factsBot(), "oak_leaves"), "oak_sapling");
  assert.equal(expectedDropName(factsBot(), "large_fern"), "wheat_seeds");
  assert.equal(expectedDropName(factsBot(), "pitcher_crop"), "pitcher_pod");
  assert.equal(expectedDropName(silkTouchBot(), "iron_ore"), "iron_ore");
  assert.equal(expectedDropName(factsBot(), "iron_ore"), "raw_iron");
});

test("adds only Collect's before-and-after interpretation to Mineflayer inventory facts", () => {
  // Two stacks of logs: the counts add them up.
  const bot = factsBot({ slots: { 36: { name: "oak_log", count: 2 }, 37: { name: "oak_log", count: 3 }, 38: { name: "dirt", count: 4 } } });

  assert.deepEqual(inventoryCounts(bot), { oak_log: 5, dirt: 4 });
  assert.deepEqual(inventoryGains(bot, { oak_log: 1, dirt: 8 }, ["dirt", "oak_log", "oak_log"]), { oak_log: 4 });
});

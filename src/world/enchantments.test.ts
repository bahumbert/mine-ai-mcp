import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, itemOf } from "../test-support/fake-bot/index.js";
import { enchantmentsOf } from "./enchantments.js";

const { bot } = createFakeBot();
const efficiency = bot.registry.enchantmentsByName.efficiency!.id;
const silkTouch = bot.registry.enchantmentsByName.silk_touch!.id;

/** A real pickaxe stack whose `enchants` answers `enchants`: the 1.21 getter reads its `enchantments` component. */
function pickaxeWithComponent(enchants: unknown) {
  const item = itemOf(bot.registry, "diamond_pickaxe");
  Object.assign(item, { componentMap: new Map([["enchantments", { type: "enchantments", data: enchants }]]) });
  return item;
}

/** A real pickaxe stack answering `enchants` as pre-1.20.5 NBT does, a `{ name, lvl }` list, which 1.21.4's getter never gives. */
function pickaxeWithEnchants(enchants: unknown) {
  return Object.defineProperty(itemOf(bot.registry, "diamond_pickaxe"), "enchants", { value: enchants });
}

test("an NBT-era enchantment list passes through unchanged", () => {
  const item = pickaxeWithEnchants([{ name: "efficiency", lvl: 3 }]);
  assert.deepEqual(enchantmentsOf(bot, item), [{ name: "efficiency", lvl: 3 }]);
});

test("a 1.21 enchantments component is read as a name and level list", () => {
  const item = pickaxeWithComponent({
    enchantments: [
      { id: efficiency, level: 2 },
      { id: silkTouch, level: 1 },
    ],
    showInTooltip: true,
  });
  assert.deepEqual(enchantmentsOf(bot, item), [
    { name: "efficiency", lvl: 2 },
    { name: "silk_touch", lvl: 1 },
  ]);
});

test("an empty component, a missing item, or unknown data is no enchantment at all", () => {
  assert.deepEqual(enchantmentsOf(bot, pickaxeWithComponent({})), []);
  assert.deepEqual(enchantmentsOf(bot, null), []);
  assert.deepEqual(enchantmentsOf(bot, pickaxeWithEnchants(undefined)), []);
});

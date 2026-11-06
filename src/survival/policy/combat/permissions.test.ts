import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, itemOf } from "../../../test-support/fake-bot/index.js";
import { familyIndexOf } from "../../../world/item-families.js";
import { watchServerTags } from "../../../world/server-tags.js";
import { DEFAULT_COMBAT_POLICY } from "./contract.js";
import { permittedCombatItems } from "./permissions.js";

const names = (items: readonly { readonly name: string }[]) => items.map((item) => item.name);

test("a forbidden bow or shield is dropped from the carried items; every other item stays", () => {
  const { bot } = createFakeBot();
  const carried = ["bow", "shield", "iron_sword", "arrow", "stick"].map((name) => itemOf(bot.registry, name));
  const index = familyIndexOf(bot);
  assert.deepEqual(names(permittedCombatItems(index, carried, { ...DEFAULT_COMBAT_POLICY, bow: false, shield: true })), ["shield", "iron_sword", "arrow", "stick"]);
  assert.deepEqual(names(permittedCombatItems(index, carried, { ...DEFAULT_COMBAT_POLICY, bow: true, shield: false })), ["bow", "iron_sword", "arrow", "stick"]);
  assert.deepEqual(names(permittedCombatItems(index, carried, { ...DEFAULT_COMBAT_POLICY, bow: true, shield: true })), names(carried));
});

test("an item a datapack adds to the bow family is held back with the bow when bow use is forbidden", () => {
  const { bot, emitTags } = createFakeBot();
  watchServerTags(bot);
  const stick = itemOf(bot.registry, "stick");
  const policy = { ...DEFAULT_COMBAT_POLICY, bow: false };
  assert.deepEqual(names(permittedCombatItems(familyIndexOf(bot), [stick], policy)), ["stick"]);
  emitTags([{ tagType: "minecraft:item", tags: [{ tagName: "minecraft:enchantable/bow", entries: [stick.type] }] }]);
  assert.deepEqual(permittedCombatItems(familyIndexOf(bot), [stick], policy), []);
});

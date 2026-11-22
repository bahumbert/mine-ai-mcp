import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, itemOf } from "../../../test-support/fake-bot/index.js";
import { familyIndexOf } from "../../../world/item-families.js";
import { watchServerTags } from "../../../world/server-tags.js";
import { combatPolicySchema, DEFAULT_COMBAT_POLICY } from "./contract.js";
import { permittedCombatItems, responsePolicyChanged } from "./permissions.js";

const names = (items: readonly { readonly name: string }[]) => items.map((item) => item.name);

test("the quarry window is a positive server-tick permission of fights only", () => {
  assert.equal(DEFAULT_COMBAT_POLICY.quarry_wait_ticks, 600);
  for (const invalid of [0, -1, 1.5, Infinity])
    assert.equal(combatPolicySchema.safeParse({ ...DEFAULT_COMBAT_POLICY, quarry_wait_ticks: invalid }).success, false);
  const after = { ...DEFAULT_COMBAT_POLICY, quarry_wait_ticks: 700 };
  for (const response of ["fight", "hide", "evade", "deflect"] as const)
    assert.equal(responsePolicyChanged(DEFAULT_COMBAT_POLICY, after, response), response === "fight");
});

test("an evade's permissions include the clear and cover ranges but not bow", () => {
  for (const field of ["evade_clear_range", "evade_cover_range"]) {
    assert.equal(responsePolicyChanged(DEFAULT_COMBAT_POLICY, { ...DEFAULT_COMBAT_POLICY, [field]: 5 }, "evade"), true);
  }
  assert.equal(responsePolicyChanged(DEFAULT_COMBAT_POLICY, { ...DEFAULT_COMBAT_POLICY, bow: false }, "evade"), false);
});

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

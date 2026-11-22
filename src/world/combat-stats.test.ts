// Live combat readers reuse the measured armour and weapon selection boundaries.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { botDefence, meleeWeapon, serverDifficulty } from "./combat-stats.js";

test("defence follows worn armour, absorption metadata and equipment lost on death", async () => {
  const { bot, clock, combat } = createFakeBot({ carried: { iron_chestplate: 1 } });
  await bot.equip(bot.inventory.items()[0]!, "torso");
  await clock.advance(100);
  const absorption = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("player_absorption");
  Reflect.set(bot.entity.metadata, absorption, 4);
  assert.deepEqual(botDefence(bot), { health: 20, absorption: 4, armor: 6, toughness: 0 });
  combat.hurtBot(100, null);
  assert.equal(botDefence(bot).armor, 0, "a death loses the worn piece even before attributes catch up");
  assert.equal(botDefence(bot).toughness, 0);
});

test("unreported armour and absorption give zero; melee reads the best carried weapon", () => {
  const { bot } = createFakeBot({ slots: { 10: { name: "stone_sword" }, 6: { name: "iron_chestplate" } } });
  assert.equal(bot.heldItem, null);
  assert.deepEqual(botDefence(bot), { health: 20, absorption: 0, armor: 0, toughness: 0 });
  assert.deepEqual(meleeWeapon(bot), { item: "stone_sword", attack: { attackDamage: 5, attackSpeed: 1.6 } });
  assert.deepEqual(meleeWeapon(createFakeBot().bot), { item: null, attack: { attackDamage: 1, attackSpeed: 4 } });
  assert.equal(serverDifficulty(bot), "normal");
  for (const difficulty of ["peaceful", "easy", "hard"] as const) {
    bot.game.difficulty = difficulty;
    assert.equal(serverDifficulty(bot), difficulty);
  }
});

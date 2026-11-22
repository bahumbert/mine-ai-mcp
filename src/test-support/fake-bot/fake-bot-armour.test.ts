import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock } from "./fake-clock.js";
import { createFakeBot } from "./fake-bot.js";

/** The attributes of the own entity, as Mineflayer files them (`entities.js` `updateAttributes`). */
type Attributes = Record<string, { value: number; modifiers: { amount: number }[] }>;
const attributesOf = (bot: { entity: unknown }) => (bot.entity as { attributes?: Attributes }).attributes;

test("an armour piece nobody measured gives no modifier, and the entry the server told stays", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const { bot } = createFakeBot({ clock, carried: { iron_helmet: 1, iron_chestplate: 1 } });
  await bot.equip(bot.inventory.items().find(({ name }) => name === "iron_helmet")!, "head");
  await clock.advance(100);
  assert.deepEqual(attributesOf(bot)!["generic.armor"], { value: 0, modifiers: [] }, "a helmet is unmeasured: the entry with no modifier");
  await bot.equip(bot.inventory.items().find(({ name }) => name === "iron_chestplate")!, "torso");
  await clock.advance(100);
  assert.equal(attributesOf(bot)!["generic.armor"]!.modifiers[0]?.amount, 6);
  await bot.unequip("torso");
  await clock.advance(100);
  assert.deepEqual(attributesOf(bot)!["generic.armor"], { value: 0, modifiers: [] }, "an unequip removes the modifier and the key stays");
});

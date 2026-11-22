import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { createFakeClock } from "../test-support/fake-bot/fake-clock.js";
import { armourPoints } from "./armour-points.js";

type Attributes = Record<string, { value: number; modifiers: { uuid: string; amount: number; operation: number }[] }>;
const setAttributes = (bot: { entity: unknown }, attributes: Attributes) => void ((bot.entity as { attributes: Attributes }).attributes = attributes);

/** A bot that wears `name` on `destination` after the server told its armour attributes (a fake made already wearing gear has no entry until its first armour change). */
async function wearing(carried: Record<string, number>, wear: readonly (readonly [string, "head" | "torso" | "legs" | "feet"])[]) {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const { bot } = createFakeBot({ clock, carried });
  for (const [name, destination] of wear) {
    await bot.equip(bot.inventory.items().find((item) => item.name === name)!, destination);
    await clock.advance(100);
  }
  return bot;
}

test("armourPoints reads armor and toughness, 0 with no worn piece", async () => {
  assert.deepEqual(armourPoints(await wearing({ iron_chestplate: 1 }, [["iron_chestplate", "torso"]])), { armor: 6, toughness: 0 }, "iron chestplate, as measured");
  assert.deepEqual(armourPoints(await wearing({ diamond_chestplate: 1 }, [["diamond_chestplate", "torso"]])), { armor: 8, toughness: 2 }, "diamond chestplate, as measured");
  const none = createFakeBot().bot;
  setAttributes(none, { "generic.armor": { value: 0, modifiers: [{ uuid: "stale", amount: 6, operation: 0 }] }, "generic.armor_toughness": { value: 0, modifiers: [] } });
  assert.deepEqual(armourPoints(none), { armor: 0, toughness: 0 }, "every slot empty: 0 whatever the attribute says (after a death the kept attribute is stale)");
  const bare = createFakeBot().bot;
  assert.deepEqual(armourPoints(bare), { armor: 0, toughness: 0 }, "nothing worn and no attribute at all: 0");
});

test("armourPoints is null when a piece is worn and the server told no armour attribute", () => {
  const bot = createFakeBot({ slots: { 6: { name: "iron_chestplate" } } }).bot;
  assert.equal(armourPoints(bot), null);
});

test("armourPoints applies the attribute operations in Mineflayer's order and rounds to one decimal", async () => {
  const bot = await wearing({ iron_chestplate: 1 }, [["iron_chestplate", "torso"]]);
  setAttributes(bot, {
    "generic.armor": { value: 2, modifiers: [{ uuid: "a", amount: 4, operation: 0 }, { uuid: "b", amount: 0.5, operation: 1 }, { uuid: "c", amount: 0.11, operation: 2 }] },
    "generic.armor_toughness": { value: 0.25, modifiers: [] },
  });
  // (2 + 4) = 6; + 6 x 0.5 = 9; + 9 x 0.11 = 9.99 (explosion.js:40-56)
  assert.deepEqual(armourPoints(bot), { armor: 10, toughness: 0.3 });
});

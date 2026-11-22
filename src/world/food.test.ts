/** Which carried food the reflex eats, what counts as raw, and what "auto-edible" means: all from the food families and the smelting data. */
import test from "node:test";
import assert from "node:assert/strict";
import type { Bot } from "mineflayer";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { familyIndexOf } from "./item-families.js";
import { watchServerTags } from "./server-tags.js";
import { isAutoEdibleFood, isRawFood, selectReflexFood } from "./food.js";

const SHIPPED_VERSIONS = ["1.19.4", "1.20.1", "1.20.4", "1.20.6", "1.21.1", "1.21.4"] as const;

// --- the reference: today's tables and choice, copied ---------------------------------------------------------------

const OLD_AVOIDED = new Set(["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken", "suspicious_stew", "chorus_fruit", "enchanted_golden_apple"]);
const OLD_COOKED = new Set(["beef", "porkchop", "chicken", "mutton", "rabbit", "cod", "salmon", "potato"]);

/** `selectReflexFood` of src/world/food.ts before plan P4-17b task 3, over a list of carried names. */
function oldChoice(bot: Bot, carried: readonly string[], allowRaw: boolean): string | null {
  let best: string | null = null;
  let bestPoints = -1;
  let bestSaturation = -1;
  for (const name of carried) {
    const food = bot.registry.foodsByName[name];
    if (!food || OLD_AVOIDED.has(name)) continue;
    if (!allowRaw && OLD_COOKED.has(name)) continue;
    if (food.foodPoints > bestPoints || (food.foodPoints === bestPoints && food.saturation > bestSaturation)) {
      best = name;
      bestPoints = food.foodPoints;
      bestSaturation = food.saturation;
    }
  }
  return best;
}

// --- tests ----------------------------------------------------------------------------------------------------------

for (const version of SHIPPED_VERSIONS) {
  test(`the reflex never picks an avoided food: rotten flesh with bread carried, ${version}`, () => {
    const { bot } = createFakeBot({ version, carried: { rotten_flesh: 8, bread: 1 } });
    assert.equal(selectReflexFood(bot, { allowRaw: true })?.name, "bread");
    assert.equal(selectReflexFood(bot, { allowRaw: false })?.name, "bread");
    const onlyAvoided = createFakeBot({ version, carried: { rotten_flesh: 8, spider_eye: 2 } }).bot;
    assert.equal(selectReflexFood(onlyAvoided, { allowRaw: true }), null);
  });
}

for (const version of ["1.21.4", "1.20.4"] as const) {
  test(`raw beef is raw, cooked_beef is not, ${version}`, () => {
    const index = familyIndexOf(createFakeBot({ version }).bot);
    assert.equal(isRawFood(index, "beef"), true);
    assert.equal(isRawFood(index, "potato"), true);
    assert.equal(isRawFood(index, "cooked_beef"), false);
    assert.equal(isRawFood(index, "bread"), false);
    assert.equal(isRawFood(index, "stick"), false, "a non-food has no cooked form");
    assert.equal(isRawFood(index, "not_an_item"), false);
    assert.equal(isAutoEdibleFood(index, "stick"), false);
  });
}

test("after the server's tags packet the avoided foods stay avoided (the vanilla override is not a tag)", () => {
  const harness = createFakeBot({ carried: { rotten_flesh: 4, bread: 1 } });
  const { bot } = harness;
  watchServerTags(bot);
  harness.emitTags([{ tagType: "minecraft:item", tags: [{ tagName: "minecraft:swords", entries: [bot.registry.itemsByName.stick!.id] }] }]);
  assert.equal(familyIndexOf(bot).source().source, "server");
  assert.equal(selectReflexFood(bot, { allowRaw: true })?.name, "bread");
  assert.equal(isAutoEdibleFood(familyIndexOf(bot), "rotten_flesh"), false);
});

test("the reflex's choice is unchanged on 1.21.4: every pair of vanilla foods carried agrees with today's code", () => {
  const { bot } = createFakeBot({ version: "1.21.4" });
  const foods = Object.keys(bot.registry.foodsByName);
  assert.ok(foods.length > 30, "the registry lists the vanilla foods");
  const differences: string[] = [];
  for (const first of foods) {
    for (const second of foods) {
      if (second < first) continue;
      const harness = createFakeBot({ version: "1.21.4", carried: first === second ? { [first]: 1 } : { [first]: 1, [second]: 1 } });
      const carried = harness.bot.inventory.items().map((item) => item.name);
      for (const allowRaw of [true, false]) {
        const expected = oldChoice(harness.bot, carried, allowRaw);
        const actual = selectReflexFood(harness.bot, { allowRaw })?.name ?? null;
        if (expected !== actual) differences.push(`${first}+${second} allowRaw=${allowRaw}: expected ${expected} got ${actual}`);
      }
    }
  }
  assert.deepEqual(differences, []);
});

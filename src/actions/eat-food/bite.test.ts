import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, itemOf } from "../../test-support/fake-bot/index.js";
import { DEFAULT_BITE_TICKS, biteTicks, heldBiteLanded } from "./bite.js";

const { bot: registryBot } = createFakeBot();

/** A real stack of `name` whose `consumable` component says `data`, as a 1.21.4 server sends it (`{ type, data }`, prismarine-item `componentMap`). */
function foodWithConsumable(data: unknown) {
  const item = itemOf(registryBot.registry, "dried_kelp");
  Object.assign(item, { componentMap: new Map([["consumable", { type: "consumable", data }]]) });
  return item;
}

test("a stack with no consumable component bites for the default 32 ticks", () => {
  assert.equal(biteTicks(itemOf(registryBot.registry, "cooked_beef")), 32);
  const noConsumable = itemOf(registryBot.registry, "cooked_beef");
  Object.assign(noConsumable, { componentMap: new Map([["custom_name", { type: "custom_name", data: "x" }]]) });
  assert.equal(biteTicks(noConsumable), 32);
});

test("the consumable component's consume_seconds sets the bite, rounded up to a tick", () => {
  assert.equal(biteTicks(foodWithConsumable({ consume_seconds: 0.8 })), 16);
  assert.equal(biteTicks(foodWithConsumable({ consume_seconds: 4 })), 80);
  assert.equal(biteTicks(foodWithConsumable({ consume_seconds: 0.81 })), 17);
});

test("a consumable component with no usable consume_seconds falls back to the default", () => {
  for (const data of [{}, { consume_seconds: 0 }, { consume_seconds: -1 }, { consume_seconds: Number.NaN }, { consume_seconds: Infinity }, { consume_seconds: "2" }, null, undefined]) {
    assert.equal(biteTicks(foodWithConsumable(data)), DEFAULT_BITE_TICKS, JSON.stringify(data));
  }
});

const HELD_SLOT = 36;

/** A bot holding `count` cooked beef in the first hotbar slot. */
function holding(count: number) {
  const { bot } = createFakeBot({ food: 10, carried: { cooked_beef: count } });
  return bot;
}

test("the held stack one fewer, or its slot emptied from a stack of one, is a landed bite", () => {
  for (const [count, left] of [[3, 2], [1, 0]] as const) {
    const bot = holding(count);
    bot.inventory.updateSlot(HELD_SLOT, left === 0 ? (null as never) : itemOf(bot.registry, "cooked_beef", left));
    assert.equal(heldBiteLanded(bot, HELD_SLOT, "cooked_beef", count), true, `${count} -> ${left}`);
  }
});

test("a same-food pickup into another slot does not hide the bite", () => {
  const bot = holding(2);
  bot.inventory.updateSlot(HELD_SLOT, itemOf(bot.registry, "cooked_beef", 1));
  bot.inventory.updateSlot(9, itemOf(bot.registry, "cooked_beef", 1));
  assert.equal(bot.inventory.count(bot.registry.itemsByName.cooked_beef!.id, null), 2, "the carried total did not move");
  assert.equal(heldBiteLanded(bot, HELD_SLOT, "cooked_beef", 2), true);
});

test("the held slot unchanged is no bite, even when the food is carried elsewhere", () => {
  const bot = holding(2);
  assert.equal(heldBiteLanded(bot, HELD_SLOT, "cooked_beef", 2), false);
  bot.inventory.updateSlot(9, itemOf(bot.registry, "cooked_beef", 5));
  assert.equal(heldBiteLanded(bot, HELD_SLOT, "cooked_beef", 2), false);
});

test("another item in the held slot is no bite", () => {
  const bot = holding(1);
  bot.inventory.updateSlot(HELD_SLOT, itemOf(bot.registry, "stone", 1));
  assert.equal(heldBiteLanded(bot, HELD_SLOT, "cooked_beef", 1), false);
});

test("a death empties the slot without a bite", () => {
  const bot = holding(1);
  bot.inventory.updateSlot(HELD_SLOT, null as never);
  bot.health = 0;
  assert.equal(heldBiteLanded(bot, HELD_SLOT, "cooked_beef", 1), false);
});

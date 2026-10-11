import assert from "node:assert/strict";
import test from "node:test";
import { junkHint, neededItems } from "./inventory-room.ts";

const stack = (name: string, count: number) => ({ name, count });
const snapshot = (inventory: { name: string; count: number }[], foods: string[] = []) => ({ inventory, foods: foods.map((name) => ({ name, hunger: 4, count: 1 })) }) as never;

test("neededItems: tools, armour, stations, foods, the house bill and the items being fetched", () => {
  const carried = snapshot([stack("stone_pickaxe", 1), stack("iron_boots", 1), stack("crafting_table", 1), stack("bread", 3), stack("snowball", 90), stack("oak_planks", 40)], ["bread"]);
  const needed = neededItems(carried, { houseBill: ["oak_planks"], wanted: new Set(["coal"]) });
  assert.deepEqual([...needed].sort(), ["bread", "coal", "crafting_table", "iron_boots", "oak_planks", "stone_pickaxe"]);
  assert.equal(needed.has("snowball"), false);
});

test("junkHint names the junk with whole counts and slots, most slots first, at most 6", () => {
  const snowballs = Array.from({ length: 15 }, (_, index) => stack("snowball", index === 0 ? 8 : 16));
  const carried = snapshot([...snowballs, stack("granite", 64), stack("stone_axe", 1), ...["a", "b", "c", "d", "e", "f"].map((n) => stack(`junk_${n}`, 1))]);
  const hint = junkHint(carried, neededItems(carried));
  assert.match(hint, /232 snowball \(15 slots\)/u);
  assert.match(hint, /64 granite \(1 slot\)/u);
  assert.doesNotMatch(hint, /stone_axe/u);
  assert.ok(hint.indexOf("snowball") < hint.indexOf("granite"));
  assert.ok(hint.includes('{"skill":"drop_item","items":[{"item":"snowball"},{"item":"granite"}'));
  assert.doesNotMatch(hint, /junk_f/u, "six at most");
});

test("junkHint with everything needed says to give something up", () => {
  const carried = snapshot([stack("stone_axe", 1)]);
  assert.match(junkHint(carried, neededItems(carried)), /everything you carry is needed/u);
});

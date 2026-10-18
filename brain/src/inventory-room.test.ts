import assert from "node:assert/strict";
import test from "node:test";
import { consumedBy, junkHint, junkStacks, neededItems } from "./inventory-room.ts";
import { FakeRuntime } from "./testing.ts";

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

test("neededItems: an item the objective names is never junk, and neither is the block a step mines (live 2026-10-11: Theo's hint dropped cobblestone for \"Mine cobblestone\")", () => {
  const carried = snapshot([stack("cobblestone", 256), stack("dirt", 128), stack("oak_log", 4)]);
  const needed = neededItems(carried, { objective: "Mine cobblestone", wanted: new Set(["oak_log"]) });
  assert.deepEqual([...needed].sort(), ["cobblestone", "oak_log"]);
  const hint = junkHint(carried, needed);
  assert.match(hint, /128 dirt/u);
  assert.doesNotMatch(hint, /cobblestone|oak_log/u);
  assert.equal(neededItems(carried, { objective: "Mine something else" }).has("cobblestone"), false);
});

test("junkStacks lists the unneeded kinds with their stacks in inventory order, most slots first", () => {
  const carried = snapshot([stack("dirt", 30), stack("cobblestone", 64), stack("gravel", 40), stack("dirt", 5), stack("stone_axe", 1)]);
  const junk = junkStacks(carried, new Set(["cobblestone", "stone_axe"]));
  assert.deepEqual(junk, [
    { name: "dirt", count: 35, slots: 2, stacks: [30, 5] },
    { name: "gravel", count: 40, slots: 1, stacks: [40] },
  ]);
  assert.deepEqual(junkStacks(carried, new Set(["dirt", "gravel", "cobblestone", "stone_axe"])), []);
});

test("consumedBy: a craft's whole recipe tree, a smelt's input and fuel, nothing else", async () => {
  const runtime = new FakeRuntime();
  runtime.recipes = {
    stick: { makes: 4, needs: [{ item: "oak_planks", count: 2 }] },
    oak_planks: { makes: 4, needs: [{ item: "oak_log", count: 1 }] },
    stone_shovel: { makes: 1, needs: [{ item: "cobblestone", count: 1 }, { item: "stick", count: 2 }] },
  };
  const craft = await consumedBy(runtime, "craft_item", { items: [{ item_name: "stone_shovel", count: 1 }] });
  assert.deepEqual([...craft].sort(), ["cobblestone", "oak_log", "oak_planks", "stick"]);
  assert.deepEqual([...(await consumedBy(runtime, "smelt_item", { item_name: "raw_iron", count: 3, fuel_item_name: "coal" }))].sort(), ["coal", "raw_iron"]);
  assert.equal((await consumedBy(runtime, "navigate", { x: 1 })).size, 0);
});

test("neededItems keeps one tool of each class, the best tier: a lesser tier of the same class is spare (run 15 N5)", () => {
  const carried = snapshot([stack("wooden_pickaxe", 1), stack("stone_pickaxe", 1), stack("wooden_sword", 1), stack("white_bed", 1), stack("oak_boat", 1)]);
  const needed = neededItems(carried);
  assert.deepEqual([...needed].sort(), ["oak_boat", "stone_pickaxe", "white_bed", "wooden_sword"]);
});

test("junkStacks lists the copies of a needed tool beyond the first as junk", () => {
  const carried = snapshot([stack("wooden_sword", 1), stack("dirt", 4), stack("wooden_sword", 1), stack("wooden_sword", 1)]);
  assert.deepEqual(junkStacks(carried, new Set(["wooden_sword"])), [
    { name: "wooden_sword", count: 2, slots: 2, stacks: [1, 1] },
    { name: "dirt", count: 4, slots: 1, stacks: [4] },
  ]);
});

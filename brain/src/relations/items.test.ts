import assert from "node:assert/strict";
import test from "node:test";
import { carriedOf, owedText, sideText, spareFor } from "./items.ts";

test("sideText lists count and item per entry, empty for no entry", () => {
  assert.equal(sideText([{ item: "oak_log", count: 2 }, { item: "iron_ingot", count: 1 }]), "2 oak_log, 1 iron_ingot");
  assert.equal(sideText([]), "");
});

test("carriedOf adds up every stack of the item and counts nothing for a missing one", () => {
  const inventory = [{ name: "oak_log", count: 40 }, { name: "stone", count: 3 }, { name: "oak_log", count: 5 }] as never;
  assert.equal(carriedOf(inventory, "oak_log"), 45);
  assert.equal(carriedOf(inventory, "dirt"), 0);
});

const owedTables = [
  { item: "crafting_table", count: 1, partner: "Ayla", tradeId: "t1" },
  { item: "crafting_table", count: 2, partner: "Bruno", tradeId: "t2" },
  { item: "bread", count: 4, partner: "Ayla", tradeId: "t1" },
];

test("spareFor keeps what is owed to every trade except the partner's", () => {
  assert.equal(spareFor(5, owedTables, "crafting_table"), 2);
  assert.equal(spareFor(5, owedTables, "crafting_table", "ayla"), 3, "a partner's own trade does not hold items back from them, whatever the case of the name");
  assert.equal(spareFor(1, owedTables, "crafting_table", "Bruno"), 0, "never below zero");
  assert.equal(spareFor(9, owedTables, "dirt"), 9);
  assert.equal(spareFor(9, [], "crafting_table"), 9);
});

test("owedText names each trade that holds the item back", () => {
  assert.equal(owedText(owedTables, "crafting_table"), "1 crafting_table to Ayla, 2 crafting_table to Bruno");
  assert.equal(owedText(owedTables, "crafting_table", "Ayla"), "2 crafting_table to Bruno");
  assert.equal(owedText(owedTables, "dirt"), "");
});

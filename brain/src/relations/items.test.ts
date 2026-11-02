import assert from "node:assert/strict";
import test from "node:test";
import { billShortfall, carriedOf, freeStacks, noSpareFact, spareCounter, heldCounts, heldKinds, heldTotal, owedText, owedUsed, sideText, spareFor } from "./items.ts";

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

const bag = (...stacks: [string, number][]) => stacks.map(([name, count]) => ({ name, count }));
const twoTrades = [
  { item: "cobblestone", count: 2, partner: "Ayla", tradeId: "t1" },
  { item: "cobblestone", count: 3, partner: "Bruno", tradeId: "t2" },
  { item: "bread", count: 4, partner: "Ayla", tradeId: "t1" },
];

test("heldTotal sums what the other trades owe of an item, the partner's own trade left out, whatever the case of the name", () => {
  assert.equal(heldTotal(twoTrades, "cobblestone"), 5);
  assert.equal(heldTotal(twoTrades, "cobblestone", "ayla"), 3);
  assert.equal(heldTotal(twoTrades, "dirt"), 0);
  assert.equal(heldTotal([], "cobblestone"), 0);
});

test("heldCounts holds each owed item down to what is carried, never above it and without the items not carried", () => {
  const held = heldCounts(twoTrades, bag(["cobblestone", 40], ["bread", 1], ["dirt", 9]));
  assert.deepEqual([...held], [["cobblestone", 5], ["bread", 1]], "bread owed 4, carried 1: capped at 1");
  assert.deepEqual([...heldCounts(twoTrades, bag(["dirt", 9]))], [], "an owed item not carried holds nothing");
  assert.deepEqual([...heldCounts(twoTrades, bag(["cobblestone", 40], ["bread", 4]), "Ayla")], [["cobblestone", 3]]);
  assert.deepEqual([...heldCounts(twoTrades, bag(["cobblestone", 20], ["cobblestone", 20]))], [["cobblestone", 5]], "stacks add up");
});

test("heldKinds names the kinds with no spare: 64 carried with 2 owed is not one, 2 carried with 2 owed is", () => {
  assert.deepEqual([...heldKinds(twoTrades, bag(["cobblestone", 64], ["bread", 4]))], ["bread"]);
  assert.deepEqual([...heldKinds(twoTrades, bag(["cobblestone", 5], ["bread", 9]))], ["cobblestone"], "carried equal to the owed count has no spare");
  assert.deepEqual([...heldKinds(twoTrades, bag(["cobblestone", 2]))], ["cobblestone"], "owed more than carried: no spare, never negative");
  assert.deepEqual([...heldKinds([], bag(["cobblestone", 2]))], []);
});

test("freeStacks takes the held counts off the last stacks first and drops the emptied ones", () => {
  const inventory = bag(["cobblestone", 64], ["dirt", 3], ["cobblestone", 10]);
  assert.deepEqual(freeStacks(inventory, new Map([["cobblestone", 12]])), bag(["cobblestone", 62], ["dirt", 3]));
  assert.deepEqual(freeStacks(inventory, new Map([["cobblestone", 10]])), bag(["cobblestone", 64], ["dirt", 3]), "an emptied stack is removed");
  assert.deepEqual(freeStacks(inventory, new Map()), inventory);
  assert.deepEqual(freeStacks(inventory, new Map([["cobblestone", 99]])), bag(["dirt", 3]), "held above carried takes all of the kind");
});

test("owedUsed is empty unless an item fell below what is held, then says what is carried of what is owed", () => {
  const owedPlanks = [{ item: "oak_planks", count: 4, partner: "Ayla", tradeId: "t1" }];
  assert.equal(owedUsed(owedPlanks, bag(["oak_planks", 6]), bag(["oak_planks", 5])), "", "fell but stays above what is owed");
  assert.equal(owedUsed(owedPlanks, bag(["oak_planks", 6]), bag(["oak_planks", 6], ["stick", 4])), "");
  assert.equal(owedUsed(owedPlanks, bag(["oak_planks", 6]), bag(["oak_planks", 2])), "you now carry 2 oak_planks of the 4 you owe Ayla (trade)");
  assert.equal(owedUsed(owedPlanks, bag(["oak_planks", 6]), bag(["stick", 4])), "you now carry 0 oak_planks of the 4 you owe Ayla (trade)");
  assert.equal(owedUsed(owedPlanks, bag(["oak_planks", 3]), bag(["oak_planks", 3])), "", "an item that did not fall is not reported, short as it was");
  assert.equal(owedUsed(owedPlanks, bag(["oak_planks", 6]), bag(["oak_planks", 2]), "ayla"), "", "a give to the partner is not reported");
  assert.equal(owedUsed([], bag(["oak_planks", 6]), bag(["oak_planks", 2])), "");
});

test("owedUsed sums two trades owing one item and joins several items", () => {
  const said = owedUsed(twoTrades, bag(["cobblestone", 9], ["bread", 4]), bag(["cobblestone", 1], ["bread", 4]));
  assert.equal(said, "you now carry 1 cobblestone of the 5 you owe Ayla, Bruno (trade)");
  const both = owedUsed(twoTrades, bag(["cobblestone", 9], ["bread", 4]), bag(["cobblestone", 1], ["bread", 0]));
  assert.equal(both, "you now carry 1 cobblestone of the 5 you owe Ayla, Bruno (trade); you now carry 0 bread of the 4 you owe Ayla (trade)");
});

test("billShortfall takes the held counts off the bag and says which missing blocks are owed ones", () => {
  const owed = [{ item: "oak_planks", count: 4, partner: "Ayla", tradeId: "t1" }];
  const bill = [{ item: "oak_planks", count: 6 }, { item: "oak_log", count: 2 }];
  assert.deepEqual(billShortfall(bill, bag(["oak_planks", 8], ["oak_log", 1]), []), { missing: [{ item: "oak_log", count: 1 }], owedNote: "" });
  assert.deepEqual(billShortfall(bill, bag(["oak_planks", 8], ["oak_log", 1]), owed), { missing: [{ item: "oak_planks", count: 2 }, { item: "oak_log", count: 1 }], owedNote: "2 oak_planks you carry are owed: 4 oak_planks to Ayla (trade)" });
  assert.deepEqual(billShortfall(bill, bag(["oak_planks", 12], ["oak_log", 2]), owed), { missing: [], owedNote: "" }, "the bill is met beyond what is owed");
  assert.deepEqual(billShortfall(bill, bag(["oak_planks", 2], ["oak_log", 2]), owed), { missing: [{ item: "oak_planks", count: 6 }], owedNote: "2 oak_planks you carry are owed: 4 oak_planks to Ayla (trade)" }, "only the carried part of the owed count is said");
});

test("noSpareFact states what is owed when the bag holds no more than that, and nothing otherwise", () => {
  assert.equal(noSpareFact(twoTrades, bag(["bread", 4]), "bread"), "you owe 4 bread to Ayla (trade); you carry no bread beyond it");
  assert.equal(noSpareFact(twoTrades, bag(["bread", 2]), "bread"), "you owe 4 bread to Ayla (trade); you carry no bread beyond it");
  assert.equal(noSpareFact(twoTrades, bag(["bread", 5]), "bread"), null);
  assert.equal(noSpareFact(twoTrades, bag(["apple", 1]), "apple"), null);
});

test("spareCounter takes the reserved and the held counts off what a bag carries", () => {
  const spare = spareCounter([{ item: "cobblestone", count: 10 }], new Map([["cobblestone", 4], ["dirt", 4]]))(bag(["cobblestone", 20], ["dirt", 10]));
  assert.equal(spare("cobblestone"), 6);
  assert.equal(spare("dirt"), 6);
  assert.equal(spare("sand"), 0);
});

// Crafting dependencies behind a failed fetch, using shipped recipes and a cyclic recipe seam.
import assert from "node:assert/strict";
import test from "node:test";
import { itemsNeeding } from "./made-from.ts";

const BILL = [
  { item: "spruce_stairs", count: 42 }, { item: "oak_planks", count: 36 },
  { item: "cobblestone", count: 16 }, { item: "spruce_slab", count: 7 },
  { item: "glass_pane", count: 3 }, { item: "oak_door", count: 1 },
];

test("a missing input names only the requested items its crafting recipes can make", () => {
  assert.deepEqual(itemsNeeding(["spruce_log"], BILL), [
    { item: "spruce_stairs", count: 42 }, { item: "spruce_slab", count: 7 },
  ]);
  assert.deepEqual(itemsNeeding(["cobblestone"], [{ item: "cobblestone_stairs", count: 4 }]), [{ item: "cobblestone_stairs", count: 4 }]);
  assert.deepEqual(itemsNeeding(["cobblestone"], BILL), [{ item: "cobblestone", count: 16 }]);
  assert.deepEqual(itemsNeeding(["sand"], BILL), []);
  assert.deepEqual(itemsNeeding(["unknown_input"], BILL), []);
  assert.deepEqual(itemsNeeding([], BILL), []);
  assert.deepEqual(itemsNeeding(["spruce_log"], []), []);
  assert.deepEqual(itemsNeeding(["spruce_log"], [{ item: "unknown_item", count: 1 }]), []);
});

test("cycles terminate without hiding another recipe or limiting ingredient depth", () => {
  const registry = {
    itemsByName: { a: { id: 1 }, b: { id: 2 }, source: { id: 3 }, unrelated: { id: 4 } },
    recipes: { 1: [{ ingredients: [2] }, { inShape: [[null, 3]] }], 2: [{ ingredients: [1] }] },
  };
  assert.deepEqual(itemsNeeding(["unrelated"], [{ item: "a", count: 1 }], registry), []);
  assert.deepEqual(itemsNeeding(["source"], [{ item: "b", count: 2 }], registry), [{ item: "b", count: 2 }]);
  const chain = {
    itemsByName: { source: { id: 0 }, end: { id: 100 } },
    recipes: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [index + 1, [{ ingredients: [index] }]])),
  };
  assert.deepEqual(itemsNeeding(["source"], [{ item: "end", count: 3 }], chain), [{ item: "end", count: 3 }]);
});

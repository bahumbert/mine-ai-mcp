import test from "node:test";
import assert from "node:assert/strict";
import { shapeVariantsOf } from "./shape-variants.ts";

const like = { stairs: "spruce_stairs", slab: "spruce_slab" } as const;

test("finds matching shapes from recipes and states", () => {
  for (const [block, expected] of [
    ["oak_planks", { stairs: "oak_stairs", slab: "oak_slab" }],
    ["cobblestone", { stairs: "cobblestone_stairs", slab: "cobblestone_slab" }],
    ["dirt", {}], ["unknown_block", {}],
    ["spruce_planks", like],
  ] as const) assert.deepEqual(shapeVariantsOf(block, like), expected);
  assert.deepEqual(shapeVariantsOf("oak_planks", { stairs: "spruce_stairs" }), { stairs: "oak_stairs" });
});

test("omits a shape when multiple recipe results have its states", () => {
  const states = [{ name: "facing" }, { name: "half" }];
  const registry = {
    items: { 1: { name: "x" }, 2: { name: "a" }, 3: { name: "b" } },
    itemsByName: { x: { id: 1 }, a: { id: 2 }, b: { id: 3 } },
    blocksByName: { reference: { states }, a: { states }, b: { states } },
    recipes: { 2: [{ ingredients: [1] }], 3: [{ inShape: [[1, null]] }] },
  };
  assert.deepEqual(shapeVariantsOf("x", { stairs: "reference" }, { ...registry, recipes: { 2: registry.recipes[2] } }), { stairs: "a" });
  assert.deepEqual(shapeVariantsOf("x", { stairs: "reference" }, registry), {});
  for (const [recipe, expected] of [
    [{}, {}], [{ ingredients: [] }, {}], [{ ingredients: [null] }, {}],
    [{ inShape: [[null]] }, {}], [{ ingredients: [1, 3] }, {}],
    [{ ingredients: [1] }, { stairs: "a" }], [{ inShape: [[1, null]] }, { stairs: "a" }],
  ] as const) {
    assert.deepEqual(shapeVariantsOf("x", { stairs: "reference" }, { ...registry, recipes: { 2: [recipe] } }), expected);
  }
});

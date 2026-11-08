import assert from "node:assert/strict";
import minecraftData from "minecraft-data";
import test from "node:test";
import { DEFAULT_MINECRAFT_VERSION } from "../server/config.js";
import { sameNeedItems } from "./same-need.js";

const registry = minecraftData(DEFAULT_MINECRAFT_VERSION);

test("the stone pickaxe's recipes list each stone tool material, so cobblestone and blackstone serve cobbled deepslate's need", () => {
  const { items, results } = sameNeedItems(registry, "cobbled_deepslate", "stone_pickaxe");
  assert.ok(items.includes("cobblestone"), `items: ${items.join(", ")}`);
  assert.ok(items.includes("blackstone"), `items: ${items.join(", ")}`);
  assert.ok(!items.includes("cobbled_deepslate"), "the item itself is excluded");
  assert.deepEqual(results, ["stone_pickaxe"]);
});

test("a planks kind serves the same need as another for a crafting table", () => {
  const { items } = sameNeedItems(registry, "oak_planks", "crafting_table");
  assert.ok(items.includes("spruce_planks"), `items: ${items.join(", ")}`);
});

test("an item in no recipe serves no need", () => {
  assert.deepEqual(sameNeedItems(registry, "dirt"), { items: [], results: [] });
});

test("forResult limits the results; without it every result the item serves is listed", () => {
  const all = sameNeedItems(registry, "cobbled_deepslate");
  assert.ok(all.results.includes("stone_pickaxe"), `results: ${all.results.join(", ")}`);
  assert.ok(all.results.includes("stone_axe"), `results: ${all.results.join(", ")}`);
  assert.deepEqual(sameNeedItems(registry, "cobbled_deepslate", "stone_pickaxe").results, ["stone_pickaxe"]);
});

test("an unknown item or result serves no need", () => {
  assert.deepEqual(sameNeedItems(registry, "no_such_item"), { items: [], results: [] });
  assert.deepEqual(sameNeedItems(registry, "cobbled_deepslate", "no_such_item"), { items: [], results: [] });
});

test("the build is cached: two calls on one registry read its recipe data once", () => {
  let recipeReads = 0;
  const counted = {
    ...registry,
    recipes: new Proxy(registry.recipes, {
      ownKeys(target) {
        recipeReads += 1;
        return Reflect.ownKeys(target);
      },
    }),
  };
  sameNeedItems(counted, "cobbled_deepslate");
  assert.equal(recipeReads, 1);
  sameNeedItems(counted, "oak_planks", "crafting_table");
  assert.equal(recipeReads, 1);
});

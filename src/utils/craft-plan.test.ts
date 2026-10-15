import assert from "node:assert/strict";
import test from "node:test";
import { craftingBot, craftingRecipe, craftingRegistry as registry } from "../test-support/crafting.js";
import { Vec3 } from "vec3";
import { seenInWorld } from "../runtime/frontier.js";
import { planCraftingFromInventory } from "./craft-plan.js";

test("turns Mineflayer recipes into stable recursive steps and readable trees", () => {
  const { bot } = craftingBot({ oak_log: 1, cobblestone: 3 });
  const target = registry.itemsByName.stone_pickaxe;

  const preparation = planCraftingFromInventory(bot, [{ ...target, count: 1 }]);

  assert.equal(preparation.kind, "ready");
  assert.deepEqual(
    preparation.plan.steps.map((step) => step.item),
    ["oak_planks", "stick", "stone_pickaxe"],
  );
  assert.deepEqual(preparation.plan.requiredMaterials, [
    { item: "cobblestone", count: 3 },
    { item: "oak_log", count: 1 },
  ]);
  assert.equal(preparation.plan.requiresCraftingTable, true);
  assert.match(preparation.plan.tree, /stone_pickaxe x1/);
  assert.match(preparation.plan.tree, /stick x2/);
  assert.match(preparation.plan.tree, /oak_log x1/);
});

test("exposes missing leaves instead of the requested item", () => {
  const { bot } = craftingBot({});
  const target = registry.itemsByName.stone_pickaxe;

  const preparation = planCraftingFromInventory(bot, [{ ...target, count: 1 }]);

  assert.equal(preparation.kind, "missing_materials");
  assert.ok(preparation.plan.missingMaterials.length > 0);
  assert.ok(preparation.plan.missingMaterials.every((material) => material.item !== "stone_pickaxe"));
  assert.match(preparation.plan.tree, /missing/);
  assert.equal(preparation.plan.steps.at(-1)?.item, "stone_pickaxe");
});

test("a shortfall names the wood already carried, not the first wood in registry order", () => {
  // Live 1 October: two oak logs, a table and a wooden pickaxe to make, reported as one missing pale_oak_log.
  const { bot } = craftingBot({ oak_log: 2 }, true, [
    craftingRecipe("pale_oak_planks", 4, { pale_oak_log: 1 }),
    craftingRecipe("stick", 4, { pale_oak_planks: 2 }),
    craftingRecipe("crafting_table", 1, { pale_oak_planks: 4 }),
    craftingRecipe("wooden_pickaxe", 1, { pale_oak_planks: 3, stick: 2 }, true),
    craftingRecipe("wooden_pickaxe", 1, { oak_planks: 3, stick: 2 }, true),
  ]);
  const preparation = planCraftingFromInventory(bot, [
    { ...registry.itemsByName.crafting_table, count: 1 },
    { ...registry.itemsByName.wooden_pickaxe, count: 1 },
  ]);
  assert.equal(preparation.kind, "missing_materials");
  assert.deepEqual(preparation.plan.missingMaterials, [{ item: "oak_log", count: 1 }]);
});

/** Two woods' planks, sticks and table: which wood a shortfall names is the planner's choice. */
const TWO_WOODS = [
  craftingRecipe("pale_oak_planks", 4, { pale_oak_log: 1 }),
  craftingRecipe("birch_planks", 4, { birch_log: 1 }),
  craftingRecipe("stick", 4, { pale_oak_planks: 2 }),
  craftingRecipe("stick", 4, { birch_planks: 2 }),
  craftingRecipe("crafting_table", 1, { pale_oak_planks: 4 }),
  craftingRecipe("crafting_table", 1, { birch_planks: 4 }),
];

test("carrying no wood, a shortfall names the preferred wood (the one growing nearby), not the first in registry order", () => {
  // Live 3 October: carrying nothing, Vex's stone pickaxe needed "3 pale_oak_log" and he walked 900 blocks for them,
  // across an ocean, with oak and birch all around.
  const { bot } = craftingBot({}, true, TWO_WOODS);
  const table = [{ ...registry.itemsByName.crafting_table, count: 1 }];
  assert.deepEqual(planCraftingFromInventory(bot, table).plan.missingMaterials, [{ item: "pale_oak_log", count: 1 }]);
  assert.deepEqual(planCraftingFromInventory(bot, table, { prefer: ["birch_log", "oak_log"] }).plan.missingMaterials, [{ item: "birch_log", count: 1 }]);
  // What is carried still comes first.
  const carrying = craftingBot({ pale_oak_log: 1 }, true, TWO_WOODS).bot;
  assert.equal(planCraftingFromInventory(carrying, table, { prefer: ["birch_log"] }).kind, "ready");
});

/**
 * Live 3 October: `get_items bucket` found the bucket "not craftable". Iron ingots only craft back out of iron nuggets
 * and iron blocks, both made from ingots, so every recipe of the ingot loops to itself and the whole bucket failed.
 * Such an ingredient is a missing material (a furnace makes it), as an item without any recipe is.
 */
/** Minecraft's iron and coal recipes: ingots and coal only craft back out of what is made of them. */
const LOOPING_RECIPES = [
  craftingRecipe("bucket", 1, { iron_ingot: 3 }, true),
  craftingRecipe("iron_pickaxe", 1, { iron_ingot: 3, stick: 2 }, true),
  craftingRecipe("iron_ingot", 1, { iron_nugget: 9 }, true),
  craftingRecipe("iron_nugget", 9, { iron_ingot: 1 }),
  craftingRecipe("iron_block", 1, { iron_ingot: 9 }, true),
  craftingRecipe("iron_ingot", 9, { iron_block: 1 }),
  craftingRecipe("coal_block", 1, { coal: 9 }, true),
  craftingRecipe("coal", 9, { coal_block: 1 }),
];

test("an ingredient whose every recipe loops back to itself is a missing material, not a failed plan", () => {
  const { bot } = craftingBot({ stick: 2 }, true, LOOPING_RECIPES);
  const bucket = planCraftingFromInventory(bot, [{ ...registry.itemsByName.bucket, count: 1 }]);
  assert.equal(bucket.kind, "missing_materials");
  assert.deepEqual(bucket.plan.missingMaterials, [{ item: "iron_ingot", count: 3 }]);
  const pickaxe = planCraftingFromInventory(bot, [{ ...registry.itemsByName.iron_pickaxe, count: 1 }]);
  assert.equal(pickaxe.kind, "missing_materials");
  assert.deepEqual(pickaxe.plan.missingMaterials, [{ item: "iron_ingot", count: 3 }]);
});

test("carrying the requested item never turns it into a round trip through what it is made of", () => {
  // Live 2026-10-03: carrying wheat, `get_items wheat` planned wheat -> hay_block -> wheat and failed for inventory room.
  const { bot } = craftingBot({ wheat: 9 }, true, [
    craftingRecipe("hay_block", 1, { wheat: 9 }, true),
    craftingRecipe("wheat", 9, { hay_block: 1 }),
  ]);
  assert.equal(planCraftingFromInventory(bot, [{ ...registry.itemsByName.wheat, count: 4 }]).kind, "planner_failed");
});

test("a requested item that only crafts back out of itself still cannot be planned", () => {
  // Coal only crafts out of a coal block, made of coal: a player mines it (the gatherer relies on this, live 2 October).
  const { bot } = craftingBot({}, true, LOOPING_RECIPES);
  assert.equal(planCraftingFromInventory(bot, [{ ...registry.itemsByName.coal, count: 1 }]).kind, "planner_failed");
});

test("distinguishes an item with no crafting recipe", () => {
  const { bot } = craftingBot({});

  const preparation = planCraftingFromInventory(bot, [{ ...registry.itemsByName.apple, count: 1 }]);

  assert.equal(preparation.kind, "uncraftable");
  assert.deepEqual(preparation.items, ["apple"]);
  assert.equal(preparation.plan.tree, "apple x1");
});

test("returns executable applications in dependency order", () => {
  const { bot } = craftingBot({ oak_log: 1 });
  const target = registry.itemsByName.stick;
  const preparation = planCraftingFromInventory(bot, [{ ...target, count: 4 }]);
  assert.equal(preparation.kind, "ready");

  assert.deepEqual(
    preparation.applications.map(({ recipe }) => registry.items[recipe.result.id].name),
    ["oak_planks", "stick"],
  );
});

test("shares intermediate surplus across requested targets", () => {
  const { bot } = craftingBot({ oak_log: 1 });

  const preparation = planCraftingFromInventory(bot, [
    { ...registry.itemsByName.stick, count: 4 },
    { ...registry.itemsByName.oak_button, count: 1 },
  ]);

  assert.equal(preparation.kind, "ready");
  assert.deepEqual(preparation.plan.requiredMaterials, [{ item: "oak_log", count: 1 }]);
  assert.match(preparation.plan.tree, /stick x4/);
  assert.match(preparation.plan.tree, /oak_button x1/);
});

test("reserves one shared inventory before declaring a batch ready", () => {
  const { bot } = craftingBot({ oak_log: 1 });

  const preparation = planCraftingFromInventory(bot, [
    { ...registry.itemsByName.stick, count: 4 },
    { ...registry.itemsByName.crafting_table, count: 1 },
  ]);

  assert.equal(preparation.kind, "missing_materials");
  assert.deepEqual(preparation.plan.missingMaterials, [{ item: "oak_log", count: 1 }]);
});

test("a first white bed is planned from wool and planks, never by dyeing a bed of another colour", () => {
  // Live 2026-10-04: the plan for Tom's first bed was "3 black_wool, 1 lily_of_the_valley" (a black bed dyed white).
  // The game's recipes: a white bed from white wool, or any bed dyed white; a black bed from black wool.
  const beds = [
    craftingRecipe("white_bed", 1, { black_bed: 1, white_dye: 1 }),
    craftingRecipe("black_bed", 1, { black_wool: 3, oak_planks: 3 }, true),
    craftingRecipe("white_dye", 1, { lily_of_the_valley: 1 }),
    craftingRecipe("white_bed", 1, { white_wool: 3, oak_planks: 3 }, true),
    // Wool from string too: counted as 12 missing string, it made the dyed bed look cheaper (4 missing).
    craftingRecipe("white_wool", 1, { string: 4 }),
  ];
  const { bot } = craftingBot({ oak_planks: 3 }, true, beds);
  const preparation = planCraftingFromInventory(bot, [{ ...registry.itemsByName.white_bed, count: 1 }]);
  assert.equal(preparation.kind, "missing_materials");
  const missing = preparation.plan.missingMaterials.map((material) => material.item);
  assert.ok(!missing.some((item) => /black|lily|dye/u.test(item)), missing.join(", "));
  assert.ok(missing.some((item) => item === "white_wool" || item === "string"), missing.join(", "));
});

/** What the explored world has: chunks that hold each item's sources, by item name (absent = none seen). */
const seenIn = (chunks: Readonly<Record<string, number>>) => (item: string) => chunks[item] ?? 0;

test("carrying nothing, a tie goes to the material the explored world has most of", () => {
  // Run 10: a stone pickaxe planned cobbled_deepslate x3, a block nobody had seen, and Mira dug toward it for 18 minutes.
  const alternatives = [
    craftingRecipe("stone_pickaxe", 1, { cobbled_deepslate: 3, stick: 2 }, true),
    craftingRecipe("stone_pickaxe", 1, { cobblestone: 3, stick: 2 }, true),
  ];
  const { bot } = craftingBot({ oak_planks: 2 }, true, alternatives);
  const pickaxe = [{ ...registry.itemsByName.stone_pickaxe, count: 1 }];
  assert.deepEqual(planCraftingFromInventory(bot, pickaxe).plan.missingMaterials, [{ item: "cobbled_deepslate", count: 3 }]);
  const seen = seenIn({ cobblestone: 40, cobbled_deepslate: 2 });
  assert.deepEqual(planCraftingFromInventory(bot, pickaxe, { seen }).plan.missingMaterials, [{ item: "cobblestone", count: 3 }]);
  // Seen nowhere comes last, even against a material seen in a single chunk.
  const nowhere = seenIn({ cobblestone: 1 });
  assert.deepEqual(planCraftingFromInventory(bot, pickaxe, { seen: nowhere }).plan.missingMaterials, [{ item: "cobblestone", count: 3 }]);
});

test("sticks name a log the explored world has, not the first wood in registry order", () => {
  const { bot } = craftingBot({}, false, TWO_WOODS);
  const sticks = [{ ...registry.itemsByName.stick, count: 1 }];
  assert.deepEqual(planCraftingFromInventory(bot, sticks).plan.missingMaterials, [{ item: "pale_oak_log", count: 1 }]);
  assert.deepEqual(planCraftingFromInventory(bot, sticks, { seen: seenIn({ birch_log: 6 }) }).plan.missingMaterials, [{ item: "birch_log", count: 1 }]);
});

test("what is carried still wins over what the explored world has", () => {
  const { bot } = craftingBot({ pale_oak_log: 1 }, true, TWO_WOODS);
  const table = [{ ...registry.itemsByName.crafting_table, count: 1 }];
  assert.equal(planCraftingFromInventory(bot, table, { seen: seenIn({ birch_log: 50 }) }).kind, "ready");
});

test("the planner follows what is near the bot: stone at the surface, deepslate underground, recorded logs", () => {
  const alternatives = [
    craftingRecipe("stone_pickaxe", 1, { cobbled_deepslate: 3, stick: 2 }, true),
    craftingRecipe("stone_pickaxe", 1, { cobblestone: 3, stick: 2 }, true),
  ];
  const { bot } = craftingBot({ oak_planks: 2 }, true, alternatives);
  const pickaxe = [{ ...registry.itemsByName.stone_pickaxe, count: 1 }];
  const near = (blocks: Record<string, number>) => {
    Object.assign(bot, {
      findBlocks: ({ matching, count }: { matching: number; count: number }) =>
        Array.from({ length: Math.min(count, blocks[registry.blocks[matching]?.name ?? ""] ?? 0) }, () => new Vec3(0, 0, 0)),
    });
    return { seen: seenInWorld(bot, { chunksWithMaterial: () => 0 }) };
  };
  assert.deepEqual(planCraftingFromInventory(bot, pickaxe, near({ stone: 200 })).plan.missingMaterials, [{ item: "cobblestone", count: 3 }]);
  assert.deepEqual(planCraftingFromInventory(bot, pickaxe, near({ deepslate: 200 })).plan.missingMaterials, [{ item: "cobbled_deepslate", count: 3 }]);

  const woods = craftingBot({}, false, TWO_WOODS).bot;
  const sticks = [{ ...registry.itemsByName.stick, count: 1 }];
  Object.assign(woods, { findBlocks: () => [] });
  const recorded = seenInWorld(woods, { chunksWithMaterial: (block) => (block === "birch_log" ? 9 : 0) });
  assert.deepEqual(planCraftingFromInventory(woods, sticks, { seen: recorded }).plan.missingMaterials, [{ item: "birch_log", count: 1 }]);

  const carrying = craftingBot({ cobbled_deepslate: 3, oak_planks: 2 }, true, alternatives);
  Object.assign(carrying.bot, { findBlocks: () => Array.from({ length: 64 }, () => new Vec3(0, 0, 0)) });
  assert.equal(planCraftingFromInventory(carrying.bot, pickaxe, { seen: seenInWorld(carrying.bot, { chunksWithMaterial: () => 0 }) }).kind, "ready");
});

import assert from "node:assert/strict";
import test from "node:test";
import { craftingBot, craftingRecipe } from "../../test-support/crafting.js";
import { formatViewCraftingRequirementsResult, parseViewCraftingRequirementsRequest, viewCraftingRequirements } from "./index.js";

/**
 * Every requirements answer over the same planner, varying only what is carried
 * and what is asked for. Missing materials and an item with no recipe are
 * information, not failures; only an item Minecraft does not have is a failure.
 */
const rows = [
  {
    name: "a shared plan the carried materials already satisfy",
    carried: { oak_log: 1 },
    items: [
      { itemName: "stick", count: 4 },
      { itemName: "oak_button", count: 1 },
    ],
    status: "succeeded",
    planStatus: "ready",
    requiredMaterials: [{ item: "oak_log", count: 1 }],
    carriedMaterials: [{ item: "oak_log", count: 1 }],
    markdown: /stick ×4/,
  },
  {
    name: "materials the bot does not carry",
    carried: {},
    items: [{ itemName: "stone_pickaxe", count: 1 }],
    status: "succeeded",
    planStatus: "missing_materials",
    requiredMaterials: [
      { item: "cobblestone", count: 3 },
      { item: "oak_log", count: 1 },
    ],
    carriedMaterials: [],
    markdown: /Carried leaf materials reserved: none/,
  },
  {
    name: "a known item with no recipe",
    carried: {},
    items: [{ itemName: "apple", count: 1 }],
    status: "succeeded",
    planStatus: "uncraftable",
    requiredMaterials: undefined,
    carriedMaterials: undefined,
    markdown: undefined,
  },
  {
    name: "an item Minecraft does not have",
    carried: {},
    items: [{ itemName: "definitely_not_an_item", count: 1 }],
    status: "failed",
    planStatus: undefined,
    requiredMaterials: undefined,
    carriedMaterials: undefined,
    markdown: /UNKNOWN_CRAFT_ITEMS/,
  },
] as const;

test("reports what a craft batch would need without crafting anything", async () => {
  for (const row of rows) {
    const { bot, craftCalls } = craftingBot({ ...row.carried });
    const result = await viewCraftingRequirements(bot, { items: [...row.items] }, {});

    assert.equal(result.status, row.status, row.name);
    assert.equal(craftCalls.length, 0, `${row.name}: inspection must never craft`);
    if (row.planStatus === undefined) assert.equal(result.requirements.plan, undefined, row.name);
    else assert.equal(result.requirements.plan?.status, row.planStatus, row.name);
    if (row.requiredMaterials) {
      assert.deepEqual(result.requirements.plan?.requiredMaterials, row.requiredMaterials, row.name);
      assert.deepEqual(result.requirements.plan?.carriedMaterials, row.carriedMaterials, row.name);
      assert.equal(
        (result.requirements.plan?.missingMaterials.length ?? 0) > 0,
        row.planStatus === "missing_materials",
        row.name,
      );
    }
    if (row.markdown)
      assert.match(
        result.status === "failed" ? result.error : formatViewCraftingRequirementsResult(result),
        row.markdown,
        row.name,
      );
  }
});

test("prefer names the wood to plan with when none is carried; the parsed request keeps it", async () => {
  const { bot } = craftingBot({}, true, [
    craftingRecipe("oak_planks", 4, { oak_log: 1 }),
    craftingRecipe("birch_planks", 4, { birch_log: 1 }),
    craftingRecipe("stick", 4, { oak_planks: 2 }),
    craftingRecipe("stick", 4, { birch_planks: 2 }),
  ]);
  const ask = (prefer?: string[]) => viewCraftingRequirements(bot, parseViewCraftingRequirementsRequest({ items: [{ item_name: "stick", count: 4 }], ...(prefer && { prefer }) }), {});
  assert.deepEqual((await ask()).requirements.plan?.requiredMaterials, [{ item: "oak_log", count: 1 }]);
  assert.deepEqual((await ask(["birch_log"])).requirements.plan?.requiredMaterials, [{ item: "birch_log", count: 1 }]);
  assert.deepEqual(parseViewCraftingRequirementsRequest({ items: [{ item_name: "stick", count: 1 }] }).prefer, []);
});

test("with nothing carried, the plan names the wood the explored world has", async () => {
  const { bot } = craftingBot({}, true, [
    craftingRecipe("oak_planks", 4, { oak_log: 1 }),
    craftingRecipe("birch_planks", 4, { birch_log: 1 }),
    craftingRecipe("stick", 4, { oak_planks: 2 }),
    craftingRecipe("stick", 4, { birch_planks: 2 }),
  ]);
  const request = parseViewCraftingRequirementsRequest({ items: [{ item_name: "stick", count: 4 }] });
  const seen = (item: string) => (item === "birch_log" ? 7 : 0);
  assert.deepEqual((await viewCraftingRequirements(bot, request, {}, seen)).requirements.plan?.requiredMaterials, [{ item: "birch_log", count: 1 }]);
});

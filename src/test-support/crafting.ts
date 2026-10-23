import assert from "node:assert/strict";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { CarriedCounts } from "./carried-counts.js";
import { type FakeClock, createFakeBot } from "./fake-bot/index.js";
import { letTestsWriteWorldAge } from "./written-world-age.js";

export const craftingRegistry = minecraftData("1.21.4");

type Recipe = ReturnType<Bot["recipesAll"]>[number];

function recipe(
  resultName: string,
  resultCount: number,
  ingredients: Readonly<Record<string, number>>,
  requiresTable = false,
): Recipe {
  const result = craftingRegistry.itemsByName[resultName];
  assert.ok(result, `unknown recipe result ${resultName}`);
  const inputs = Object.entries(ingredients).map(([name, count]) => {
    const item = craftingRegistry.itemsByName[name];
    assert.ok(item, `unknown recipe ingredient ${name}`);
    return { id: item.id, metadata: null, count: -count };
  });
  return {
    result: { id: result.id, metadata: null, count: resultCount },
    ingredients: inputs,
    delta: [...inputs, { id: result.id, metadata: null, count: resultCount }],
    requiresTable,
    inShape: [],
    outShape: [],
  };
}

const RECIPES = [
  recipe("oak_planks", 4, { oak_log: 1 }),
  recipe("stick", 4, { oak_planks: 2 }),
  recipe("oak_button", 1, { oak_planks: 1 }),
  recipe("crafting_table", 1, { oak_planks: 4 }),
  recipe("stone_pickaxe", 1, { cobblestone: 3, stick: 2 }, true),
  recipe("stone_axe", 1, { cobblestone: 3, stick: 2 }, true),
];

export { recipe as craftingRecipe };

/** Where `craftingBot` stands its crafting table when one is available: next to the bot, within reach. */
const TABLE = new Vec3(1, 64, 0);

/**
 * A bot on the shared fake (`harness`) carrying `carried` in its inventory window, with the recipes above and a
 * `craft` that applies a recipe's delta to that window, as the server's slot updates would. `counts` is the window's
 * totals by item id (`CarriedCounts`: a test's `counts.set` rewrites the stacks). `tableAvailable` stands a crafting
 * table next to the bot and `findBlock` answers it. `recipes`: extra recipes offered before the fixture's own, as
 * Mineflayer lists other wood families first. `clock`: the harness's (a mocked one the test drives); given, the world age
 * is the server's own, which only that clock moves.
 */
export function craftingBot(
  carried: Readonly<Record<string, number>>,
  tableAvailable = false,
  recipes: readonly Recipe[] = [],
  { clock }: { readonly clock?: FakeClock } = {},
) {
  const known = [...recipes, ...RECIPES];
  for (const name of Object.keys(carried)) assert.ok(craftingRegistry.itemsByName[name], `unknown test item ${name}`);
  const craftCalls: string[] = [];
  const harness = createFakeBot({
    clock,
    version: craftingRegistry.version.minecraftVersion,
    carried,
    cells: tableAvailable ? { [`${TABLE.x},${TABLE.y},${TABLE.z}`]: "crafting_table" } : {},
    overrides: {
      closeWindow: async () => undefined,
      findBlock: () => (tableAvailable ? harness.world.blockAt(TABLE) : null),
      recipesAll: (itemType, _metadata, craftingTable) =>
        known.filter((candidate) => candidate.result.id === itemType && (!candidate.requiresTable || Boolean(craftingTable))),
      craft: async (selected, applications = 1) => {
        craftCalls.push(craftingRegistry.items[selected.result.id].name);
        for (const item of selected.delta) counts.set(item.id, (counts.get(item.id) ?? 0) + item.count * applications);
      },
    },
  });
  const counts = new CarriedCounts(harness.inventory, harness.bot.registry);
  // Kept for importers that pass no clock, should one move the world age with `startServerClock` (none does after
  // batch M2; see `written-world-age.ts`).
  if (clock === undefined) letTestsWriteWorldAge(harness);
  return { bot: harness.bot, counts, craftCalls, harness };
}

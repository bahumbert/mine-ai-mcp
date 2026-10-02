import type { Bot } from "mineflayer";
import { fuelCapacity, NAMED_FUELS, smeltingData } from "../../world/smelting.js";
import { defineAction, type ActionContext } from "../action.js";
import {
  parseViewSmeltingRecipesRequest,
  VIEW_SMELTING_RECIPES,
  VIEW_SMELTING_RECIPES_DESCRIPTION,
  viewSmeltingRecipesAnnotations,
  viewSmeltingRecipesInputSchema,
  viewSmeltingRecipesOutcomes,
  viewSmeltingRecipesResultSchema,
  type ViewSmeltingRecipesRequest,
  type ViewSmeltingRecipesResult,
} from "./contract.js";

/** Every furnace fuel this version has: the named ones, then each burnable plank, log and wood. */
function fuels(bot: Pick<Bot, "registry">): { item: string; itemsSmelted: number }[] {
  const wooden = Object.keys(bot.registry.itemsByName)
    .filter((name) => /_(planks|log|wood)$/u.test(name) && fuelCapacity(name) > 0)
    .sort();
  return [...NAMED_FUELS.filter((name) => bot.registry.itemsByName[name] !== undefined), ...wooden]
    .map((item) => ({ item, itemsSmelted: fuelCapacity(item) }));
}

/** The furnace recipes making each requested item, from the data shipped for the bot's version. */
export async function viewSmeltingRecipes(
  bot: Pick<Bot, "registry" | "version">,
  request: ViewSmeltingRecipesRequest,
  context: ActionContext,
): Promise<ViewSmeltingRecipesResult> {
  context.signal?.throwIfAborted();
  const data = smeltingData(bot.version);
  const unknown = request.items.filter((item) => bot.registry.itemsByName[item] === undefined);
  const smelting = {
    version: bot.version,
    dataVersion: data?.version ?? null,
    items: request.items
      .filter((item) => !unknown.includes(item))
      .map((item) => ({ item, recipes: (data?.recipes ?? []).filter((recipe) => recipe.output === item).map((recipe) => ({ ...recipe, inputs: [...recipe.inputs] })) })),
    fuels: fuels(bot),
  };
  if (unknown.length > 0) return { status: "failed", error: viewSmeltingRecipesOutcomes.unknownItems(unknown), smelting };
  if (data === null) return { status: "failed", error: viewSmeltingRecipesOutcomes.dataUnavailable(bot.version), smelting };
  return { status: "succeeded", smelting };
}

export function formatViewSmeltingRecipesResult(result: ViewSmeltingRecipesResult): string {
  const { smelting } = result;
  const lines = result.status === "succeeded" ? [] : [`**Observed stop:** ${result.error}`];
  for (const { item, recipes } of smelting.items) {
    lines.push(recipes.length === 0
      ? `- ${item}: no furnace recipe`
      : `- ${item}: ${recipes.map((recipe) => `one of ${recipe.inputs.join(", ")} → ${recipe.count} (${recipe.cookingTicks} ticks)`).join("; ")}`);
  }
  lines.push(`- Fuels (items smelted each): ${smelting.fuels.map(({ item, itemsSmelted }) => `${item} ${itemsSmelted}`).join(", ")}`);
  return lines.join("\n");
}

export function createViewSmeltingRecipesAction(bot: Bot) {
  return defineAction({
    name: VIEW_SMELTING_RECIPES,
    description: VIEW_SMELTING_RECIPES_DESCRIPTION,
    inputSchema: viewSmeltingRecipesInputSchema,
    resultSchema: viewSmeltingRecipesResultSchema,
    formatResult: formatViewSmeltingRecipesResult,
    execution: { kind: "information" },
    annotations: viewSmeltingRecipesAnnotations,
    parse: parseViewSmeltingRecipesRequest,
    execute: (request, context) => viewSmeltingRecipes(bot, request, context),
  });
}

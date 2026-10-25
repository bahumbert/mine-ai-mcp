import type { Bot } from "mineflayer";
import { fuelsOf, smeltingData } from "../../world/smelting.js";
import { withSimilar } from "../../world/similar-names.js";
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
    fuels: fuelsOf(Object.keys(bot.registry.itemsByName), bot.version),
  };
  if (unknown.length > 0) {
    const names = Object.keys(bot.registry.itemsByName);
    return { status: "failed", error: viewSmeltingRecipesOutcomes.unknownItems(unknown.map((item) => withSimilar(item, names))), smelting };
  }
  if (data === null) return { status: "failed", error: viewSmeltingRecipesOutcomes.dataUnavailable(bot.version), smelting };
  return { status: "succeeded", smelting };
}

/** How many fuels of one worth are named in the line; the rest are counted (the evidence holds them all). */
const FUEL_EXAMPLES = 3;

/** `worth: examples and n more` for each worth, the largest first: a long list of planks, doors and signs is not what a model needs to pick a fuel. */
function fuelsLine(fuels: readonly { item: string; itemsSmelted: number }[]): string {
  const byWorth = new Map<number, string[]>();
  for (const { item, itemsSmelted } of fuels) byWorth.set(itemsSmelted, [...(byWorth.get(itemsSmelted) ?? []), item]);
  const groups = [...byWorth].sort(([a], [b]) => b - a).map(([worth, items]) =>
    `${worth}: ${items.slice(0, FUEL_EXAMPLES).join(", ")}${items.length > FUEL_EXAMPLES ? ` and ${items.length - FUEL_EXAMPLES} more` : ""}`);
  return `- Fuels (items smelted each): ${groups.join("; ")}`;
}

export function formatViewSmeltingRecipesResult(result: ViewSmeltingRecipesResult): string {
  const { smelting } = result;
  const lines = result.status === "succeeded" ? [] : [`**Observed stop:** ${result.error}`];
  for (const { item, recipes } of smelting.items) {
    lines.push(recipes.length === 0
      ? `- ${item}: no furnace recipe`
      : `- ${item}: ${recipes.map((recipe) => `one of ${recipe.inputs.join(", ")} → ${recipe.count} (${recipe.cookingTicks} ticks)`).join("; ")}`);
  }
  lines.push(fuelsLine(smelting.fuels));
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

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";
import { registryNameSchema } from "../registry-name.js";

export const VIEW_SMELTING_RECIPES = "view_smelting_recipes" as const;
export const VIEW_SMELTING_RECIPES_DESCRIPTION =
  "List the furnace recipes that make each requested item (which inputs cook into it, and how long), and the fuels a furnace burns with how many items one of each smelts. Recipes come from the game's own data for this version; reads nothing in the world and changes nothing.";

/** How many items one call looks up. */
export const MAX_SMELTING_ITEMS = 16;

export const viewSmeltingRecipesInputSchema = z.strictObject({
  items: z
    .array(registryNameSchema)
    .min(1)
    .max(MAX_SMELTING_ITEMS)
    .describe("Item registry names to look up as furnace outputs, such as glass or iron_ingot."),
});

export interface ViewSmeltingRecipesRequest {
  readonly items: readonly string[];
}

export function parseViewSmeltingRecipesRequest(input: unknown): ViewSmeltingRecipesRequest {
  return { items: [...new Set(viewSmeltingRecipesInputSchema.parse(input ?? {}).items)] };
}

const recipeSchema = z.strictObject({
  output: z.string(),
  count: z.number().int().positive(),
  inputs: z.array(z.string()).min(1),
  cookingTicks: z.number().int().positive(),
});

const fuelSchema = z.strictObject({
  item: z.string(),
  itemsSmelted: z.number().positive(),
});

export const smeltingRecipesEvidenceSchema = z.strictObject({
  version: z.string(),
  /** The shipped data version used, which may be an older one than the server's; null when none fits. */
  dataVersion: z.string().nullable(),
  items: z.array(z.strictObject({ item: z.string(), recipes: z.array(recipeSchema) })),
  fuels: z.array(fuelSchema),
});

export const viewSmeltingRecipesResultSchema = actionResultSchema({
  smelting: smeltingRecipesEvidenceSchema,
});

export type SmeltingRecipesEvidence = z.output<typeof smeltingRecipesEvidenceSchema>;
export type ViewSmeltingRecipesResult = z.output<typeof viewSmeltingRecipesResultSchema>;
export type ViewSmeltingRecipesOutput = ActionOutput<typeof VIEW_SMELTING_RECIPES, ViewSmeltingRecipesResult>;

export const viewSmeltingRecipesAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} satisfies ToolAnnotations;

export const viewSmeltingRecipesOutcomes = {
  unknownItems: (items: readonly string[]) =>
    `[UNKNOWN_SMELT_ITEMS] Minecraft has no registry items named: ${items.join(", ")}.`,
  dataUnavailable: (version: string) =>
    `[SMELTING_DATA_UNAVAILABLE] No smelting recipe data ships for Minecraft ${version} or any older version.`,
} as const;

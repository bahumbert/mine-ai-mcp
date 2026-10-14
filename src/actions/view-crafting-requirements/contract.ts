import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";
import {
  craftPlanEvidenceSchema,
  craftingRequestInputSchema,
  parseCraftingRequest,
  type CraftingRequest,
} from "../crafting.js";

export const VIEW_CRAFTING_REQUIREMENTS = "view_crafting_requirements" as const;
export const VIEW_CRAFTING_REQUIREMENTS_DESCRIPTION =
  "Inspect one shared recursive crafting plan for every requested item. Reports selected recipe trees, carried materials, missing leaf materials, and crafting-table requirements without crafting anything. " +
  "Where recipes accept several materials (any wood's planks for sticks, a table or wooden tools) and none is carried, prefer names the ones to plan with, in order, e.g. the logs that grow nearby; otherwise the first in registry order is named.";

/** Preferred materials one request may name: every wood and a few more. */
export const MAX_PREFERRED_MATERIALS = 32;

export const viewCraftingRequirementsInputSchema = craftingRequestInputSchema.extend({
  prefer: z
    .array(z.string().min(1))
    .max(MAX_PREFERRED_MATERIALS)
    .optional()
    .describe("Materials to plan with, in order, where recipes accept several and none is carried (e.g. nearby logs)."),
});
export interface ViewCraftingRequirementsRequest extends CraftingRequest {
  readonly prefer?: readonly string[];
}
export function parseViewCraftingRequirementsRequest(input: unknown): ViewCraftingRequirementsRequest {
  const { prefer, ...rest } = viewCraftingRequirementsInputSchema.parse(input ?? {});
  return { ...parseCraftingRequest(rest), prefer: prefer ?? [] };
}

const requestedItemSchema = z.strictObject({
  item: z.string(),
  count: z.number().int().positive(),
});

export const craftingRequirementsEvidenceSchema = z.strictObject({
  items: z.array(requestedItemSchema).min(1),
  plan: craftPlanEvidenceSchema.optional(),
});

export const viewCraftingRequirementsResultSchema = actionResultSchema({
  requirements: craftingRequirementsEvidenceSchema,
});

export type ViewCraftingRequirementsResult = z.output<typeof viewCraftingRequirementsResultSchema>;
export type ViewCraftingRequirementsOutput = ActionOutput<
  typeof VIEW_CRAFTING_REQUIREMENTS,
  ViewCraftingRequirementsResult
>;

export const viewCraftingRequirementsAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} satisfies ToolAnnotations;

export const viewCraftingRequirementsOutcomes = {
  unknownItems: (items: readonly string[]) =>
    `[UNKNOWN_CRAFT_ITEMS] Minecraft has no registry items named: ${items.join(", ")}.`,
  plannerFailed: (items: readonly string[]) =>
    `[CRAFT_PLAN_UNAVAILABLE] The recursive planner found recipes but could not produce concrete plans for: ${items.join(", ")}.`,
} as const;

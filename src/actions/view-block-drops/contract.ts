import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";
import { registryNameSchema } from "../registry-name.js";

export const VIEW_BLOCK_DROPS = "view_block_drops" as const;
export const VIEW_BLOCK_DROPS_DESCRIPTION =
  "List which blocks an ordinary break by hand gathers each requested item from (with how often one break yields it, wild blocks before crops someone planted), and everything each requested block drops (with the tool or block state a drop needs, such as shears, silk touch, or a crop's ripe age). Drops come from the game's own loot tables for this version; reads nothing in the world and changes nothing.";

/** How many names one call looks up, per list. */
export const MAX_DROP_NAMES = 16;

export const viewBlockDropsInputSchema = z.strictObject({
  items: z
    .array(registryNameSchema)
    .max(MAX_DROP_NAMES)
    .optional()
    .describe("Item registry names to find the blocks of, such as wheat_seeds or raw_iron."),
  blocks: z
    .array(registryNameSchema)
    .max(MAX_DROP_NAMES)
    .optional()
    .describe("Block registry names to list the drops of, such as gravel or wheat."),
});

export interface ViewBlockDropsRequest {
  readonly items: readonly string[];
  readonly blocks: readonly string[];
}

export function parseViewBlockDropsRequest(input: unknown): ViewBlockDropsRequest {
  const value = viewBlockDropsInputSchema.parse(input ?? {});
  const request = { items: [...new Set(value.items ?? [])], blocks: [...new Set(value.blocks ?? [])] };
  if (request.items.length + request.blocks.length === 0) throw new Error("Give items or blocks to look up.");
  return request;
}

const dropSchema = z.strictObject({
  item: z.string(),
  chance: z.number().positive().max(1),
  tool: z.string().optional(),
  state: z.record(z.string(), z.string()).optional(),
});

const sourceSchema = z.strictObject({
  block: z.string(),
  chance: z.number().positive().max(1),
  planted: z.boolean(),
});

export const blockDropsEvidenceSchema = z.strictObject({
  version: z.string(),
  /** The shipped data version used, which may be an older one than the server's; null when none fits. */
  dataVersion: z.string().nullable(),
  items: z.array(z.strictObject({ item: z.string(), sources: z.array(sourceSchema) })),
  blocks: z.array(z.strictObject({ block: z.string(), drops: z.array(dropSchema) })),
});

export const viewBlockDropsResultSchema = actionResultSchema({
  drops: blockDropsEvidenceSchema,
});

export type BlockDropsEvidence = z.output<typeof blockDropsEvidenceSchema>;
export type ViewBlockDropsResult = z.output<typeof viewBlockDropsResultSchema>;
export type ViewBlockDropsOutput = ActionOutput<typeof VIEW_BLOCK_DROPS, ViewBlockDropsResult>;

export const viewBlockDropsAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} satisfies ToolAnnotations;

export const viewBlockDropsOutcomes = {
  unknownNames: (names: readonly string[]) =>
    `[UNKNOWN_DROP_NAMES] Minecraft has no registry items or blocks named: ${names.join(", ")}.`,
  dataUnavailable: (version: string) =>
    `[DROP_DATA_UNAVAILABLE] No block drop data ships for Minecraft ${version} or any older version.`,
} as const;

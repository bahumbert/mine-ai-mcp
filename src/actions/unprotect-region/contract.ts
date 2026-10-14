import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema } from "../action.js";
import { protectedRegionSchema } from "../protect-region/contract.js";

export const UNPROTECT_REGION = "unprotect_region" as const;
export const UNPROTECT_REGION_DESCRIPTION =
  "Remove one protected region by its region_id (from protect_region or main.protected_regions), so routes and " +
  "collect_block may dig and place blocks there again. Runs beside the foreground action.";

export const unprotectRegionInputSchema = z.strictObject({
  region_id: z.number().int().positive().describe("The region to remove."),
});

export interface UnprotectRegionRequest {
  readonly regionId: number;
}

export function parseUnprotectRegionRequest(input: unknown): UnprotectRegionRequest {
  return { regionId: unprotectRegionInputSchema.parse(input).region_id };
}

export const unprotectRegionResultSchema = actionResultSchema({ region: protectedRegionSchema.nullable() });
export type UnprotectRegionResult = z.output<typeof unprotectRegionResultSchema>;

export const unprotectRegionAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} satisfies ToolAnnotations;

export const unprotectRegionOutcomes = {
  notFound: (regionId: number) => `[REGION_NOT_FOUND] There is no protected region #${regionId}.`,
} as const;

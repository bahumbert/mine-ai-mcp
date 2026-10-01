import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MAX_PROTECTED_REGIONS, MAX_REGION_SIDE } from "../../bot-data/protected-regions.js";
import type { BlockCorner } from "../../world/protected-regions.js";
import { actionResultSchema } from "../action.js";

export const PROTECT_REGION = "protect_region" as const;
/** A centre and radius must still fit the side limit. */
export const MAX_REGION_RADIUS = Math.floor((MAX_REGION_SIDE - 1) / 2);

export const PROTECT_REGION_DESCRIPTION =
  "Protect a box of blocks in the current dimension from this bot's own digging and scaffolding. Every route " +
  "(navigate, collect_block, explore_frontier, collect_mob_drop, automatic survival responses) refuses to break or place " +
  "a block inside it and collect_block never takes a block inside it; walking through and opening doors stay allowed. " +
  "build_structure still works inside regions this bot owns, and refuses cells in regions someone else owns. " +
  `Give corner_a and corner_b, or center and radius; each side is at most ${MAX_REGION_SIDE} blocks and at most ` +
  `${MAX_PROTECTED_REGIONS} regions exist. Protecting the same box for the same owner again returns the existing region. ` +
  "Regions persist with bot data (main.protected_regions); remove one with unprotect_region. Runs beside the foreground action.";

const blockSchema = z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() });

export const protectRegionInputSchema = z.strictObject({
  corner_a: blockSchema.optional().describe("One corner of the box, inclusive; give corner_b with it."),
  corner_b: blockSchema.optional().describe("The opposite corner, inclusive."),
  center: blockSchema.optional().describe("The box's centre block; give radius with it instead of corners."),
  radius: z
    .number()
    .int()
    .min(0)
    .max(MAX_REGION_RADIUS)
    .optional()
    .describe(`Blocks from the centre to each face, 0-${MAX_REGION_RADIUS}.`),
  owner: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .optional()
    .describe("Whose build this is: a player's name. Omit it for this bot's own build."),
  label: z.string().trim().min(1).max(80).describe("A short name, e.g. \"Tom's house\"."),
  reason: z.string().trim().min(1).max(240).describe("Why, in your own words. Stored with the region."),
});

export interface ProtectRegionRequest {
  readonly min: BlockCorner;
  readonly max: BlockCorner;
  /** Null: the bot's own. */
  readonly owner: string | null;
  readonly label: string;
  readonly reason: string;
}

export function parseProtectRegionRequest(input: unknown): ProtectRegionRequest {
  const parsed = protectRegionInputSchema.parse(input);
  const cornered = parsed.corner_a !== undefined || parsed.corner_b !== undefined;
  const centred = parsed.center !== undefined || parsed.radius !== undefined;
  if (cornered === centred) throw new Error("protect_region needs either corner_a and corner_b, or center and radius.");
  let a: BlockCorner;
  let b: BlockCorner;
  if (cornered) {
    if (parsed.corner_a === undefined || parsed.corner_b === undefined) {
      throw new Error("protect_region needs both corner_a and corner_b.");
    }
    a = parsed.corner_a;
    b = parsed.corner_b;
  } else {
    if (parsed.center === undefined || parsed.radius === undefined) {
      throw new Error("protect_region needs both center and radius.");
    }
    const { center, radius } = parsed;
    a = { x: center.x - radius, y: center.y - radius, z: center.z - radius };
    b = { x: center.x + radius, y: center.y + radius, z: center.z + radius };
  }
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
    owner: parsed.owner ?? null,
    label: parsed.label,
    reason: parsed.reason,
  };
}

export const protectedRegionSchema = z.strictObject({
  regionId: z.number().int().positive(),
  dimension: z.string().min(1),
  min: blockSchema,
  max: blockSchema,
  owner: z.string().min(1),
  label: z.string().min(1),
});

export const protectRegionResultSchema = actionResultSchema({
  region: protectedRegionSchema.nullable(),
  /** False when the same box was already protected for the same owner. */
  created: z.boolean(),
});
export type ProtectRegionResult = z.output<typeof protectRegionResultSchema>;

export const protectRegionAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} satisfies ToolAnnotations;

export const protectRegionOutcomes = {
  tooLarge: (side: number) => `[REGION_TOO_LARGE] A side of ${side} blocks is over the ${MAX_REGION_SIDE}-block limit.`,
  limitReached: () => `[REGION_LIMIT_REACHED] ${MAX_PROTECTED_REGIONS} regions are already protected; unprotect one first.`,
} as const;

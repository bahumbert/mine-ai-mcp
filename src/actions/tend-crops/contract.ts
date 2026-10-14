import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";
import { registryNameSchema } from "../registry-name.js";

export const TEND_CROPS = "tend_crops" as const;
export const TEND_CROPS_DESCRIPTION =
  "Farm a rectangle of soil the way a player does, cell by cell, walking into reach: harvest ripe crops (ripe by the game's loot tables) and pick up what they drop, break short grass and flowers standing on the soil, till soil with the best carried hoe, and plant empty farmland with `plant`, or, without it, a cell harvested in this call with that crop's own seed when carried. Unripe crops are left growing. Water, leveling and fences are the caller's: a cell that is not soil is reported, not changed. Its own routes never dig farmland or crops. Reports what each cell became, the cells skipped and why, and the plot afterwards: crops by age, empty and dry farmland, water. A run where no cell changes for 180 s stops and says so.";

/** At most 16 x 16 cells per call, like `build_structure`'s 256. */
export const MAX_TEND_SIDE = 16;
/** How long a run may go without changing any cell before it settles with what it did. */
export const TEND_STALL_MS = 180_000;

const coordinate = (axis: string) => z.number().int().safe().describe(`Absolute ${axis} coordinate of a plot corner.`);

export const tendCropsInputSchema = z.strictObject({
  x1: coordinate("X"),
  z1: coordinate("Z"),
  x2: coordinate("X"),
  z2: coordinate("Z"),
  y: z.number().int().safe().describe("The soil level: the Y of the dirt or farmland, crops grow at y + 1."),
  plant: registryNameSchema.optional().describe("Item to plant on empty farmland, such as wheat_seeds, carrot or potato."),
  harvest: z.boolean().default(true).describe("Harvest ripe crops (false leaves them standing)."),
  till: z.boolean().default(true).describe("Till soil into farmland with a carried hoe."),
});

export interface TendCell {
  readonly x: number;
  readonly z: number;
}

export interface TendCropsRequest {
  readonly min: TendCell;
  readonly max: TendCell;
  readonly y: number;
  readonly plant: string | null;
  readonly harvest: boolean;
  readonly till: boolean;
}

export function parseTendCropsRequest(input: unknown): TendCropsRequest {
  const value = tendCropsInputSchema.parse(input ?? {});
  const min = { x: Math.min(value.x1, value.x2), z: Math.min(value.z1, value.z2) };
  const max = { x: Math.max(value.x1, value.x2), z: Math.max(value.z1, value.z2) };
  const width = max.x - min.x + 1;
  const depth = max.z - min.z + 1;
  if (width > MAX_TEND_SIDE || depth > MAX_TEND_SIDE) throw new Error(tendCropsOutcomes.tooLarge(width, depth));
  return { min, max, y: value.y, plant: value.plant ?? null, harvest: value.harvest, till: value.till };
}

const cellSchema = z.strictObject({ x: z.number().int(), z: z.number().int() });

export const tendEvidenceSchema = z.strictObject({
  cells: z.number().int().nonnegative(),
  harvested: z.number().int().nonnegative(),
  cleared: z.number().int().nonnegative(),
  tilled: z.number().int().nonnegative(),
  planted: z.number().int().nonnegative(),
  /** Items the inventory gained during the call (harvest drops picked up), less what was planted. */
  gained: z.record(z.string(), z.number().int()),
  /** Cells left as they were, by reason. */
  skipped: z.record(z.string(), z.array(cellSchema)),
  /** Drops left on the ground it could not pick up (a full inventory, no route), by item name. */
  dropsLeft: z.array(z.string()),
  after: z.strictObject({
    /** Crops standing on the plot, by `<block> age <n>` (`ripe` appended when ripe). */
    crops: z.record(z.string(), z.number().int().nonnegative()),
    emptyFarmland: z.number().int().nonnegative(),
    /** Farmland not hydrated (moisture below 7): crops on it grow slowly and bare farmland turns back to dirt. */
    dryFarmland: z.number().int().nonnegative(),
    water: z.number().int().nonnegative(),
  }),
});

export const tendCropsResultSchema = actionResultSchema({ tended: tendEvidenceSchema });

export type TendEvidence = z.output<typeof tendEvidenceSchema>;
export type TendCropsResult = z.output<typeof tendCropsResultSchema>;
export type TendCropsOutput = ActionOutput<typeof TEND_CROPS, TendCropsResult>;

export const tendCropsAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} satisfies ToolAnnotations;

export const tendCropsOutcomes = {
  tooLarge: (width: number, depth: number) =>
    `[TEND_TOO_LARGE] The plot is ${width} x ${depth}; at most ${MAX_TEND_SIDE} x ${MAX_TEND_SIDE} cells per call.`,
  noHoe: (cells: number) => `[TEND_NO_HOE] ${cells} cell${cells === 1 ? "" : "s"} need tilling and no hoe is carried.`,
  plantMissing: (item: string) => `[TEND_PLANT_MISSING] No ${item} is carried to plant.`,
  stalled: (seconds: number, walked: number) =>
    `[TEND_STALLED] No cell changed for ${seconds} s (walked ${walked} blocks meanwhile).`,
  incomplete: (skipped: number) =>
    `[TEND_INCOMPLETE] ${skipped} cell${skipped === 1 ? "" : "s"} could not be farmed; see skipped.`,
} as const;

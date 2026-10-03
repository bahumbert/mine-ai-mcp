import { FACING_VECTOR, type Position } from "../building/blueprint.ts";
import { facingToward } from "../building/plan.ts";

/** Odd sizes, so the water sits in the middle: 9 x 9 keeps every cell within 4 blocks of it, all hydrated. */
export const FARM_SIZES = [3, 5, 7, 9] as const;
export type FarmSize = (typeof FARM_SIZES)[number];

/** Blocks between the character's feet and the plot's near edge: one free row, so she starts off the plot. */
const PLOT_GAP = 2;

/** One farm: a square of soil at `centre.y` around a single water cell, the way a player starts a wheat farm. */
export interface FarmPlot {
  /** The middle cell, at soil level; the water goes there. */
  readonly centre: Position;
  readonly water: Position;
  readonly size: FarmSize;
  readonly min: { readonly x: number; readonly z: number };
  readonly max: { readonly x: number; readonly z: number };
}

export function farmPlot(centre: Position, size: FarmSize): FarmPlot {
  const half = (size - 1) / 2;
  const middle = { x: Math.floor(centre.x), y: Math.floor(centre.y), z: Math.floor(centre.z) };
  return {
    centre: middle,
    water: middle,
    size,
    min: { x: middle.x - half, z: middle.z - half },
    max: { x: middle.x + half, z: middle.z + half },
  };
}

/**
 * A new farm right behind the character, away from the player it is for (or south without one), as a house is
 * placed: the asker never stands on it. Its soil is the ground she stands on. The site is not surveyed (backlog).
 */
export function plotBehind(bot: Position, toward: Position | null, size: FarmSize): FarmPlot {
  const [fx, fz] = FACING_VECTOR[facingToward(bot, toward)];
  const distance = PLOT_GAP + (size - 1) / 2;
  const feet = { x: Math.floor(bot.x), y: Math.floor(bot.y), z: Math.floor(bot.z) };
  return farmPlot({ x: feet.x - fx * distance, y: feet.y - 1, z: feet.z - fz * distance }, size);
}

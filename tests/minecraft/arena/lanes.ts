/** Lane geometry: where lane k puts a scenario's arena on a shared server, and the box that lane owns. */
import type { ArenaOffset } from "./frame.ts";

/**
 * Blocks between two lanes along z. The widest arena reaches 88 blocks from its origin and a bot sees 8 chunks (128
 * blocks), so the next arena starts beyond anything a bot of this lane can see or simulate (spec "Lane geometry").
 */
export const LANE_SPACING = 512;

/** The box one lane owns: the arena, its scratch copy (Mine Labs parks it at +X) and the full build height. */
export interface LaneCell {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface Lane {
  readonly index: number;
  readonly offset: ArenaOffset;
  readonly cell: LaneCell;
}

/** Lane 0 stays at offset zero for refused scenarios on a server of their own, so shared lanes start at 1. */
export function laneOf(index: number): Lane {
  if (!Number.isInteger(index) || index < 1) throw new RangeError(`lane index ${index} is not a shared lane: lanes start at 1`);
  const z = index * LANE_SPACING;
  return {
    index,
    offset: { x: 0, z },
    cell: { minX: -512, maxX: 1535, minZ: z - LANE_SPACING / 2, maxZ: z + LANE_SPACING / 2 - 1 },
  };
}

/**
 * The block where a lane's repeating command blocks stand: inside its cell, at x -496, west of every arena (arenas
 * reach x -100 at most), 16 blocks inside the cell's lower z edge.
 */
export function controlChunkOf(lane: Lane): { readonly x: number; readonly z: number } {
  return { x: -496, z: lane.cell.minZ + 16 };
}

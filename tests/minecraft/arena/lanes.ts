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

/** A body number is written in base 36 on this many characters in the player's name (`playerRenames`). */
export const BODY_DIGITS = 3;

/** `zzz`: the last body a lane can hand out before its names would repeat. */
export const LAST_BODY = 36 ** BODY_DIGITS - 1;

export interface Lane {
  readonly index: number;
  /**
   * Which player body of this lane the trial uses: 0 for the first trial of the lane on a server, 1 for the next. The
   * server keeps a player's data by name, so a body that was used before brings back its air, hotbar slot, fall distance...
   */
  readonly body: number;
  readonly offset: ArenaOffset;
  readonly cell: LaneCell;
}

/** Lane 0 stays at offset zero for refused scenarios on a server of their own, so shared lanes start at 1. */
export function laneOf(index: number, body = 0): Lane {
  if (!Number.isInteger(index) || index < 1) throw new RangeError(`lane index ${index} is not a shared lane: lanes start at 1`);
  if (!Number.isInteger(body) || body < 0 || body > LAST_BODY) throw new RangeError(`lane body ${body} is not between 0 and ${LAST_BODY}`);
  const z = index * LANE_SPACING;
  return {
    index,
    body,
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

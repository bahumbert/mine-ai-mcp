/**
 * How a Minecraft player decelerates once its input is released.
 *
 * A fact about the game, not about navigation: both the route executor's
 * movement controllers and direct local steering need it to know when to stop
 * asking for forward motion, so it lives beside the other world facts rather
 * than inside either owner.
 */
import type { Position3 } from "../utils/index.js";

/** Ticks of coasting a released input takes to bleed off. */
export const COAST_TICKS = 2;

/** Half the player's 0.6-block collision width: a cell centre closer than this is under the body, not ahead of it. */
export const PLAYER_HALF_WIDTH = 0.3;

/** Height of a standing player in blocks. */
export const PLAYER_STANDING_HEIGHT = 1.8;

/** Every block column strictly overlapped by the player's collision footprint. */
export function* footprintColumns(feet: Position3): Generator<{ x: number; z: number }> {
  for (let x = Math.floor(feet.x - PLAYER_HALF_WIDTH); x < feet.x + PLAYER_HALF_WIDTH; x++)
    for (let z = Math.floor(feet.z - PLAYER_HALF_WIDTH); z < feet.z + PLAYER_HALF_WIDTH; z++) yield { x, z };
}

/**
 * Whether the block at `cell` carries the body standing on it: the footprint (feet.x and feet.z plus or minus
 * {@link PLAYER_HALF_WIDTH}) overlaps the cell's column, and no other column it overlaps holds a body-carrying block at
 * the cell's height, so removing the cell would drop the body. The caller has already checked that the feet stand at
 * the cell's top. Overlap is strict: a footprint that only touches the boundary is not on the column. The centre of the
 * feet is not the question: a centre over a drop with the body on the step's edge still stands on the step (plan
 * 2026-11-15-p4-34-cleanup-footprint, 16 probe runs of rc-lava/probe-15runs.log: 4 of 4 fell when the cleanup dug it).
 * `columnCarriesBodyAt` reads the block's own geometry for the caller (the navigation observation's `safeSupport`).
 */
export function footprintStandsOnCell(
  feet: Position3,
  cell: Position3,
  columnCarriesBodyAt: (x: number, y: number, z: number) => boolean,
): boolean {
  const lowX = feet.x - PLAYER_HALF_WIDTH;
  const highX = feet.x + PLAYER_HALF_WIDTH;
  const lowZ = feet.z - PLAYER_HALF_WIDTH;
  const highZ = feet.z + PLAYER_HALF_WIDTH;
  if (!(highX > cell.x && lowX < cell.x + 1 && highZ > cell.z && lowZ < cell.z + 1)) return false;
  for (const { x, z } of footprintColumns(feet)) {
    if (x === cell.x && z === cell.z) continue;
    if (columnCarriesBodyAt(x, cell.y, z)) return false;
  }
  return true;
}

/**
 * Ticks of horizontal travel left in an airborne body, per block per tick of
 * speed. Off the ground there is no block friction, only the 0.91 inertia
 * prismarine-physics applies each tick, so the remaining travel is
 * v × 0.91 / (1 − 0.91) ≈ 10 v: a body sliding down a vine at 0.08 a tick
 * drifted a whole cell sideways and out of the column on that alone.
 */
export const AIR_COAST_TICKS = 10;

/**
 * How far the bot travels after its inputs are released.
 *
 * This replaced a per-movement constant table — 1.4 for `sprint_jump`, 0.8 for
 * `parkour`, 0.5 for everything else — which was this function with the
 * velocity taken out and the answer guessed per movement kind. The guesses were
 * not bad, because a movement kind is a decent proxy for how fast it usually
 * goes, but a kind cannot know that this particular crossing was entered slowly
 * or that the run-up was cut short. Reassuringly, feeding typical speeds
 * through here reproduces the old table to within a few hundredths.
 */
export function stoppingDistance(velocity: Position3): number {
  return Math.hypot(velocity.x, velocity.z) * COAST_TICKS;
}

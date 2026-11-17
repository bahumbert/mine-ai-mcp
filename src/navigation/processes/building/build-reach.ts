/**
 * How far a build can work a cell, from the eye instead of the feet-to-cell distance it used to ask. The server's own
 * test is wider (spike 2026-11-16, plan 2026-11-14-house-build-fixes-2 Task 1, facts `houses.md` "Roof scaffold spike":
 * a placement 4.517 from the eye to the cell's box, 5.33 to the clicked support's box, was accepted, 4.866 / 5.628 refused;
 * the attribute `player.block_interaction_range` reads 4.5): asking the cell's own box within that range of the eye is the
 * stricter, measured-safe side of it. Unmeasured: the eye up to 0.7 off the cell centre, and the eye while sneaking (the
 * placement sneaks; the spike's probe did not). One test, three users: the
 * in-reach work (`BuildTargeting.reaches`), the route's goal for a cell (`reachGoal`) and the stand columns for the cells the
 * ground cannot serve (`coverWithColumns`). `brain/` mirrors `withinBlockReach` and `coverWithColumns`
 * (`brain/src/building/stand-columns.ts`, which does not import `src/`).
 */
import type { Bot } from "mineflayer";
import { STANDING_EYE_HEIGHT } from "../../../world/block-visibility.js";
import {
  ASCENT_TICKS_PER_BLOCK,
  DESCENT_TICKS_PER_BLOCK,
  HORIZONTAL_TICKS_PER_BLOCK,
  customGoal,
  type BlockPosition,
  type Goal,
} from "../../index.js";

/** Minecraft 1.21.4's survival block interaction range, used when the bot has no attribute (the fake and a fresh login). */
export const DEFAULT_BLOCK_RANGE = 4.5;

/** The attribute key Mineflayer keeps on `bot.entity.attributes` for 1.21.4 (`entities.js` `updateAttributes`; probe trace). */
const RANGE_ATTRIBUTE = "player.block_interaction_range";

/** A point in space, as the eye is. */
export interface Point {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A column the bot could stand on top of: the cell column, and the most blocks it may be pillared up before it is blocked. */
export interface StandColumn {
  readonly x: number;
  readonly z: number;
  readonly maxHeight: number;
}

/** A column chosen to stand on, with the blocks it takes: its top is the feet level `ground + height`. */
export interface ChosenColumn {
  readonly x: number;
  readonly z: number;
  readonly height: number;
}

/** The block interaction range of this bot: its attribute when it has a number there, else the vanilla range. */
export function blockRangeOf(bot: Bot): number {
  const attributes = (bot.entity as { attributes?: Record<string, { value?: unknown } | undefined> }).attributes;
  const value = attributes?.[RANGE_ATTRIBUTE]?.value;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_BLOCK_RANGE;
}

/** The eye of a bot whose feet are in `feet`'s cell: over the middle of the cell, one standing eye height up. */
export function eyeOver(feet: BlockPosition): Point {
  return { x: feet.x + 0.5, y: feet.y + STANDING_EYE_HEIGHT, z: feet.z + 0.5 };
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** The offset from `eye` to the nearest point of the cell's box on each axis (zero where the eye is within the box's span). */
function offsetToBox(eye: Point, cell: BlockPosition): Point {
  return {
    x: clamp(eye.x, cell.x, cell.x + 1) - eye.x,
    y: clamp(eye.y, cell.y, cell.y + 1) - eye.y,
    z: clamp(eye.z, cell.z, cell.z + 1) - eye.z,
  };
}

function boxDistance(eye: Point, cell: BlockPosition): number {
  const offset = offsetToBox(eye, cell);
  return Math.sqrt(offset.x * offset.x + offset.y * offset.y + offset.z * offset.z);
}

/** Whether the server would take a placement or a dig at this cell from this eye: the nearest point of its box within `range`. */
export function withinBlockReach(eye: Point, cell: BlockPosition, range: number): boolean {
  return boxDistance(eye, cell) <= range;
}

/**
 * Stand where the eye reaches the cell: satisfied at any feet cell whose eye does, estimated in ticks from the shortfall
 * of the eye's distance to the range, split by axis as `nearGoal` splits it (the estimate is zero once satisfied).
 */
export function reachGoal(target: BlockPosition, range: number): Goal {
  const revision = `reach:${target.x},${target.y},${target.z}:${range}`;
  return customGoal(
    revision,
    (node) => withinBlockReach(eyeOver(node.feet), target, range),
    (node) => {
      const eye = eyeOver(node.feet);
      const distance = boxDistance(eye, target);
      if (distance <= range) return 0;
      const offset = offsetToBox(eye, target);
      const scale = (distance - range) / distance;
      return (
        Math.sqrt(offset.x * offset.x + offset.z * offset.z) * scale * HORIZONTAL_TICKS_PER_BLOCK +
        Math.max(0, offset.y) * scale * ASCENT_TICKS_PER_BLOCK +
        Math.max(0, -offset.y) * scale * DESCENT_TICKS_PER_BLOCK
      );
    },
  );
}

/**
 * The lowest number of blocks above `ground` a column of cells must be pillared to for the eye to reach `cell`, or null when
 * even `maxHeight` does not. Feet at `ground + height` put the eye `STANDING_EYE_HEIGHT` above that.
 */
function heightToReach(column: StandColumn, cell: BlockPosition, ground: number, range: number): number | null {
  // Beside the cell farther than the range, no height reaches it: skip the climb (a wide roof asks this of thousands of pairs).
  const beside = Math.hypot(
    clamp(column.x + 0.5, cell.x, cell.x + 1) - (column.x + 0.5),
    clamp(column.z + 0.5, cell.z, cell.z + 1) - (column.z + 0.5),
  );
  if (beside > range) return null;
  for (let height = 0; height <= column.maxHeight; height += 1) {
    if (withinBlockReach(eyeOver({ x: column.x, y: ground + height, z: column.z }), cell, range)) return height;
  }
  return null;
}

/**
 * The columns to stand on for `cells` (the ones out of reach from the ground): greedy, the most cells per block first, then
 * the column serving more cells (fewer pillars), then the one with fewer blocks, then the one nearest `near` (the bot). A
 * column's height is a feet level above `ground` from which each cell it serves is in reach (a taller column reaches less of
 * what lies far below its eye, so coverage is tested at the chosen height, not assumed from the lowest). A cell no offered
 * column reaches is left out: its own goal stays, as before.
 */
export function coverWithColumns(
  cells: readonly BlockPosition[],
  columns: readonly StandColumn[],
  ground: number,
  range: number,
  near: { readonly x: number; readonly z: number },
): readonly ChosenColumn[] {
  // Per column and cell the blocks it takes to reach it: computed once, the greedy rounds only count.
  const needs = columns.map((column) => cells.map((cell) => heightToReach(column, cell, ground, range) ?? Infinity));
  const reachesAt = (index: number, height: number, cell: number): boolean =>
    withinBlockReach(eyeOver({ x: columns[index]!.x, y: ground + height, z: columns[index]!.z }), cells[cell]!, range);
  const chosen: ChosenColumn[] = [];
  let uncovered = cells.map((_cell, index) => index);
  for (;;) {
    const best = bestColumn(columns, needs, uncovered, near, reachesAt);
    if (best === null) return chosen;
    chosen.push({ x: columns[best.index]!.x, z: columns[best.index]!.z, height: best.height });
    uncovered = uncovered.filter((cell) => !reachesAt(best.index, best.height, cell));
  }
}

interface ColumnChoice {
  readonly index: number;
  readonly height: number;
  readonly covers: number;
  readonly score: number;
  readonly distance: number;
}

const beats = (choice: ColumnChoice, best: ColumnChoice | null): boolean =>
  best === null ||
  choice.score > best.score ||
  (choice.score === best.score &&
    (choice.covers > best.covers ||
      (choice.covers === best.covers &&
        (choice.height < best.height || (choice.height === best.height && choice.distance < best.distance)))));

/** The column and height serving the most uncovered cells per block (see `coverWithColumns` for the ties), or null. */
function bestColumn(
  columns: readonly StandColumn[],
  needs: readonly (readonly number[])[],
  uncovered: readonly number[],
  near: { readonly x: number; readonly z: number },
  reachesAt: (index: number, height: number, cell: number) => boolean,
): ColumnChoice | null {
  let best: ColumnChoice | null = null;
  for (const [index, column] of columns.entries()) {
    const distance = Math.hypot(column.x - near.x, column.z - near.z);
    // Heights worth trying: each one that some uncovered cell first becomes reachable at (a ground cell needs no column).
    const heights = new Set(uncovered.map((cell) => needs[index]![cell]!).filter((need) => need > 0 && need < Infinity));
    for (const height of heights) {
      const covers = uncovered.filter((cell) => reachesAt(index, height, cell)).length;
      const choice = { index, height, distance, covers, score: covers / height };
      best = beats(choice, best) ? choice : best;
    }
  }
  return best;
}

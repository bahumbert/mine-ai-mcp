/**
 * How far a build can work a cell, from the eye instead of the feet-to-cell distance it used to ask. The server's own
 * test is wider (spike 2026-11-16, plan 2026-11-14-house-build-fixes-2 Task 1, facts `houses.md` "Roof scaffold spike":
 * a placement 4.517 from the eye to the cell's box, 5.33 to the clicked support's box, was accepted, 4.866 / 5.628 refused;
 * the attribute `player.block_interaction_range` reads 4.5): asking the cell's own box within that range of the eye is the
 * stricter, measured-safe side of it. Unmeasured: the eye up to 0.7 off the cell centre, and the eye while sneaking (the
 * placement sneaks; the spike's probe did not). One test, three users: the
 * in-reach work (`BuildTargeting.reaches`), the route's goal for a cell (`reachGoal`) and the stand columns for the cells the
 * ground cannot serve (`coverWithColumns`). The pure rule is `stand-cover.ts`, which the brain imports too
 * (`brain/src/building/stand-columns.ts`).
 */
import type { Bot } from "mineflayer";
import {
  ASCENT_TICKS_PER_BLOCK,
  DESCENT_TICKS_PER_BLOCK,
  HORIZONTAL_TICKS_PER_BLOCK,
  customGoal,
  type BlockPosition,
  type Goal,
} from "../../index.js";
import { boxDistance, eyeOver, offsetToBox, withinBlockReach } from "./stand-cover.js";

export { coverWithColumns, eyeOver, withinBlockReach, type ChosenColumn, type Point, type StandColumn } from "./stand-cover.js";

/** Minecraft 1.21.4's survival block interaction range, used when the bot has no attribute (the fake and a fresh login). */
export const DEFAULT_BLOCK_RANGE = 4.5;

/** The attribute key Mineflayer keeps on `bot.entity.attributes` for 1.21.4 (`entities.js` `updateAttributes`; probe trace). */
const RANGE_ATTRIBUTE = "player.block_interaction_range";

/** The block interaction range of this bot: its attribute when it has a number there, else the vanilla range. */
export function blockRangeOf(bot: Bot): number {
  const attributes = (bot.entity as { attributes?: Record<string, { value?: unknown } | undefined> }).attributes;
  const value = attributes?.[RANGE_ATTRIBUTE]?.value;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_BLOCK_RANGE;
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

/** First-reach cells of a bucket pour, and the bodies and protected regions they must spare. */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { liveBlockReader, type WorldView } from "../../navigation/index.js";
import { cellIntersectsPlayerBody } from "../../utils/index.js";
import { restsOnFloor } from "../../world/lava-flow.js";
import { HORIZONTAL } from "../../world/liquid.js";
import { describeProtectedRegion, foreignRegionAt } from "../../world/protected-regions.js";
import { useBucketOutcomes, type BucketLiquid } from "./contract.js";

const MAXIMUM_POUR_FALL_CELLS = 64;

/** The target, its falling column to a floor (at most 64 cells down), and that landing's first sideways spread. */
export function pourReachCells(world: Pick<WorldView, "blockAt">, target: Vec3): Vec3[] {
  const cells = [target];
  let landing = target;
  for (let depth = 0; depth < MAXIMUM_POUR_FALL_CELLS; depth += 1) {
    if (restsOnFloor(world, landing.x, landing.y, landing.z) !== false) break;
    landing = landing.offset(0, -1, 0);
    cells.push(landing);
  }
  if (restsOnFloor(world, landing.x, landing.y, landing.z) !== false) {
    cells.push(...HORIZONTAL.map((side) => landing.plus(side)));
  }
  return cells;
}

/** Refuse lava reaching an observed player body, and either liquid reaching someone else's protected region. */
export function pourRefusal(bot: Bot, target: Vec3, liquid: BucketLiquid): string | null {
  const cells = pourReachCells({ blockAt: liveBlockReader(bot) }, target);
  if (liquid === "lava") {
    const players = [{ username: bot.username, entity: bot.entity }, ...Object.values(bot.players)];
    for (const cell of cells) {
      const player = players.find((player) => player.entity && cellIntersectsPlayerBody(cell, player.entity.position));
      if (player) return useBucketOutcomes.pourReachesBody(player.username, cell);
    }
  }
  for (const cell of cells) {
    const region = foreignRegionAt(bot, cell);
    if (region) return useBucketOutcomes.pourInProtectedRegion(describeProtectedRegion(region));
  }
  return null;
}

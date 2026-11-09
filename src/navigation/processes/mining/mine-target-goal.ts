// Resolve mining targets into work goals and the stances that can complete them.
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { asVec3, cellKey } from "../../../utils/index.js";
import { STANDING_EYE_HEIGHT } from "../../../world/block-visibility.js";
import { sourceInSight, USE_RAY_REACH } from "../../../world/liquid.js";
import { excavateGoal } from "../../goals/excavate.js";
import { anyGoal, exactBlockGoal, itemPickupGoal, nearGoal, occupyGoal,
  type BlockPosition, type Goal, type MovementPolicy } from "../../index.js";
import { liveBlockReader } from "../../mineflayer/world.js";
import { isSafeSupport, isWater } from "../../world/block-geometry.js";
import { admitsDive, openWaterSurface } from "../../world/swimming.js";
import { CAST_REACH } from "./cast-obsidian.js";
import { WORKING_OFFSETS } from "./drowned-target.js";
import type { MineAnticipatedDropTarget, MineBlockTarget, MineDropTarget,
  MinePoolTarget, MineSettlingDropTarget, MineTarget, MineWaterTarget } from "./mine-process.js";

/**
 * How many of a pool's sources its goal offers as lips to stand beside. The
 * search prices every branch of a composite goal at every node, and the
 * sources are nearest-first, so a lake of two hundred cells would put its
 * whole surface on the hot path to describe the same near edge.
 */
const POOL_GOAL_LIPS = 8;

/** A stable target identity for refresh notifications and route revalidation. */
export function targetIdentity(target: MineTarget): string {
  switch (target.kind) {
    case "block":
      return `block:${cellKey(target.position)}:avoid=${[...target.excludedStances].join(";")}`;
    case "drop":
      return `drop:${target.entityId}`;
    case "anticipated_drop":
      return `anticipated:${cellKey(target.position)}`;
    case "settling_drop":
      return `settling:${target.entityId}`;
    case "water":
      return `water:${cellKey(target.position)}:avoid=${[...target.excludedStances].join(";")}`;
    case "pool":
      return `pool:${cellKey(target.position)}:avoid=${[...target.excludedStances].join(";")}`;
  }
}

/** Drops take precedence over further block excavation. */
export function isDropTarget(
  target: MineTarget,
): target is MineDropTarget | MineAnticipatedDropTarget | MineSettlingDropTarget {
  return target.kind === "drop" || target.kind === "anticipated_drop" || target.kind === "settling_drop";
}

/**
 * Adjacent working cells with dry headroom or a budgeted, supported open-water dive.
 * The goal and the physical dig use the same cells. A stance found occluded
 * after arrival is excluded so the route can select another approach.
 */
export function workingCells(bot: Bot, target: MineBlockTarget, movements: MovementPolicy): readonly BlockPosition[] {
  const position = target.position;
  const read = liveBlockReader(bot);
  return WORKING_OFFSETS.map((offset) => ({
    x: position.x + offset.x, y: position.y + offset.y, z: position.z + offset.z,
  })).filter((cell) => {
    // Obsidian takes longer than a breath when the eye is submerged. A pickup
    // may dip into its hole; the next mining stance must return to the surface.
    const head = read(cell.x, cell.y + 1, cell.z);
    if (head.kind !== "loaded" || target.excludedStances.has(cellKey(cell))) return false;
    if (!isWater(head)) return true;
    if (!movements.allowSwimming || !isSafeSupport(read(cell.x, cell.y - 1, cell.z))) return false;
    const surface = openWaterSurface(read, cell);
    if (!surface) return false;
    const block = read(position.x, position.y, position.z);
    const tool = movements.evaluateBreak(block, position, { blockAt: read, revision: 0, subscribe: () => () => {} }).tool;
    const work = movements.digTimeEstimator.estimate(block, tool, {
      submergedAtEyes: true, onGround: true, aquaAffinity: false, effects: {},
    });
    // Filter impossible work at full air. The runtime checks current air before the actual dig.
    return admitsDive(read, cell, { origin: surface, airTicks: 300 }, work + 20);
  });
}

/** Cast from above the source, after climbing out of any preceding mining hole. */
export function castStance(target: MinePoolTarget, feet: BlockPosition): boolean {
  return (
    !target.excludedStances.has(cellKey(feet)) &&
    target.sources
      .slice(0, POOL_GOAL_LIPS)
      .some((source) => feet.y > source.y && asVec3(feet).distanceTo(asVec3(source)) <= CAST_REACH)
  );
}

/** A recovery stance must see the poured source and must not have failed before. */
export function waterStance(bot: Bot, target: MineWaterTarget, feet: BlockPosition): boolean {
  return (
    !target.excludedStances.has(cellKey(feet)) &&
    sourceInSight(bot, new Vec3(feet.x + 0.5, feet.y + STANDING_EYE_HEIGHT, feet.z + 0.5), asVec3(target.position))
  );
}

/** The work or arrival represented by one live target. */
export function mineTargetGoal(bot: Bot, target: MineTarget, movements: MovementPolicy): Goal {
  if (target.kind === "drop") return itemPickupGoal({ id: target.entityId });
  if (target.kind === "anticipated_drop" || target.kind === "settling_drop") return occupyGoal(target.position, 2);
  if (target.kind === "water") {
    const approach = nearGoal(target.position, USE_RAY_REACH + STANDING_EYE_HEIGHT);
    return {
      resolve(observation) {
        const goal = approach.resolve(observation);
        if (goal.kind !== "active") return goal;
        return {
          ...goal,
          revision: targetIdentity(target),
          isSatisfied: (node) => waterStance(bot, target, node.feet),
        };
      },
    };
  }
  // A pool is poured on from beside it, and every source of it will do, so the
  // route takes the cheapest lip rather than the one nearest the scan.
  if (target.kind === "pool") {
    const approach = anyGoal(target.sources.slice(0, POOL_GOAL_LIPS).map((source) => nearGoal(source, CAST_REACH)));
    return {
      resolve(observation) {
        const goal = approach.resolve(observation);
        if (goal.kind !== "active") return goal;
        return {
          ...goal,
          revision: targetIdentity(target),
          isSatisfied: (node) => castStance(target, node.feet),
        };
      },
    };
  }
  // A target the route may not break cannot be reached by standing in it: the
  // flood rule refuses the break that would clear the way. Stand in a cell
  // that touches it and let the loop seal it and break it from there.
  if (!target.routeMayBreak) return anyGoal(workingCells(bot, target, movements).map(exactBlockGoal));
  return excavateGoal(target.position);
}

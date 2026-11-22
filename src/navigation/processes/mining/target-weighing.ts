// Rank mining targets by distance and a caller's cost within one scan.
import { Vec3 } from "vec3";
import type { BlockPosition } from "../../index.js";
import type { MineBlockTarget, MineDropTarget, MineRequest, MineScan, MineTarget } from "./mine-process.js";

/** Choices this close in score remain available to the route (planner starting value). */
export const WEIGHED_SLACK = 4;
/** Bound the nearest matching blocks read by a weighed scan (planner starting value). */
export const WEIGHED_SCAN_LIMIT = 1024;

export interface Weighed<T> {
  readonly kept: readonly T[];
  readonly passedOver: readonly T[];
  readonly unread: number;
}

/** Rank available targets while leaving the route its near-equal choices. */
export function weighTargets<T extends { readonly position: BlockPosition }>(
  blocks: readonly T[], feet: Vec3, cost: (position: BlockPosition) => number | null,
): Weighed<T> {
  const weighed: { target: T; score: number }[] = [];
  let unread = 0;
  for (const target of blocks) {
    const extra = cost(target.position);
    if (extra === null) { unread += 1; continue; }
    const { x, y, z } = target.position;
    weighed.push({ target, score: feet.distanceTo(new Vec3(x + 0.5, y + 0.5, z + 0.5)) + extra });
  }
  if (weighed.length === 0) return { kept: blocks, passedOver: [], unread };
  weighed.sort((left, right) => left.score - right.score);
  const cutoff = weighed[0]!.score + WEIGHED_SLACK;
  return {
    kept: weighed.filter(({ score }) => score <= cutoff).map(({ target }) => target),
    passedOver: weighed.filter(({ score }) => score > cutoff).map(({ target }) => target),
    unread,
  };
}

/** Merge drops and blocks in legacy distance order, or weigh only the blocks after distance-sorted drops. */
export function scanTargets(
  blocks: readonly MineBlockTarget[], drops: readonly MineDropTarget[], feet: Vec3,
  targetCost: MineRequest["targetCost"], limit: number,
): Pick<MineScan, "targets" | "candidates" | "passedOver"> {
  const distance = (target: MineTarget) => feet.distanceSquared(new Vec3(target.position.x, target.position.y, target.position.z));
  if (targetCost) {
    const weighed = weighTargets(blocks, feet, (position) => targetCost.cost(position));
    return { targets: [...drops.slice().sort((a, b) => distance(a) - distance(b)), ...weighed.kept].slice(0, limit),
      candidates: blocks, passedOver: weighed.passedOver };
  }
  return { targets: [...drops, ...blocks].sort((a, b) => distance(a) - distance(b)).slice(0, limit),
    candidates: blocks, passedOver: [] };
}

export interface PassedOverNearest extends BlockPosition { readonly distance: number }

/** Keep the largest single-scan evidence, using that scan's feet for the nearest distance. */
export class MineWeighing {
  #passedOver = 0;
  #nearest: PassedOverNearest | null = null;

  constructor(private readonly request: MineRequest) {}

  /** Notify for every actual scan, even when the target set has not changed. */
  observe(scan: MineScan, feet: Vec3): void {
    if (scan.passedOver.length > this.#passedOver) {
      this.#passedOver = scan.passedOver.length;
      this.#nearest = scan.passedOver.reduce<PassedOverNearest | null>((nearest, { position: { x, y, z } }) => {
        const distance = feet.distanceTo(new Vec3(x + 0.5, y + 0.5, z + 0.5));
        return nearest === null || distance < nearest.distance ? { x, y, z, distance } : nearest;
      }, null);
    }
    this.request.onScan?.(scan);
  }

  /** Unweighed callers retain their existing result shape. */
  result(): { readonly passedOver?: number; readonly passedOverNearest?: PassedOverNearest | null } {
    return this.request.targetCost ? { passedOver: this.#passedOver, passedOverNearest: this.#nearest } : {};
  }
}

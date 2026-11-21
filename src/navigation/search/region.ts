// Goal-region geometry and route detour evidence.
import type { GoalRegion, ResolvedGoal } from "../goals/goal.js";
import type { ClosestNodeEvidence, SearchLimitEvidence } from "../orchestration/outcome.js";
import type { BlockPosition } from "../world/world.js";
import type { SearchEvidence } from "./search-result.js";

/** Return only a region tied to the active predicate with finite straight distances. */
export function searchRegion(goal: Extract<ResolvedGoal, { kind: "active" }>, root: BlockPosition): GoalRegion | null {
  const region = goal.region?.(root);
  return region && region.satisfies === goal.isSatisfied && region.parts.length > 0
    && region.parts.every((part) => Number.isFinite(part.straight)) ? region : null;
}

export interface RegionBound {
  readonly stretch: number;
  readonly margin: number;
}

/** Refuse a bound that could exclude the root or that is not a number. */
export function assertRegionBound(bound: RegionBound): void {
  if (!Number.isFinite(bound.stretch) || bound.stretch < 1)
    throw new RangeError(`A region stretch is a finite number of at least 1, not ${bound.stretch}.`);
  if (!Number.isFinite(bound.margin) || bound.margin < 0)
    throw new RangeError(`A region margin is a finite number of at least 0, not ${bound.margin}.`);
}

/** Each part's allowance, stretch x straight + margin, in blocks; null when one overflows (no bound is then worth applying). */
export function regionAllowances(region: GoalRegion, bound: RegionBound): readonly number[] | null {
  assertRegionBound(bound);
  const allowances = region.parts.map((part) => bound.stretch * part.straight + bound.margin);
  return allowances.every(Number.isFinite) ? allowances : null;
}

/**
 * Square-root rounding: a cell on the straight line sums to the straight distance up to a few units in the last place
 * (7 % of the on-line cells of goals up to 40 x 40 came out one ulp over a stretch 1, margin 0 allowance). A billionth
 * of a block is far under any real detour and over any rounding of sums below a thousand blocks.
 */
const ROUNDING_SLACK_BLOCKS = 1e-9;

/** The cells a search may explore: those whose detour sum is within some part's allowance. */
export class RegionClip {
  readonly #region: GoalRegion;
  readonly #root: BlockPosition;
  readonly #allowances: readonly number[];
  /** Cells refused so far. */
  refused = 0;
  /** The part with the smallest straight distance: the one a refusal is reported for. */
  readonly part: number;
  /** That part's allowance. */
  readonly allowance: number;
  /** The largest detour sum refused for that part. */
  observed = 0;

  constructor(region: GoalRegion, root: BlockPosition, bound: RegionBound) {
    this.#region = region;
    this.#root = root;
    const allowances = regionAllowances(region, bound);
    if (allowances === null) throw new RangeError("A region allowance overflowed: the bound is too large to clip with.");
    this.#allowances = allowances;
    this.part = region.parts.reduce((best, part, index) => (part.straight < region.parts[best]!.straight ? index : best), 0);
    this.allowance = this.#allowances[this.part]!;
  }

  /** What a search that ran dry after refusing cells reports: the nearest part's allowance and the largest sum refused for it. */
  limit(closest: ClosestNodeEvidence): SearchLimitEvidence {
    return { kind: "region", limit: this.allowance, observed: this.observed, part: this.part,
      straight: this.#region.parts[this.part]!.straight, closest };
  }

  /** Inside when some part's sum is within its allowance; otherwise the refusal is counted for the nearest part. */
  admits(feet: BlockPosition): boolean {
    const walked = Math.hypot(feet.x - this.#root.x, feet.y - this.#root.y, feet.z - this.#root.z);
    const parts = this.#region.parts;
    for (let index = 0; index < parts.length; index += 1)
      if (walked + parts[index]!.distance(feet) <= this.#allowances[index]! + ROUNDING_SLACK_BLOCKS) return true;
    this.refused += 1;
    this.observed = Math.max(this.observed, walked + parts[this.part]!.distance(feet));
    return false;
  }
}

/**
 * The clip a search applies, or null: no bound, a radius (its own spatial policy), no region, or an allowance that overflows.
 * A bound that is not a stretch of at least 1 and a margin of at least 0 throws `RangeError` even when it would be ignored.
 */
export function regionClipFor(
  region: GoalRegion | null,
  root: BlockPosition,
  limits: { readonly region?: RegionBound | null; readonly maximumRadius?: number } | undefined,
): RegionClip | null {
  if (!limits?.region) return null;
  assertRegionBound(limits.region);
  if (limits.maximumRadius !== undefined) return null;
  return region && regionAllowances(region, limits.region) ? new RegionClip(region, root, limits.region) : null;
}

/** The region part of a search's evidence: straight distance, the clip's allowance and refusals so far, and for a plan its route's detour. */
export function regionEvidence(
  region: GoalRegion,
  clip: RegionClip | null,
  root: BlockPosition,
  route?: readonly BlockPosition[],
): NonNullable<SearchEvidence["region"]> {
  return {
    straight: Math.min(...region.parts.map((part) => part.straight)),
    allowance: clip?.allowance ?? null,
    refused: clip?.refused ?? 0,
    ...(route && { detour: routeDetour(region, root, route).detour }),
  };
}

/** Measure the greatest detour sum for the part nearest the route's endpoint. */
export function routeDetour(region: GoalRegion, root: BlockPosition, cells: readonly BlockPosition[]): { part: number; straight: number; detour: number } {
  const end = cells.at(-1) ?? root;
  let part = 0;
  for (let i = 1; i < region.parts.length; i += 1)
    if (region.parts[i]!.distance(end) < region.parts[part]!.distance(end)) part = i;
  const selected = region.parts[part]!;
  const reach = (cell: BlockPosition) => Math.hypot(cell.x - root.x, cell.y - root.y, cell.z - root.z) + selected.distance(cell);
  let detour = reach(root);
  for (const cell of cells) detour = Math.max(detour, reach(cell));
  return { part, straight: selected.straight, detour };
}

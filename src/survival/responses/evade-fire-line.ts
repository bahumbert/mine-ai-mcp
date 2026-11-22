/**
 * The line-of-fire price of an evade route: a cost on the steps that run straight away from a shooter, so the evading
 * body crosses its aim instead of running along it (P4-29 bow lead, 2026-11-18 part 2).
 *
 * Horizontal only: a step's direction is compared with the bearing from each shooter to the step's start cell, and a
 * step under `thetaRad` of that bearing is priced once, however many shooters it runs away from. A step toward a shooter
 * or across its aim is free, so a route that already crosses its line is unchanged.
 */
import type { MovementPolicy, PolicyDecision } from "../../navigation/movements/policy.js";
import type { BlockPosition } from "../../navigation/world/world.js";

/** The reason a priced step reports (events and evidence name it). */
export const LINE_OF_FIRE_REASON = "line_of_fire";

/** Below this length a vector has no direction; a step or a bearing that short adds nothing. */
const NO_DIRECTION = 1e-6;

/**
 * Measured by the search tests (b) of `evade-fire-line.test.ts`: open ground, from (0, 0) with a shooter at (-6, 0) and a
 * goal 44 blocks off (the evade's range 36 + margin 8), first 12 steps, theta 35 degrees:
 * - unpriced: 12 of 12 steps within 10 degrees of the bearing (test (a)), length 38 cells;
 * - price 1 x walk (5 ticks): 12 of 12 steps at 35 degrees or more, length 38, visited 2304, computeMs 81;
 * - price 2 x walk (10 ticks): 12 of 12, length 38, visited 2280, computeMs 65;
 * - price 4 x walk (20 ticks): 12 of 12, length 38, visited 2280, computeMs 55.
 * The least multiple that meets the bar (every step crossing, length at most 1.5 x unpriced) is 1 x walk, so the price is 5.
 */
export const FIRE_LINE_THETA_RAD = (35 * Math.PI) / 180;
/** The chosen price in ticks: 1 x the walk's 5 ticks, the least of the measured multiples. */
export const FIRE_LINE_PRICE_TICKS = 5;

export interface FireLineOptions {
  /** The shooters' feet, read at each price (a live answer), not a snapshot. */
  readonly shooters: () => readonly BlockPosition[];
  readonly thetaRad: number;
  readonly priceTicks: number;
}

/** Clamps a cosine to [-1, 1] so rounding never makes `acos` return NaN. */
const clampCosine = (value: number): number => Math.min(1, Math.max(-1, value));

/** The price of stepping from `from` to `to` in the sight of the shooters: zero, or `priceTicks` once for any shooter. */
export function fireLinePrice(from: BlockPosition, to: BlockPosition, options: FireLineOptions): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const stepLength = Math.hypot(dx, dz);
  if (stepLength < NO_DIRECTION) return 0;
  for (const shooter of options.shooters()) {
    // The bearing runs from the shooter to the centre of the step's start cell.
    const bx = from.x + 0.5 - shooter.x;
    const bz = from.z + 0.5 - shooter.z;
    const bearingLength = Math.hypot(bx, bz);
    if (bearingLength < NO_DIRECTION) continue;
    const angle = Math.acos(clampCosine((dx * bx + dz * bz) / (stepLength * bearingLength)));
    if (angle < options.thetaRad) return options.priceTicks;
  }
  return 0;
}

const ALLOWED: PolicyDecision = { kind: "allowed" };

/**
 * `policy` with the line-of-fire price added to its movement decisions. A prohibition is kept as it is; a zero price returns
 * the base decision itself; an allowed step becomes penalized, and a penalized one keeps its reason and adds the price.
 */
export function withFireLine(policy: MovementPolicy, options: FireLineOptions): MovementPolicy {
  const decideMovement = (kind: Parameters<NonNullable<MovementPolicy["decideMovement"]>>[0], from: BlockPosition, to: BlockPosition): PolicyDecision => {
    const base = policy.decideMovement?.(kind, from, to) ?? ALLOWED;
    if (base.kind === "prohibited") return base;
    const price = fireLinePrice(from, to, options);
    if (price === 0) return base;
    if (base.kind === "allowed") return { kind: "penalized", reason: LINE_OF_FIRE_REASON, cost: price };
    return { ...base, cost: base.cost + price };
  };
  return Object.freeze({ ...policy, decideMovement });
}

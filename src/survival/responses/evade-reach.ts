// Pure reach verdicts and per-threat position history for emergency evades.
import type { Vec3 } from "vec3";
import type { PositionThreat } from "../positioning/combat/exposure.js";

export type ReachBasis = "dead" | "range" | "cover" | "disengaged";

export interface ReachSample {
  readonly age: number;
  readonly atMs: number;
  readonly position: Vec3;
}

export interface ReachThreat extends PositionThreat {
  readonly name: string;
}

export interface ReachPolicy {
  readonly evade_safe_range: number;
  readonly evade_clear_range: number;
  readonly evade_cover_range: number;
}

export interface ReachVerdict {
  readonly id: number;
  readonly name: string;
  readonly distance: number;
  readonly basis: ReachBasis | null;
  readonly advancing: boolean | null;
}

export const EVADE_CLOSING_WINDOW_TICKS = 40;
export const EVADE_ADVANCE_TOLERANCE = 1.0;
export const EVADE_AGE_STALE_MS = 1_500;

interface ReachInput {
  readonly threat: ReachThreat;
  readonly dead: boolean;
  readonly observed: boolean;
  readonly distance: number;
  readonly samples: readonly ReachSample[];
  readonly botPosition: Vec3;
  readonly ageNow: number;
  readonly ageMovedAtMs: number | null;
  readonly nowMs: number;
  readonly exposed: () => boolean;
  readonly shotInWindow: boolean;
  readonly policy: ReachPolicy;
}

/** Judge the threat's own displacement; a constant gap can still mean pursuit. */
function threatAdvancing(input: ReachInput): boolean | null {
  if (input.ageMovedAtMs === null || input.nowMs - input.ageMovedAtMs > EVADE_AGE_STALE_MS) return null;
  const window = input.samples.filter((sample) => sample.age >= input.ageNow - EVADE_CLOSING_WINDOW_TICKS);
  const oldest = window[0];
  const newest = window.at(-1);
  if (window.length < 3 || !oldest || !newest || newest.age !== input.ageNow
    || newest.age - oldest.age < EVADE_CLOSING_WINDOW_TICKS) return null;
  const towardBot = input.botPosition.minus(oldest.position);
  const length = towardBot.norm();
  const advance = length === 0 ? 0 : newest.position.minus(oldest.position).dot(towardBot.scaled(1 / length));
  return advance > EVADE_ADVANCE_TOLERANCE;
}

/** The first supported reason this threat cannot reach now, without assuming a species' follow range. */
function reachBasis(input: ReachInput, advancing: boolean | null): ReachBasis | null {
  if (input.dead) return "dead";
  if (input.distance >= input.policy.evade_safe_range) return "range";
  if (!input.observed || input.threat.attack === "unmodelled" || advancing !== false) return null;
  if (input.threat.attack === "projectile"
    && input.distance >= Math.min(input.policy.evade_cover_range, input.policy.evade_safe_range)
    && !input.exposed()) return "cover";
  if (input.distance >= Math.min(input.policy.evade_clear_range, input.policy.evade_safe_range)
    && (input.threat.attack === "melee" || !input.shotInWindow)) return "disengaged";
  return null;
}

/** Decide reach from observed facts; live exposure is evaluated only for a cover candidate. */
export function judgeReach(input: ReachInput): ReachVerdict {
  const advancing = threatAdvancing(input);
  return {
    id: input.threat.id,
    name: input.threat.name,
    distance: input.distance,
    basis: reachBasis(input, advancing),
    advancing,
  };
}

/** Observed position snapshots, bounded by game age independently for each threat. */
export class ReachHistory {
  readonly #samples = new Map<number, ReachSample[]>();

  /** Duplicate world ages cannot add evidence to the closing window. */
  record(id: number, age: number, atMs: number, position: Vec3): void {
    const samples = this.#samples.get(id) ?? [];
    if (samples.at(-1)?.age === age) return;
    const retained = samples.filter((sample) => sample.age >= age - 2 * EVADE_CLOSING_WINDOW_TICKS);
    retained.push({ age, atMs, position: position.clone() });
    this.#samples.set(id, retained);
  }

  /** Read this threat's retained observations in ascending age order. */
  samples(id: number): readonly ReachSample[] {
    return this.#samples.get(id) ?? [];
  }

  /** Discard a threat when its encounter no longer needs reach evidence. */
  forget(id: number): void {
    this.#samples.delete(id);
  }
}

/**
 * The policy of an escape leg (run 15: Dirk and Sana pinned for hours). Two rules are set aside, for that leg only, and
 * every safety rule stays: the bot's own style rule against digging straight down, and the refusal to dig where the
 * only liquid a break opens into is flowing water (owner, 2026-10-18; a water source and any lava still refuse). A cell lava
 * will flow into on its next update is priced, not refused, on this leg: the way out may cross it as the last resort
 * (owner, 2026-10-19), while an ordinary route goes round it.
 */
import { standsFree } from "../movements/catalogue.js";
import type { PlannedStep } from "../movements/movement.js";
import { BREAK_UNDER_WATER, LAVA_SPREAD_REASON, type BreakEvaluation, type MovementPolicy, type PolicyDecision } from "../movements/policy.js";
import { countStartRefusals, neverLeftStart, type StartRefusals } from "../search/start-refusals.js";
import type { BlockObservation, BlockPosition, WorldView } from "../world/world.js";
import type { NavigationCalculationFailure } from "./process-events.js";

/** The rule names an escape reports (events, evidence, the action's result text). */
export const RELAXED_DIG_STRAIGHT_DOWN = "dig_straight_down";
export const RELAXED_FLOWING_WATER = "dig_next_to_flowing_water";
export const ESCAPE_RELAXED_RULES: readonly string[] = [RELAXED_DIG_STRAIGHT_DOWN, RELAXED_FLOWING_WATER];

const ALLOWED: PolicyDecision = { kind: "allowed" };
/** Ticks an escape pays to stand where lava is about to flow: dearer than a detour of twenty seconds, so it is the last resort. */
export const LAVA_SPREAD_ESCAPE_COST = 400;

/** `decideStep` as the escape leg sees it: the lava-spread refusal becomes a price. */
function pricedLavaSpread(policy: MovementPolicy): MovementPolicy["decideStep"] {
  return (x, y, z, world) => {
    const decision = policy.decideStep(x, y, z, world);
    return decision.kind === "prohibited" && decision.reason === LAVA_SPREAD_REASON
      ? { kind: "penalized", reason: decision.reason, cost: LAVA_SPREAD_ESCAPE_COST }
      : decision;
  };
}

const isLiquidRefusal = (decision: PolicyDecision): boolean =>
  decision.kind === "prohibited" && (decision.cause === "opens_into_liquid" || decision.reason === BREAK_UNDER_WATER);

/** `policy` as the escape leg sees it. A policy that cannot tell flowing from source water keeps its liquid rules whole. */
export function relaxedForEscape(policy: MovementPolicy): MovementPolicy {
  const flowingOnly = policy.opensOnlyIntoFlowingWater;
  if (flowingOnly === undefined) return Object.freeze({ ...policy, allowDownward: true, decideStep: pricedLavaSpread(policy) });
  return Object.freeze({
    ...policy,
    allowDownward: true,
    decideStep: pricedLavaSpread(policy),
    confirmBreak: (block: BlockObservation, position: BlockPosition, world: WorldView): PolicyDecision => {
      const decision = policy.confirmBreak(block, position, world);
      return isLiquidRefusal(decision) && flowingOnly(position.x, position.y, position.z, world) ? ALLOWED : decision;
    },
    evaluateBreak: (block: BlockObservation, position: BlockPosition, world: WorldView): BreakEvaluation => {
      const evaluation = policy.evaluateBreak(block, position, world);
      return isLiquidRefusal(evaluation.decision) && flowingOnly(position.x, position.y, position.z, world)
        ? policy.priceBreak(block, position.x, position.y, position.z, world)
        : evaluation;
    },
  });
}

const refused = (refusals: StartRefusals): number => Object.values(refusals).reduce((sum, count) => sum + count, 0);

/**
 * An exhausted search that never left its start, whose first digs the escape's own policy refuses less often than the
 * run's: only then can an escape search get out. What the escape lifts is defined above and nowhere else, so a refusal
 * it leaves in place (lava) never starts a search that cannot succeed, and a rule it relaxes later is counted at once.
 */
export function isShutInByEscapableRefusals(
  failure: Extract<NavigationCalculationFailure, { readonly kind: "no_path" }>,
  world: WorldView,
  policy: MovementPolicy,
  feet: BlockPosition,
): boolean {
  return (
    neverLeftStart(failure.search) &&
    refused(countStartRefusals(world, relaxedForEscape(policy), feet)) < refused(countStartRefusals(world, policy, feet))
  );
}

/** Whether `policy` (the bot's own, not the escape's) refuses this break as a flood that only the flowing-water exception lets through. */
function needsFlowingWaterException(policy: MovementPolicy, position: BlockPosition, world: WorldView): boolean {
  const refused = isLiquidRefusal(policy.evaluateBreak(world.blockAt(position.x, position.y, position.z), position, world).decision);
  return refused && policy.opensOnlyIntoFlowingWater?.(position.x, position.y, position.z, world) === true;
}

/** Whether this step digs straight down through a block that only setting the bot's own rule aside lets it dig. */
function digsDownAgainstOwnRule(step: PlannedStep, policy: MovementPolicy, world: WorldView): boolean {
  return step.kind === "downward" && step.operations.some((operation) => operation.kind === "break") && !policy.allowDownward
    && !standsFree(world.blockAt.bind(world), step.to.x, step.to.y, step.to.z);
}

/**
 * Which of the relaxed rules the routes of one run committed to actually used (run 15 review): the result says what the
 * escape dug, not what it was allowed to. `dig_straight_down` only for a downward dig the bot's own rule would have
 * refused, `dig_next_to_flowing_water` only for a break its own policy refuses as a flood that lets in flowing water alone.
 */
export class RelaxedRulesUsed {
  readonly #used = new Set<string>();

  /** A committed route's steps, judged against `policy` (the bot's own, unrelaxed) in `world` as the route was planned. */
  note(steps: readonly PlannedStep[], policy: MovementPolicy, world: WorldView): void {
    if (steps.some((step) => digsDownAgainstOwnRule(step, policy, world))) this.#used.add(RELAXED_DIG_STRAIGHT_DOWN);
    const breaks = steps.flatMap((step) => step.operations.flatMap((operation) => (operation.kind === "break" ? [operation.position] : [])));
    if (breaks.some((position) => needsFlowingWaterException(policy, position, world))) this.#used.add(RELAXED_FLOWING_WATER);
  }

  /** The rules used so far, in the order of {@link ESCAPE_RELAXED_RULES}. */
  get rules(): readonly string[] {
    return ESCAPE_RELAXED_RULES.filter((rule) => this.#used.has(rule));
  }
}

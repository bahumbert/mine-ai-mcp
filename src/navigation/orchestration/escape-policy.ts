/**
 * The policy of an escape leg (run 15: Dirk and Sana pinned for hours). Two rules are set aside, for that leg only, and
 * every safety rule stays: the bot's own style rule against digging straight down, and the refusal to dig where the
 * only liquid a break opens into is flowing water (owner, 2026-10-18; a water source and any lava still refuse).
 */
import { standsFree } from "../movements/catalogue.js";
import type { PlannedStep } from "../movements/movement.js";
import { BREAK_UNDER_WATER, type BreakEvaluation, type MovementPolicy, type PolicyDecision } from "../movements/policy.js";
import type { BlockObservation, BlockPosition, WorldView } from "../world/world.js";

/** The rule names an escape reports (events, evidence, the action's result text). */
export const RELAXED_DIG_STRAIGHT_DOWN = "dig_straight_down";
export const RELAXED_FLOWING_WATER = "dig_next_to_flowing_water";
export const ESCAPE_RELAXED_RULES: readonly string[] = [RELAXED_DIG_STRAIGHT_DOWN, RELAXED_FLOWING_WATER];

const ALLOWED: PolicyDecision = { kind: "allowed" };

const isLiquidRefusal = (decision: PolicyDecision): boolean =>
  decision.kind === "prohibited" && (decision.cause === "opens_into_liquid" || decision.reason === BREAK_UNDER_WATER);

/** `policy` as the escape leg sees it. A policy that cannot tell flowing from source water keeps its liquid rules whole. */
export function relaxedForEscape(policy: MovementPolicy): MovementPolicy {
  const flowingOnly = policy.opensOnlyIntoFlowingWater;
  if (flowingOnly === undefined) return Object.freeze({ ...policy, allowDownward: true });
  return Object.freeze({
    ...policy,
    allowDownward: true,
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

/**
 * The policy of an escape leg (run 15: Dirk and Sana pinned for hours). Two rules are set aside, for that leg only, and
 * every safety rule stays: the bot's own style rule against digging straight down, and the refusal to dig where the
 * only liquid a break opens into is flowing water (owner, 2026-10-18; a water source and any lava still refuse).
 */
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

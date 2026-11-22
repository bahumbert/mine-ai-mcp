import { SHIELD_READY_TICKS } from "./item-use.js";
import { HEAD_TURN_LEAD_TICKS, type observeProjectileDefence } from "./shield-facing.js";

/** A shot must leave time to restore protection, not merely release its arrow. */
export function assessBowWindow(
  defence: ReturnType<typeof observeProjectileDefence>,
  remainingDrawTicks: number,
  uncertainVolley = false,
) {
  const requiredTicks = remainingDrawTicks + SHIELD_READY_TICKS + HEAD_TURN_LEAD_TICKS + 2;
  const threats = [
    ...(defence?.projectiles ?? []), ...(defence?.windupForecasts ?? []),
  ].map(({ entity, impactInTicks, earliestImpactInTicks }) => ({ id: entity.id,
    ticks: impactInTicks === null ? null : Math.min(impactInTicks, earliestImpactInTicks ?? impactInTicks) }));
  const unknown = threats.find(({ ticks }) => ticks === null);
  const earliest = unknown ?? threats.reduce<typeof threats[number] | undefined>((first, threat) =>
    !first || (threat.ticks !== null && first.ticks !== null && threat.ticks < first.ticks) ? threat : first, undefined);
  const held = (defence?.holdRemainingTicks ?? 0) > 0;
  return {
    safe: !uncertainVolley && !defence?.timingUncertain && !held && (!earliest || (earliest.ticks !== null && earliest.ticks > requiredTicks)),
    requiredTicks,
    impactInTicks: earliest?.ticks ?? null,
    threatId: earliest?.id ?? defence?.heldProjectileId ?? null,
    reason: uncertainVolley ? "uncertain_volley" : defence?.timingUncertain ? "uncertain_timing" : held ? "held_impact" : unknown ? "unknown_impact"
      : earliest ? "predicted_impact" : "clear",
  };
}

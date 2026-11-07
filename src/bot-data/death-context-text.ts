// The one-line text of a death's context, shared by the death event's summary and by read_recent_events.
import type { PlayerDeathContext } from "./event-log.js";

/** One line: what the bot held and wore, its last health, whether it was walled in, and where it would wake. */
export function describeDeathContext(context: PlayerDeathContext): string {
  const worn = Object.entries(context.armour).flatMap(([slot, item]) => (item ? [`${slot} ${item}`] : []));
  const lastHealth = context.lastAlive
    ? `${context.lastAlive.health} (${(context.lastAlive.msBefore / 1000).toFixed(1)} s before)`
    : "not seen";
  const { respawn } = context;
  const place = respawn?.kind === "bed" ? "bed" : "world spawn";
  const wakes = !respawn
    ? "unknown"
    : respawn.distance === null
      ? `${place} in another dimension`
      : `${place} ${Math.round(respawn.distance)} blocks away`;
  return [
    `held ${context.held ?? "nothing"}`,
    `armour ${worn.length > 0 ? worn.join(", ") : "none"}`,
    `food ${context.food}`,
    `last health ${lastHealth}`,
    context.enclosed ? "enclosed" : "in the open",
    `respawn ${wakes}`,
  ].join("; ");
}

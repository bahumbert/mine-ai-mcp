/** Where the bot would wake after a death, and what it wears: the two reads a player death record (`death-context.ts`) and `view_status` share. */
import type { Bot } from "mineflayer";
import { lastWake, personalRespawnObservation } from "../actions/portal-entry/respawn-knowledge.js";
import type { PlayerDeathContext } from "../bot-data/event-log.js";

/**
 * The bed slept in this session, else the last observed wake, else the world spawn. A wake is not a promise of the next.
 */
export function respawnPoint(bot: Bot): PlayerDeathContext["respawn"] {
  const here = bot.entity.position;
  const distanceTo = (dimension: string, point: { x: number; y: number; z: number }) =>
    bot.game.dimension === dimension ? Math.hypot(point.x - here.x, point.y - here.y, point.z - here.z) : null;
  const bed = personalRespawnObservation(bot);
  if (bed) return { kind: "bed", dimension: bed.dimension, ...bed.position, distance: distanceTo(bed.dimension, bed.position) };
  const wake = lastWake(bot);
  if (wake) return { kind: "last_wake", dimension: wake.dimension, ...wake.position, distance: distanceTo(wake.dimension, wake.position) };
  const spawn = bot.spawnPoint;
  if (!spawn) return null;
  return {
    kind: "world_spawn",
    dimension: "overworld",
    x: spawn.x,
    y: spawn.y,
    z: spawn.z,
    distance: distanceTo("overworld", spawn),
  };
}

/** The item name in each armour slot of the bot, null for an empty one. */
export function wornArmour(bot: Bot): { head: string | null; chest: string | null; legs: string | null; feet: string | null } {
  const slotName = (destination: "head" | "torso" | "legs" | "feet") =>
    bot.inventory.slots[bot.getEquipmentDestSlot(destination)]?.name ?? null;
  return { head: slotName("head"), chest: slotName("torso"), legs: slotName("legs"), feet: slotName("feet") };
}

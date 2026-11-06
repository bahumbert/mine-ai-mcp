/** The state a player death is recorded with (P4-01 spec D3): the last alive reading, gear, shelter and where the bot would wake. */
import type { Bot } from "mineflayer";
import { personalRespawnObservation } from "../actions/portal-entry/respawn-knowledge.js";
import type { PlayerDeathContext } from "../bot-data/event-log.js";
import { enclosedInPlace } from "../survival/responses/shelter-cells.js";
import { carriesCombatWeapon, readCombatItems, selectMeleeLoadout } from "../survival/weapons/equipment.js";
import { monotonicNow } from "../utils/monotonic-clock.js";

/** The newest health reading with the bot alive, on the monotonic clock. */
export interface LastAliveReading {
  readonly health: number;
  readonly food: number;
  readonly saturation: number;
  readonly at: number;
}

/** The reading to keep when `health` fires, or null while the bot is dead: the death packet's own zero is not "alive". */
export function aliveReading(bot: Bot): LastAliveReading | null {
  if (!(bot.health > 0)) return null;
  return { health: bot.health, food: bot.food, saturation: bot.foodSaturation, at: monotonicNow() };
}

/**
 * What the bot wore, held and stood in when it died. Read when the server's cause packet arrives, not in the `death`
 * handler: the real server clears the inventory in between (`knowledge/facts/live-testing.md` "Gear at death").
 */
export function readDeathContext(bot: Bot, lastAlive: LastAliveReading | null): PlayerDeathContext {
  const slotName = (destination: "head" | "torso" | "legs" | "feet") =>
    bot.inventory.slots[bot.getEquipmentDestSlot(destination)]?.name ?? null;
  return {
    lastAlive: lastAlive && {
      health: lastAlive.health,
      food: lastAlive.food,
      saturation: lastAlive.saturation,
      msBefore: Math.max(0, Math.round(monotonicNow() - lastAlive.at)),
    },
    food: bot.food,
    held: bot.heldItem?.name ?? null,
    armour: { head: slotName("head"), chest: slotName("torso"), legs: slotName("legs"), feet: slotName("feet") },
    carriesWeapon: carriesCombatWeapon(bot),
    bestMelee: selectMeleeLoadout(readCombatItems(bot)).weapon?.name ?? null,
    enclosed: enclosedInPlace(bot),
    respawn: respawnPoint(bot),
  };
}

/**
 * The bed the bot slept in this session, else the world spawn. A bed set before a host restart reads as world spawn and a
 * bed broken since still reads as a bed (`respawn-knowledge.ts`); the analysis corrects both. The world spawn is the
 * overworld's, which is where a death without a bed wakes the bot.
 */
function respawnPoint(bot: Bot): PlayerDeathContext["respawn"] {
  const here = bot.entity.position;
  const distanceTo = (dimension: string, point: { x: number; y: number; z: number }) =>
    bot.game.dimension === dimension ? Math.hypot(point.x - here.x, point.y - here.y, point.z - here.z) : null;
  const bed = personalRespawnObservation(bot);
  if (bed) return { kind: "bed", dimension: bed.dimension, ...bed.position, distance: distanceTo(bed.dimension, bed.position) };
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

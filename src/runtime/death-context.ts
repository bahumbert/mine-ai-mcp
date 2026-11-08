/** The state a player death is recorded with (P4-01 spec D3): the last alive reading, gear, shelter and where the bot would wake. */
import type { Bot } from "mineflayer";
import type { PlayerDeathContext } from "../bot-data/event-log.js";
import { respawnPoint, wornArmour } from "./respawn-point.js";
import { enclosedInPlace } from "../survival/responses/shelter-cells.js";
import { carriesCombatWeapon, combatReadout } from "../survival/weapons/equipment.js";
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
  return {
    lastAlive: lastAlive && {
      health: lastAlive.health,
      food: lastAlive.food,
      saturation: lastAlive.saturation,
      msBefore: Math.max(0, Math.round(monotonicNow() - lastAlive.at)),
    },
    food: bot.food,
    held: bot.heldItem?.name ?? null,
    armour: wornArmour(bot),
    carriesWeapon: carriesCombatWeapon(bot),
    bestMelee: combatReadout(bot).melee,
    enclosed: enclosedInPlace(bot),
    respawn: respawnPoint(bot),
  };
}

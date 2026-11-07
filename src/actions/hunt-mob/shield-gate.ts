// hunt_mob's shield gate: a hostile hunt is refused before the first step when the bot has nothing to block with.
import type { Bot } from "mineflayer";
import { isHostileSpecies } from "../../survival/index.js";
import { readCombatItems } from "../../survival/weapons/equipment.js";
import { hasItemFamily } from "../../world/item-families.js";
import { huntMobOutcomes, type HuntMobRequest } from "./contract.js";

/**
 * Refuse a hostile hunt that has nothing to block with.
 *
 * The gate is the species rather than the fight that follows, because the cost
 * of learning it the other way is paid in the body: a skeleton opens at range
 * and a creeper only has to arrive. Hostility is the registry's own category,
 * so the mobs whose `type` misreads them - hoglins, phantoms, slimes, magma
 * cubes, ghasts - are covered by the same rule that covers skeletons, and a
 * chicken is never asked for a shield it does not need.
 *
 * Carrying one is the test, not wearing one: the loadout moves a carried shield
 * into the off-hand when the fight starts. A policy that forbids shields makes
 * a carried one ornamental, so that is refused on the same terms.
 */
export function shieldRefusal(bot: Bot, request: HuntMobRequest, shieldPermitted: () => boolean): string | null {
  if (request.allowWithoutShield || !isHostileSpecies(bot, request.mobName)) return null;
  if (!readCombatItems(bot).some((item) => hasItemFamily(bot, item.name, "shield")))
    return huntMobOutcomes.shieldNotCarried(request.mobName);
  return shieldPermitted() ? null : huntMobOutcomes.shieldNotPermitted(request.mobName);
}

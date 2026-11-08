// hunt_mob's shield gate: a hostile hunt is refused before the first step when the bot has nothing to block with.
import type { Bot } from "mineflayer";
import { isHostileSpecies } from "../../survival/index.js";
import { isShield, readCombatItems } from "../../survival/weapons/equipment.js";
import { hasItemFamily } from "../../world/item-families.js";
import { damageScaling, mobCombatData } from "../../world/combat-data.js";
import { sameNeedItems } from "../../world/same-need.js";
import { scaleForDifficulty } from "../../survival/perception/combat/threat-assessment.js";
import type { Recipe } from "prismarine-recipe";
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
    return huntMobOutcomes.shieldNotCarried(request.mobName, shieldFacts(bot, request.mobName));
  return shieldPermitted() ? null : huntMobOutcomes.shieldNotPermitted(request.mobName);
}

/** Recipe and damage facts available before approaching a hostile species. */
function shieldFacts(bot: Bot, species: string): string {
  const shield = Object.values(bot.registry.items).find((item) => isShield(bot, item));
  const recipes = shield ? (require("prismarine-recipe") as (registry: Bot["registry"]) => { Recipe: typeof Recipe })(bot.registry).Recipe.find(shield.id, null) : [];
  const needs = recipes.map((recipe) => recipe.delta.filter((item) => item.count < 0).map((item) => ({
    name: bot.registry.items[item.id]?.name ?? String(item.id), need: -item.count,
    have: [bot.registry.items[item.id]?.name, ...sameNeedItems(bot.registry, bot.registry.items[item.id]?.name ?? "", shield?.name).items]
      .reduce((total, name) => total + (name ? bot.inventory.count(bot.registry.itemsByName[name]!.id, null) : 0), 0),
  })));
  needs.sort((a, b) => a.reduce((n, item) => n + Math.max(0, item.need - item.have), 0) - b.reduce((n, item) => n + Math.max(0, item.need - item.have), 0));
  const selected = needs[0];
  const missing = selected?.filter((item) => item.have < item.need).map((item) => `${item.name} x${item.need - item.have}`).join(", ") || "none";
  const carried = selected?.filter((item) => item.have > 0).map((item) => `${item.name} x${Math.min(item.have, item.need)}`).join(", ") || "none";
  const damage = mobCombatData(species, bot.version)?.attackDamage;
  const difficulty = bot.game?.difficulty;
  const hit = damage != null && difficulty ? `; ${species} hits for ~${scaleForDifficulty(damage, difficulty, damageScaling("mob_attack", bot.version))}` : "";
  return selected ? `a shield needs ${missing} (carried: ${carried})${hit}` : `shield recipe unavailable${hit}`;
}

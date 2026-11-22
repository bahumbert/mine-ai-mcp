// Live bot defence and the carried melee loadout, read through the existing equipment boundaries.
import type { Bot } from "mineflayer";
import { combatReadout } from "../survival/weapons/equipment.js";
import { armourPoints } from "./armour-points.js";
import { itemAttack, type ItemAttack } from "./combat-data.js";
import { entityMetadata } from "./end-fight.js";

/** Current health, absorption and the armour actually worn; unread armour contributes no points. */
export function botDefence(bot: Bot): { health: number; absorption: number; armor: number; toughness: number } {
  const absorption = entityMetadata(bot, bot.entity, "player_absorption");
  return {
    health: bot.health,
    absorption: typeof absorption === "number" && Number.isFinite(absorption) ? absorption : 0,
    ...(armourPoints(bot) ?? { armor: 0, toughness: 0 }),
  };
}

/** The fight equips its best carried melee item before swinging; the held stack alone is insufficient. */
export function meleeWeapon(bot: Bot): { item: string | null; attack: ItemAttack } {
  const item = combatReadout(bot).melee;
  return { item, attack: itemAttack(item, bot.version) };
}

/** Mineflayer files the server's difficulty on game at login and on each difficulty packet. */
export function serverDifficulty(bot: Bot): "peaceful" | "easy" | "normal" | "hard" {
  return bot.game.difficulty;
}

/**
 * The armour points the server counts for the bot: the wave's one reader (view_status, the condition line, the fight reflex's defence).
 * Measured on the real 1.21.4 server (contract check `armour-points-worn`, 2026-11-07): the own entity's `generic.armor` and `generic.armor_toughness`
 * attributes are `{ value: 0, modifiers }`, a worn piece adds a modifier and an unequip removes it. After a death the client keeps the attribute it
 * had while the gear may be gone, so no worn piece reads 0 whatever the attribute says.
 */
import type { Bot } from "mineflayer";
import { wornArmour } from "../runtime/respawn-point.js";

const ARMOUR_KEY = "generic.armor";
const TOUGHNESS_KEY = "generic.armor_toughness";

interface Attribute {
  readonly value: number;
  readonly modifiers: readonly { readonly amount: number; readonly operation: number }[];
}

/** base + operation 0 amounts, then operation 1 (of the sum), then operation 2 (of the running total): `mineflayer/lib/plugins/explosion.js:40-56`. */
function attributeValue(attribute: Attribute): number {
  const added = attribute.modifiers.reduce((total, modifier) => (modifier.operation === 0 ? total + modifier.amount : total), attribute.value);
  const scaled = attribute.modifiers.reduce((total, modifier) => (modifier.operation === 1 ? total + added * modifier.amount : total), added);
  return attribute.modifiers.reduce((total, modifier) => (modifier.operation === 2 ? total + total * modifier.amount : total), scaled);
}

const oneDecimal = (value: number) => Math.round(value * 10) / 10;

/**
 * `{ armor: 0, toughness: 0 }` when every armour slot is empty, else the attributes' values to one decimal; null when a piece is worn and the server
 * told no armour attribute (a bot that joined wearing gear has none until its first armour change): unknown, not 0.
 */
export function armourPoints(bot: Bot): { armor: number; toughness: number } | null {
  if (Object.values(wornArmour(bot)).every((item) => item === null)) return { armor: 0, toughness: 0 };
  const attributes = (bot.entity as { attributes?: Record<string, Attribute | undefined> }).attributes;
  const armor = attributes?.[ARMOUR_KEY];
  if (armor === undefined) return null;
  const toughness = attributes?.[TOUGHNESS_KEY];
  return { armor: oneDecimal(attributeValue(armor)), toughness: toughness === undefined ? 0 : oneDecimal(attributeValue(toughness)) };
}

import type { Bot } from "mineflayer";
import { familyIndexOf, type FamilyIndex } from "./item-families.js";
/** Vanilla natural regeneration requires at least this many hunger points. */
export const REGENERATION_HUNGER = 18;
type Item = ReturnType<Bot["inventory"]["items"]>[number];

/**
 * An uncooked food: one whose smelting gives a food with more points (`FamilyIndex.cookedForm`). Eating it raw
 * forfeits most of its value, so the survival raw_food rule decides when it is on the menu.
 */
export function isRawFood(index: FamilyIndex, name: string): boolean {
  return index.cookedForm(name) !== null;
}

/**
 * A food the automatic eaters may choose: in family `food`, and not in `avoided_food` (foods that each carry an effect
 * the model should weigh for itself).
 */
export function isAutoEdibleFood(index: FamilyIndex, name: string): boolean {
  const families = index.itemFamilies(name);
  return families.includes("food") && !families.includes("avoided_food");
}

export type ReflexFood = Item;

/**
 * The most filling carried food the reflex is allowed to eat, or null.
 *
 * Whether uncooked food is on the menu is the caller's decision, taken from
 * policy against the bot's current vitals; see the survival raw_food rule.
 */
export function selectReflexFood(bot: Bot, options: { readonly allowRaw: boolean }): Item | null {
  const index = familyIndexOf(bot);
  let best: Item | null = null;
  let bestPoints = -1;
  let bestSaturation = -1;
  for (const item of bot.inventory.items()) {
    // A family member without food values in the registry cannot be ranked by what it fills.
    const food = bot.registry.foodsByName[item.name];
    if (!food || !isAutoEdibleFood(index, item.name)) continue;
    if (!options.allowRaw && isRawFood(index, item.name)) continue;
    if (food.foodPoints > bestPoints || (food.foodPoints === bestPoints && food.saturation > bestSaturation)) {
      best = item;
      bestPoints = food.foodPoints;
      bestSaturation = food.saturation;
    }
  }
  return best;
}

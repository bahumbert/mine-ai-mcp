/** Collect-specific interpretations over Mineflayer's versioned facts. */
import { blockDropsData, likeliestOrdinaryDrop } from "../../world/block-drops.js";
import { enchantmentsOf } from "../../world/enchantments.js";
import type { Bot } from "mineflayer";

export function blockMatchesSelector(blockName: string, selector: string): boolean {
  if (selector === "log" || selector === "logs") return blockName.endsWith("_log");
  return blockName === selector || (selector.endsWith("_ore") && blockName === `deepslate_${selector}`);
}

function registryDropId(drop: unknown): number | null {
  if (typeof drop === "number") return drop;
  if (!drop || typeof drop !== "object") return null;
  const value = (drop as { drop?: number | { id?: number } }).drop;
  if (typeof value === "number") return value;
  return typeof value?.id === "number" ? value.id : null;
}

/**
 * Choose the inventory item Collect should observe after the equipped tool breaks this block. The version's own loot
 * tables answer first (`src/world/block-drops.ts`): minecraft-data's for 1.21.4 is the 1.20 file, whose old names and
 * missing shears conditions once needed a hand-written list here. Versions without shipped drops fall back to it.
 */
export function expectedDropName(bot: Bot, blockName: string): string {
  const silkTouch = enchantmentsOf(bot, bot.heldItem).some((enchantment) => enchantment.name === "silk_touch");
  const version = bot.version;
  const shipped = blockDropsData(version)?.blocks[blockName];
  if (shipped !== undefined) {
    if (silkTouch && shipped.some((drop) => drop.tool?.split(" or ").includes("silk_touch") === true)) return blockName;
    return likeliestOrdinaryDrop(blockName, version) ?? blockName;
  }
  const loot = bot.registry.blockLoot[blockName]?.drops.find((drop) => {
    if (drop.silkTouch) return silkTouch;
    if (drop.noSilkTouch) return !silkTouch;
    return true;
  });
  if (loot) return loot.item;

  const firstDrop = bot.registry.blocksByName[blockName]?.drops?.[0];
  const itemId = registryDropId(firstDrop);
  return (itemId === null ? null : bot.registry.items[itemId]?.name) ?? blockName;
}

export function inventoryCounts(bot: Bot): Record<string, number> {
  return bot.inventory.items().reduce<Record<string, number>>((counts, item) => {
    counts[item.name] = (counts[item.name] || 0) + item.count;
    return counts;
  }, {});
}

export function inventoryGains(
  bot: Bot,
  before: Readonly<Record<string, number>>,
  itemNames: Iterable<string>,
): Record<string, number> {
  const current = inventoryCounts(bot);
  return [...new Set(itemNames)].sort().reduce<Record<string, number>>((gains, itemName) => {
    const gained = Math.max(0, (current[itemName] || 0) - (before[itemName] || 0));
    if (gained > 0) gains[itemName] = gained;
    return gains;
  }, {});
}

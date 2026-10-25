/** Collect-specific interpretations over Mineflayer's versioned facts. */
import { blockDropsData, likeliestOrdinaryDrop, sourcesOf } from "../../world/block-drops.js";
import { tagNamesOf, tagsOf } from "../../world/block-tags.js";
import { enchantmentsOf } from "../../world/enchantments.js";
import { similarNames } from "../../world/similar-names.js";
import { recipesFor } from "../../world/smelting.js";
import type { Bot } from "mineflayer";
import { outcomes } from "./contract.js";

/** What a selector reads: the block names and the version's shipped tags. */
type SelectorBot = Pick<Bot, "registry" | "version">;

/**
 * The one selector the game's tag of the same name would mislead: `logs` is the game's tag of every log, stripped log,
 * wood block and nether stem, and a request for logs means the trees' own (owner 2026-10-19, Q3), which the game
 * keeps as `overworld_natural_logs`. Every other tag name selects the tag's own members.
 */
const SELECTOR_TAGS: Readonly<Record<string, string>> = { logs: "overworld_natural_logs" };

/** Whether the registry has a block of exactly this name (not one inherited from `Object`). */
function isBlockName(bot: SelectorBot, name: string): boolean {
  return Object.hasOwn(bot.registry.blocksByName, name);
}

/**
 * Whether `blockName` is what the request named. Sources in order: the block of that exact name (an ore also takes its
 * deepslate twin); when Minecraft has no block of that name, the members of the game's block tag of that name in the
 * bot's version, so a version with no shipped tags matches exact names only.
 */
export function blockMatchesSelector(blockName: string, selector: string, bot: SelectorBot): boolean {
  if (blockName === selector) return true;
  if (isBlockName(bot, selector)) return selector.endsWith("_ore") && blockName === `deepslate_${selector}`;
  return tagsOf(blockName, bot.version).includes(SELECTOR_TAGS[selector] ?? selector);
}

/** Whether the selector names a block or a block tag the bot's version has; the selectors of no block are refused. */
export function selectorKnown(bot: SelectorBot, selector: string): boolean {
  return isBlockName(bot, selector) || tagNamesOf(bot.version).includes(SELECTOR_TAGS[selector] ?? selector);
}

/** Whether a crafting or furnace recipe makes `item`: what to say when no block drops it. */
function isMadeByRecipe(bot: SelectorBot, item: string): boolean {
  const known = Object.hasOwn(bot.registry.itemsByName, item) ? bot.registry.itemsByName[item] : undefined;
  return (known !== undefined && (bot.registry.recipes?.[known.id]?.length ?? 0) > 0) || recipesFor(item, bot.version).length > 0;
}

/** The most blocks, and the most close names, a refusal lists: enough to choose from without a wall of text. */
const REFUSAL_LIST_LIMIT = 5;

/**
 * The refusal for a selector that is no block and no tag, ending on what to ask for instead: the blocks that drop the
 * item when it is one, else that a recipe makes it, else the registry's closest names (tag names first: `log` is one
 * letter off the tag `logs`).
 */
export function unknownSelectorStop(bot: SelectorBot, selector: string): string {
  const droppers = sourcesOf(selector, bot.version).slice(0, REFUSAL_LIST_LIMIT).map((source) => source.block);
  const closest = [
    ...new Set([
      ...similarNames(selector, [...tagNamesOf(bot.version), ...Object.keys(SELECTOR_TAGS)], 2),
      ...similarNames(selector, Object.keys(bot.registry.blocksByName), REFUSAL_LIST_LIMIT),
    ]),
  ];
  return outcomes.unknownBlock(selector, { droppers, madeByRecipe: droppers.length === 0 && isMadeByRecipe(bot, selector), closest });
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

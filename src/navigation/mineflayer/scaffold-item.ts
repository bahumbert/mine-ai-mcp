/** Which carried block a route places as scaffold: the survival policy's list first, the common-stock fallback, the reserves a caller keeps back. */
import type { Bot } from "mineflayer";
import { readNavigationPolicy } from "../../survival/state/navigation-policy.js";
import { tagsOf } from "../../world/block-tags.js";
import type { ScaffoldSelection } from "../movements/policy.js";
import { blockClass, observeMineflayerBlock } from "./world.js";

type InventoryItem = ReturnType<Bot["inventory"]["items"]>[number];

export function scaffoldBlockNames(bot: Bot): readonly string[] {
  return readNavigationPolicy(bot).scaffold_blocks;
}

/** No reserve: every carried block may be placed. */
export const NO_RESERVE: ReadonlyMap<string, number> = new Map();

/** Whether everything carried of an item (all its stacks) is no more than the count the caller keeps back of it. */
function atReserve(items: readonly { readonly name: string; readonly count: number }[], name: string, reserved: ReadonlyMap<string, number>): boolean {
  const reserve = reserved.get(name);
  if (reserve === undefined) return false;
  return items.reduce((total, item) => total + (item.name === name ? item.count : 0), 0) <= reserve;
}

/**
 * First carried block admitted by the policy's explicit preference order, one kept by name never, one at its reserved
 * count (`reserved`: item to the count kept back) not either.
 */
export function preferredScaffoldItem(bot: Bot, protectedNames: ReadonlySet<string> = new Set(), reserved: ReadonlyMap<string, number> = NO_RESERVE) {
  const carried = bot.inventory.items();
  for (const name of scaffoldBlockNames(bot)) {
    if (protectedNames.has(name)) continue;
    const item = carried.find((candidate) => candidate.name === name);
    if (!item || atReserve(carried, name, reserved)) continue;
    const block = bot.registry.blocksByName[name];
    if (!block) continue;
    const { geometry, traits } = observeMineflayerBlock(blockClass(bot).fromStateId(block.defaultState, 0));
    if (geometry.fullCube && geometry.safeSupport && !traits.interactive && !traits.falling && traits.liquid === null)
      return item;
  }
  return null;
}

/**
 * The block tags that mark the game's own common terrain and building stock: the
 * stones, dirts, planks, bricks and terracotta a player builds with freely. A
 * valuable (a metal or gem block), a log, a wool or a workstation is in none of them.
 */
const FALLBACK_SCAFFOLD_TAGS = ["base_stone_overworld", "base_stone_nether", "dirt", "planks", "stone_bricks", "terracotta"] as const;

/**
 * The carried block a route may bridge with when the bot has none of the survival
 * policy's `scaffold_blocks` and no route exists without one (a bot stranded on a
 * perch). Among the carried blocks that are a full solid cube to stand on, not
 * falling, not interactive and in a common-stock tag, the one carried most of; the
 * policy's own list is never consulted here, `preferredScaffoldItem` owns that. A block kept by name or at its reserved
 * count is set aside.
 */
export function fallbackScaffoldItem(bot: Bot, protectedNames: ReadonlySet<string> = new Set(), reserved: ReadonlyMap<string, number> = NO_RESERVE) {
  let best: InventoryItem | null = null;
  const carried = bot.inventory.items();
  for (const item of carried) {
    if (protectedNames.has(item.name) || atReserve(carried, item.name, reserved) || (best !== null && best.count >= item.count)) continue;
    const block = bot.registry.blocksByName[item.name];
    if (!block) continue;
    if (!tagsOf(item.name, bot.version).some((tag) => (FALLBACK_SCAFFOLD_TAGS as readonly string[]).includes(tag))) continue;
    const { geometry, traits } = observeMineflayerBlock(blockClass(bot).fromStateId(block.defaultState, 0));
    if (geometry.fullCube && geometry.safeSupport && !traits.interactive && !traits.falling && traits.liquid === null)
      best = item;
  }
  return best;
}

/** The block and placement states a route places now, or null: scaffolding off, or nothing carried that the kept and reserved sets leave. */
export function scaffoldSelection(
  bot: Bot,
  protectedNames: ReadonlySet<string>,
  reserved: ReadonlyMap<string, number>,
  enabled: boolean,
  fallback: boolean,
): ScaffoldSelection | null {
  if (!enabled) return null;
  const item = preferredScaffoldItem(bot, protectedNames, reserved) ?? (fallback ? fallbackScaffoldItem(bot, protectedNames, reserved) : null);
  if (!item) return null;
  const block = bot.registry.blocksByName[item.name]!;
  const reserve = reserved.get(item.name) ?? 0;
  if (!block.states?.some((state) => state.name === "axis"))
    return { itemType: item.type, stateId: block.defaultState, reserve };
  const Block = blockClass(bot);
  const stateFor = (axis: string) => Block.fromProperties(block.id, { axis }, 0).stateId;
  return {
    itemType: item.type,
    stateId: block.defaultState,
    reserve,
    stateIdByAxis: { x: stateFor("x"), y: stateFor("y"), z: stateFor("z") },
  };
}

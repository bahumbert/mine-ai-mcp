// Which blocks a hole burial keeps back so the hole can always be plugged (run 16: 170 cobblestone back 16 s later).
import type { Bot } from "mineflayer";
import { fallbackScaffoldItem, preferredScaffoldItem } from "../../navigation/mineflayer/movement-policy.js";
import { carriedCount } from "../../world/inventory-count.js";

/** The cells above a pit's discards a burial plugs: the lower plug and the ground-level one. */
export const PLUG_CELLS = 2;

/** The block a burial keeps carried for the plug, and how many. */
export interface PlugKeep {
  readonly item: string;
  readonly count: number;
}

/** The plug block the hole would use among the carried names not in `excluded`: the policy's list, else common stock. */
function plugBlockNamed(bot: Bot, excluded: ReadonlySet<string>): string | null {
  return (preferredScaffoldItem(bot, excluded) ?? fallbackScaffoldItem(bot, excluded))?.name ?? null;
}

/** How many plug blocks stay carried once `tosses` are buried, up to `PLUG_CELLS`. */
function plugBlocksLeft(bot: Bot, tosses: ReadonlyMap<string, number>): number {
  const left = (name: string) => Math.max(0, carriedCount(bot, name) - (tosses.get(name) ?? 0));
  const excluded = new Set(bot.inventory.items().map((item) => item.name).filter((name) => left(name) === 0));
  let found = 0;
  while (found < PLUG_CELLS) {
    const name = plugBlockNamed(bot, excluded);
    if (name === null) break;
    excluded.add(name);
    found += left(name);
  }
  return found;
}

/** Whether `name` is a block the plug would take when it is the only one carried. */
function isPlugCapable(bot: Bot, name: string): boolean {
  const others = new Set(bot.inventory.items().map((item) => item.name).filter((other) => other !== name));
  return plugBlockNamed(bot, others) === name;
}

/**
 * Plan what a burial keeps for the plug. `tosses` is, per requested item, how many the request still buries. When fewer
 * than `PLUG_CELLS` plug blocks would stay carried, the missing ones are kept from the first requested item that is a
 * plug block, never the whole burial (at least one item is still buried). A request that buries no plug block keeps
 * nothing: it ends with the hole open, as before.
 */
export function planPlugKeep(bot: Bot, tosses: ReadonlyMap<string, number>): PlugKeep | null {
  const missing = PLUG_CELLS - plugBlocksLeft(bot, tosses);
  if (missing <= 0) return null;
  const buried = [...tosses.values()].reduce((sum, count) => sum + count, 0);
  for (const [name, toss] of tosses) {
    if (toss <= 0 || !isPlugCapable(bot, name)) continue;
    const count = Math.min(missing, toss, buried - 1);
    return count > 0 ? { item: name, count } : null;
  }
  return null;
}

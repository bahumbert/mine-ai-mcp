// What a fetch never spends or burns: the items open trades owe and the unfinished house's bill reserves, and the bag without them.
import { freeStacks, heldCounts, type OwedItem } from "../relations/items.ts";
import type { ItemCount } from "../runtime-client.ts";
import type { GatherContext } from "./gather-materials.ts";
import { carried, type Stacks } from "./stacks.ts";

/** The counts of what `inventory` holds, one entry per item. */
export function bagCounts(inventory: Stacks): ItemCount[] {
  return [...new Set(inventory.map((stack) => stack.name))].map((item) => ({ item, count: carried(inventory, item) }));
}

/**
 * What open trades owe and what the house's bill reserves, as far as it is carried, one count per item (the sum, capped at
 * what is carried: blocks given in a trade leave the bag, and the house still needs its own): what crafting never spends and
 * the furnace never burns.
 */
export function heldWithReserve(owed: readonly OwedItem[], reserve: readonly ItemCount[], inventory: Stacks): Map<string, number> {
  const held = heldCounts(owed, inventory);
  for (const { item, count } of reserve) {
    const have = Math.min(carried(inventory, item), count + (held.get(item) ?? 0));
    if (have > 0) held.set(item, have);
  }
  return held;
}

/** The bag without what open trades owe and the bill reserves, read from the live `owed()` each round (a trade may have ended): the furnace burns and smelts only this. */
export function freeBag(context: GatherContext, inventory: Stacks): Stacks {
  return freeStacks(inventory, heldWithReserve(context.owed?.() ?? [], context.reserve ?? [], inventory));
}

/** `kept` plus what open trades owe, raw or made (a get-back holds every trade's items, its own included): crafting never spends it, a craft that did is fetched again. */
export function keptWithOwed(kept: readonly ItemCount[], held: ReadonlyMap<string, number>): ItemCount[] {
  const merged = new Map(kept.map((entry) => [entry.item, entry.count]));
  for (const [item, count] of held) merged.set(item, Math.max(count, merged.get(item) ?? 0));
  return [...merged].map(([item, count]) => ({ item, count }));
}

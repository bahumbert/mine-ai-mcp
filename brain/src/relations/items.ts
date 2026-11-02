// Item lists as the trade code reads them: the words a side is told in, and what an inventory carries of an item.
import { shortfall, type MaterialCount } from "../building/blueprint.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import type { ItemCount } from "./types.ts";

/** "2 oak_log, 1 iron_ingot": one side of a trade, as the model and the logs read it. */
export const sideText = (items: readonly ItemCount[]): string => items.map((i) => `${i.count} ${i.item}`).join(", ");

/** How many of an item the inventory holds, over all its stacks. */
export const carriedOf = (inventory: BotSnapshot["inventory"], item: string): number => inventory.filter((s) => s.name === item).reduce((sum, s) => sum + s.count, 0);

/** My side not yet given of one agreed trade, as `SkillContext.owed` lists it. */
export interface OwedItem extends ItemCount {
  readonly partner: string;
  readonly tradeId: string;
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The owed entries of an item that hold it back from `partner` (every trade but theirs). */
const heldBack = (owed: readonly OwedItem[], item: string, partner?: string): OwedItem[] =>
  owed.filter((o) => o.item === item && (partner === undefined || !sameName(o.partner, partner)));

/** How many of an item the other agreed trades owe (every trade but `partner`'s), whatever the bag holds. */
export const heldTotal = (owed: readonly OwedItem[], item: string, partner?: string): number =>
  heldBack(owed, item, partner).reduce((sum, o) => sum + o.count, 0);

/** How many of the carried count may go to `partner` (anyone when unnamed): carried minus what every other agreed trade owes of the item. */
export const spareFor = (carried: number, owed: readonly OwedItem[], item: string, partner?: string): number =>
  Math.max(0, carried - heldTotal(owed, item, partner));

/** The owed items the bag holds back, per item: the owed count cut to what is carried (an item not carried is absent). */
export function heldCounts(owed: readonly OwedItem[], inventory: BotSnapshot["inventory"], partner?: string): Map<string, number> {
  const held = new Map<string, number>();
  for (const item of new Set(owed.map((o) => o.item))) {
    const count = Math.min(heldTotal(owed, item, partner), carriedOf(inventory, item));
    if (count > 0) held.set(item, count);
  }
  return held;
}

/** The kinds with no spare (owed and carried no more than owed): the ones automatic work never picks as junk, scaffold or roof. */
export const heldKinds = (owed: readonly OwedItem[], inventory: BotSnapshot["inventory"]): Set<string> =>
  new Set([...heldCounts(owed, inventory)].filter(([item, count]) => count >= carriedOf(inventory, item)).map(([item]) => item));

/** The bag minus the held counts, taken off the last stacks of each kind first; an emptied stack is removed. */
export function freeStacks<S extends { readonly name: string; readonly count: number }>(inventory: readonly S[], held: ReadonlyMap<string, number>): S[] {
  const left = new Map(held);
  const free = [...inventory].reverse().map((stack) => {
    const take = Math.min(left.get(stack.name) ?? 0, stack.count);
    left.set(stack.name, (left.get(stack.name) ?? 0) - take);
    return { ...stack, count: stack.count - take };
  });
  return free.filter((stack) => stack.count > 0).reverse();
}

/**
 * What a step did to the owed items: for each item that fell during it (`before` to `after`) below what the other
 * trades owe, "you now carry <a> <item> of the <n> you owe <partners> (trade)"; empty when none did. `partner` is the
 * player a give went to: their own trade is not held back from them.
 */
export function owedUsed(owed: readonly OwedItem[], before: BotSnapshot["inventory"], after: BotSnapshot["inventory"], partner?: string): string {
  return [...new Set(owed.map((o) => o.item))].flatMap((item) => {
    const held = heldTotal(owed, item, partner);
    const now = carriedOf(after, item);
    if (held === 0 || now >= held || now >= carriedOf(before, item)) return [];
    const partners = [...new Set(heldBack(owed, item, partner).map((o) => o.partner))].join(", ");
    return [`you now carry ${now} ${item} of the ${held} you owe ${partners} (trade)`];
  }).join("; ");
}

/** "1 crafting_table to Ayla, 2 crafting_table to Bruno": the trades that hold the item back from `partner`; empty when none. */
export const owedText = (owed: readonly OwedItem[], item: string, partner?: string): string =>
  heldBack(owed, item, partner).map((o) => `${o.count} ${o.item} to ${o.partner}`).join(", ");

/**
 * What a bill of materials lacks once the owed counts are kept out of the bag, and a note naming the missing blocks
 * that are owed ones (the bag held them but a trade owes them); the note is empty when the owed items made no difference.
 */
export function billShortfall(bill: readonly MaterialCount[], inventory: BotSnapshot["inventory"], owed: readonly OwedItem[]): { readonly missing: MaterialCount[]; readonly owedNote: string } {
  const missing = shortfall(bill, freeStacks(inventory, heldCounts(owed, inventory)));
  const plain = shortfall(bill, inventory);
  const notes = missing.flatMap(({ item, count }) => {
    const owedPart = count - (plain.find((entry) => entry.item === item)?.count ?? 0);
    return owedPart > 0 ? [`${owedPart} ${item} you carry are owed: ${owedText(owed, item)} (trade)`] : [];
  });
  return { missing, owedNote: notes.join("; ") };
}

/** The fact for an item the bag holds only for the trades that owe it ("you owe 4 bread to Ayla (trade); you carry no bread beyond it"); null when a spare is carried or nothing is owed. */
export function noSpareFact(owed: readonly OwedItem[], inventory: BotSnapshot["inventory"], item: string): string | null {
  const holding = owedText(owed, item);
  return holding === "" || spareFor(carriedOf(inventory, item), owed, item) > 0 ? null : `you owe ${holding} (trade); you carry no ${item} beyond it`;
}

/** What a bag may spend of an item: carried minus the reserved counts and the held ones (may be negative: nothing to spend). */
export const spareCounter = (reserved: readonly ItemCount[], held: ReadonlyMap<string, number>) => (stacks: BotSnapshot["inventory"]) => (item: string): number =>
  carriedOf(stacks, item) - (reserved.find((entry) => entry.item === item)?.count ?? 0) - (held.get(item) ?? 0);

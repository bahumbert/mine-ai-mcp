// Item lists as the trade code reads them: the words a side is told in, and what an inventory carries of an item.
import { shortfall, type MaterialCount } from "../building/blueprint.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import type { ItemCount } from "./types.ts";

/** "2 oak_log, 1 iron_ingot": one side of a trade, as the model and the logs read it. */
export const sideText = (items: readonly ItemCount[]): string => items.map((i) => `${i.count} ${i.item}`).join(", ");

/** How many of an item the inventory holds, over all its stacks. */
export const carriedOf = (inventory: BotSnapshot["inventory"], item: string): number => inventory.filter((s) => s.name === item).reduce((sum, s) => sum + s.count, 0);

/** My side not yet given of one agreed trade, as `SkillContext.owed` lists it; or, with `held`, their payment I hold for a trade that ended (`heldOwed`). */
export interface OwedItem extends ItemCount {
  readonly partner: string;
  readonly tradeId: string;
  /** Set only for a payment held for an ended trade: it is theirs and kept from other work, not a promise of mine. */
  readonly held?: true;
}

/** How a held payment is worded after "N item <partner>": the same story as the model's own held line (`describeHeld`). */
const HELD_TAIL = "handed over for a trade that ended, not given back";

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
 * trades owe or hold, "you now carry <a> <item> of the <n> you owe <partners> (trade)" for agreed entries and "... of the
 * <n> <partners> handed over for a trade that ended, not given back" for held ones (both when an item has both); empty
 * when none did. `partner` is the player a give went to: their own trade is not held back from them.
 */
export function owedUsed(owed: readonly OwedItem[], before: BotSnapshot["inventory"], after: BotSnapshot["inventory"], partner?: string): string {
  return [...new Set(owed.map((o) => o.item))].flatMap((item) => {
    const held = heldTotal(owed, item, partner);
    const now = carriedOf(after, item);
    if (held === 0 || now >= held || now >= carriedOf(before, item)) return [];
    const entries = heldBack(owed, item, partner);
    const part = (isHeld: boolean, wording: (count: number, partners: string) => string): string[] => {
      const of = entries.filter((o) => (o.held === true) === isHeld);
      return of.length === 0 ? [] : [wording(of.reduce((sum, o) => sum + o.count, 0), [...new Set(of.map((o) => o.partner))].join(", "))];
    };
    const owing = part(false, (count, partners) => `of the ${count} you owe ${partners} (trade)`);
    const holding = part(true, (count, partners) => `of the ${count} ${partners} ${HELD_TAIL}`);
    return [`you now carry ${now} ${item} ${[...owing, ...holding].join(" and ")}`];
  }).join("; ");
}

/** The agreed entries as "1 crafting_table to Ayla, 2 crafting_table to Bruno". */
const agreedWords = (entries: readonly OwedItem[]): string => entries.filter((o) => o.held !== true).map((o) => `${o.count} ${o.item} to ${o.partner}`).join(", ");
/** The held entries as "5 iron_ingot Theo handed over for a trade that ended, not given back". */
const heldWords = (entries: readonly OwedItem[]): string => entries.filter((o) => o.held === true).map((o) => `${o.count} ${o.item} ${o.partner} ${HELD_TAIL}`).join(", ");
const joinParts = (parts: readonly string[]): string => parts.filter((p) => p !== "").join("; ");

/** The entries that hold the item back from `partner`, as the start of a sentence: "you owe <agreed> (trade)" for agreed entries, "you hold <held>" for held ones, both joined by "; "; empty when none. */
export const owedSentence = (owed: readonly OwedItem[], item: string, partner?: string): string => {
  const entries = heldBack(owed, item, partner);
  const agreed = agreedWords(entries);
  const held = heldWords(entries);
  return joinParts([agreed === "" ? "" : `you owe ${agreed} (trade)`, held === "" ? "" : `you hold ${held}`]);
};

/** What keeps `items` from a give to `partner` after a fetch: "owed to another agreed trade", "held for a trade that ended (...)" or both. */
export function holdsBack(owed: readonly OwedItem[], items: readonly string[], partner: string): string {
  const entries = items.flatMap((item) => heldBack(owed, item, partner));
  const heldToo = entries.some((o) => o.held === true);
  const agreedToo = entries.some((o) => o.held !== true);
  const held = "held for a trade that ended (handed over to me, not given back)";
  return heldToo && agreedToo ? `owed to another agreed trade and ${held}` : heldToo ? held : "owed to another agreed trade";
}

/**
 * What a bill of materials lacks once the owed counts are kept out of the bag, and a note naming the missing blocks
 * that are owed ones (the bag held them but a trade owes them); the note is empty when the owed items made no difference.
 */
export function billShortfall(bill: readonly MaterialCount[], inventory: BotSnapshot["inventory"], owed: readonly OwedItem[]): { readonly missing: MaterialCount[]; readonly owedNote: string } {
  const missing = shortfall(bill, freeStacks(inventory, heldCounts(owed, inventory)));
  const plain = shortfall(bill, inventory);
  const notes = missing.flatMap(({ item, count }) => {
    const owedPart = count - (plain.find((entry) => entry.item === item)?.count ?? 0);
    if (owedPart <= 0) return [];
    const entries = heldBack(owed, item);
    const agreed = agreedWords(entries);
    const held = heldWords(entries);
    return [`${owedPart} ${item} you carry are ${joinParts([agreed === "" ? "" : `owed: ${agreed} (trade)`, held === "" ? "" : `held: ${held}`])}`];
  });
  return { missing, owedNote: notes.join("; ") };
}

/** The fact for an item the bag holds only for the trades that owe it or hold it ("you owe 4 bread to Ayla (trade); you carry no bread beyond it"); null when a spare is carried or nothing is owed. */
export function noSpareFact(owed: readonly OwedItem[], inventory: BotSnapshot["inventory"], item: string): string | null {
  const holding = owedSentence(owed, item);
  return holding === "" || spareFor(carriedOf(inventory, item), owed, item) > 0 ? null : `${holding}; you carry no ${item} beyond it`;
}

/** What a bag may spend of an item: carried minus the reserved counts and the held ones (may be negative: nothing to spend). */
export const spareCounter = (reserved: readonly ItemCount[], held: ReadonlyMap<string, number>) => (stacks: BotSnapshot["inventory"]) => (item: string): number =>
  carriedOf(stacks, item) - (reserved.find((entry) => entry.item === item)?.count ?? 0) - (held.get(item) ?? 0);

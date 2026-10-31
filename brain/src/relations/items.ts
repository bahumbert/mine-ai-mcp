// Item lists as the trade code reads them: the words a side is told in, and what an inventory carries of an item.
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

/** How many of the carried count may go to `partner` (anyone when unnamed): carried minus what every other agreed trade owes of the item. */
export const spareFor = (carried: number, owed: readonly OwedItem[], item: string, partner?: string): number =>
  Math.max(0, carried - heldBack(owed, item, partner).reduce((sum, o) => sum + o.count, 0));

/** "1 crafting_table to Ayla, 2 crafting_table to Bruno": the trades that hold the item back from `partner`; empty when none. */
export const owedText = (owed: readonly OwedItem[], item: string, partner?: string): string =>
  heldBack(owed, item, partner).map((o) => `${o.count} ${o.item} to ${o.partner}`).join(", ");

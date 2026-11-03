// A payment the bot holds for a trade that ended without its side given: kept from automatic work, and cleared when it is given back or the side is paid.
import type { RelationBook } from "./book.ts";
import type { OwedItem } from "./items.ts";
import { withTrade } from "./record.ts";
import { giveBack, giveLate, type HeldWindow, heldPayment } from "./trade.ts";
import type { ItemCount, Trade } from "./types.ts";

/** What the held payments of the given trades are, as the brain's own work must treat them (owed to their partner). */
export function heldOwed(trades: readonly Trade[], within: HeldWindow): OwedItem[] {
  return trades.flatMap((t) => heldPayment(t, within).map((h) => ({ ...h, partner: t.partner, tradeId: t.id })));
}

/** Saves a trade that moved by a late give or a give-back: no state change, no facts, no score. */
export function saveHeldTrade(book: RelationBook, trade: Trade, within: HeldWindow): Promise<unknown> {
  return book.update(trade.partner, (r) => withTrade(r, trade, within));
}

/** A toss of my side taken after the trade ended (or a `give_item` outside any trade): counts as handed over; the whole side out closes the line. Returns whether anything was counted. */
export async function countLateToss(book: RelationBook, trade: Trade, taken: readonly ItemCount[], within: HeldWindow, log: (line: string) => void): Promise<boolean> {
  const { trade: next, used } = giveLate(trade, taken, within.now);
  if (used.length === 0) return false;
  await saveHeldTrade(book, next, within);
  log(`trade: ${used.map((u) => `${u.count} ${u.item}`).join(", ")} given late to ${trade.partner} for ${trade.id}${next.gaveAt !== null ? "; my side is all given now" : ""}`);
  return true;
}

/**
 * A `give_item` to `partner` outside any open trade, matched against the trades that still hold their payment (oldest end first):
 * their payment goes back, else an item of my own side is paid late. Returns how many of the count matched none (it goes to the earlier ledger).
 */
export async function giveToHeldTrades(book: RelationBook, partner: string, item: string, count: number, within: HeldWindow, log: (line: string) => void): Promise<number> {
  const held = book.trades().filter((t) => t.partner.toLowerCase() === partner.toLowerCase() && heldPayment(t, within).length > 0)
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  let left = count;
  for (const trade of held) {
    if (left <= 0) break;
    const back = giveBack(trade, item, left);
    if (back.used > 0) {
      await saveHeldTrade(book, back.trade, within);
      log(`trade: ${back.used} ${item} given back to ${partner} for ${trade.id}`);
      left -= back.used;
    } else if (await countLateToss(book, trade, [{ item, count: left }], within, log)) {
      const room = trade.give.find((g) => g.item === item)?.count ?? 0;
      left -= Math.min(left, room - (trade.gaveSome.find((g) => g.item === item)?.count ?? 0));
    }
  }
  return left;
}

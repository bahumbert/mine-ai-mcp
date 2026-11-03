// What the partner's own record of a trade (a character of this brain) shows received, against what my side has credited of it.
import type { TradeBoard } from "./board.ts";
import type { RelationBook } from "./book.ts";
import type { GiveBook } from "./gives.ts";
import { countLateToss } from "./held.ts";
import { sideText } from "./items.ts";
import { isOpen } from "./trade.ts";
import type { HeldWindow } from "./trade.ts";
import type { ItemCount, Trade } from "./types.ts";

/**
 * The items of my side the partner's record shows received that I have not credited: its received count, capped at my side, less
 * what I credited (`credited`, by item: the open trade's gives, or what the ended trade holds as given). Nothing once my side is out.
 */
export function unclaimedOf(trade: Trade, credited: ReadonlyMap<string, number>, theirs: readonly ItemCount[]): ItemCount[] {
  if (trade.gaveAt !== null) return [];
  return trade.give.flatMap(({ item, count }) => {
    const shown = Math.min(count, theirs.find((r) => r.item === item)?.count ?? 0);
    const left = shown - (credited.get(item) ?? 0);
    return left > 0 ? [{ item, count: left }] : [];
  });
}

/** What the controller lends the partner-record reads. */
export interface PartnerRecordHost {
  readonly book: RelationBook;
  readonly board: TradeBoard | undefined;
  readonly gives: GiveBook;
  readonly log: (line: string) => void;
  find(tradeId: string): Trade | undefined;
  givePending(tradeId: string): boolean;
  heldWindow(): HeldWindow;
  /** Saves my side as given when every item is credited. */
  giveIfCovered(trade: Trade, partner: string): Promise<boolean>;
}

/** Reads the record of a partner that is a character of this brain, and counts the tosses it shows that no packet showed me. */
export class PartnerRecord {
  constructor(private readonly host: PartnerRecordHost) {}

  /** The items of my side the partner's record shows received that I have not credited; null when it is no character of this brain or holds no such trade. */
  unclaimed(tradeId: string): ItemCount[] | null {
    const trade = this.host.find(tradeId);
    const theirs = trade === undefined ? null : this.host.board?.receivedBy(trade.partner, tradeId) ?? null;
    if (trade === undefined || theirs === null) return null;
    const credited = isOpen(trade) ? this.host.gives.givenOf(tradeId) : new Map(trade.gaveSome.map((g) => [g.item, g.count]));
    return unclaimedOf(trade, credited ?? new Map(), theirs);
  }

  /**
   * Counts what the partner's record shows received that I did not credit (a toss taken after my wait ran out): given now, or
   * late when the trade ended. Not while my give runs: it credits what it saw taken itself when it ends.
   */
  async claim(tradeId: string): Promise<void> {
    const trade = this.host.find(tradeId);
    const unclaimed = trade === undefined || this.host.givePending(tradeId) ? [] : this.unclaimed(tradeId) ?? [];
    if (trade === undefined || unclaimed.length === 0) return;
    if (!isOpen(trade)) return void (await countLateToss(this.host.book, trade, unclaimed, this.host.heldWindow(), this.host.log));
    if (trade.state !== "agreed" && trade.state !== "they_gave") return;
    for (const { item, count } of unclaimed) this.host.gives.credit(trade, item, count);
    this.host.log(`trade: ${trade.partner}'s record shows ${sideText(unclaimed)} received for ${tradeId}; counted given`);
    await this.host.giveIfCovered(trade, trade.partner);
  }

  /** Every trade of mine with a character of this brain that still holds items to give, open or ended within the held window. */
  async claimAll(): Promise<void> {
    const within = this.host.heldWindow();
    for (const trade of this.host.book.trades()) {
      const recent = isOpen(trade) || (trade.state !== "done" && within.now - (trade.endedAt ?? within.now) < within.ms);
      if (trade.gaveAt === null && trade.give.length > 0 && recent && this.host.board?.isLocal(trade.partner) === true) await this.claim(trade.id);
    }
  }
}

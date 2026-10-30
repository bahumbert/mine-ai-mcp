// What arrives for a trade without a partner the bot saw hand it over: the per-trade baseline of what was carried at agreement, and the collect fallback's start.
import { manhattan } from "../conversation/state.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";
import { COLLECT_RADIUS, type Handoff } from "./handoff.ts";
import { carriedOf } from "./items.ts";
import { creditTrade, isOpen, owedItems, partnerPosition } from "./trade.ts";
import type { ItemCount, Trade } from "./types.ts";

/** A partner's line after agreement starts this watch for their payment before the collect fallback. */
export const COLLECT_WATCH_MS = 5_000;


/**
 * Receipt read from the inventory, not from an action's answer. At agreement each trade notes how much of each owed item
 * the bag holds and how much every credit since the start explained; later, what the bag gained beyond the credits made
 * after that point is what arrived unseen (items walked over after the partner tossed them). Memory only: a restart
 * loses the baselines, and a trade with none is credited nothing here.
 */
export class Arrivals {
  /** Item -> everything credited to any trade, or explained by my own step, so far. */
  private readonly explained = new Map<string, number>();
  /** Trade id -> item -> the carried count and the explained total when the trade was agreed. */
  private readonly baselines = new Map<string, Map<string, { readonly carried: number; readonly explained: number }>>();

  /** Counts credits (and my own step's yields) as accounted for: they are no arrival. */
  explain(items: readonly ItemCount[]): void {
    for (const { item, count } of items) this.explained.set(item, (this.explained.get(item) ?? 0) + Math.max(0, count));
  }

  /** The baseline of an agreed trade: what the bag holds of each owed item now, after the earlier ledger's credit. */
  start(trade: Trade, carried: BotSnapshot["inventory"]): void {
    const owed = owedItems(trade);
    if (owed.length === 0) return;
    this.baselines.set(trade.id, new Map(owed.map((o) => [o.item, { carried: carriedOf(carried, o.item), explained: this.explained.get(o.item) ?? 0 }])));
  }

  forget(tradeId: string): void { this.baselines.delete(tradeId); }

  /** A tick with no previous inventory counted no gain: what the bag gained meanwhile is nobody's payment, so the baselines start again from it. */
  rebase(trades: readonly Trade[], carried: BotSnapshot["inventory"]): void {
    for (const t of trades) if (this.baselines.has(t.id)) this.start(t, carried);
  }

  /**
   * The open trades (oldest agreement first) the unseen arrivals pay, for those `wanted`: each credit is explained at once,
   * so a later trade owing the same item shares only what is left.
   */
  credits(trades: readonly Trade[], o: { readonly inventory: BotSnapshot["inventory"]; readonly ownStepYields: ReadonlySet<string>; readonly now: number; readonly wanted: (t: Trade) => boolean }): { trade: Trade; next: Trade; used: readonly ItemCount[] }[] {
    const out: { trade: Trade; next: Trade; used: readonly ItemCount[] }[] = [];
    const open = trades.filter((t) => isOpen(t) && owedItems(t).length > 0).sort((a, b) => (a.agreedAt ?? a.createdAt) - (b.agreedAt ?? b.createdAt));
    for (const trade of open.filter(o.wanted)) {
      const { trade: next, used } = creditTrade(trade, this.arrived(trade, o.inventory, o.ownStepYields), o.now);
      if (used.length === 0) continue;
      this.explain(used);
      out.push({ trade, next, used });
    }
    return out;
  }

  /** Per owed item: what the bag gained since the agreement that no credit and none of my own steps explains, capped at what is still owed. */
  arrived(trade: Trade, carried: BotSnapshot["inventory"], ownStepYields: ReadonlySet<string>): ItemCount[] {
    const base = this.baselines.get(trade.id);
    if (base === undefined) return [];
    const out: ItemCount[] = [];
    for (const { item, count } of owedItems(trade)) {
      const at = base.get(item);
      if (at === undefined || ownStepYields.has(item)) continue;
      const gained = carriedOf(carried, item) - at.carried - ((this.explained.get(item) ?? 0) - at.explained);
      if (gained > 0) out.push({ item, count: Math.min(count, gained) });
    }
    return out;
  }
}

/** What the collect fallback reads of the controller. */
export interface CollectView {
  /** The hand-offs asked for and not ended, by trade id: a collect started here is added. */
  readonly pending: Map<string, "give" | "collect">;
  readonly find: (tradeId: string) => Trade | undefined;
  readonly partners: ReadonlyMap<string, Position | null>;
  readonly position: Position | null;
}

/**
 * The fallback for a partner who paid by dropping items: a line of theirs after the agreement starts a short watch, a
 * collect picks up what they left, and the bag is read for what arrived unseen (`arrivals`). Memory only.
 */
export class CollectFallback {
  readonly arrivals = new Arrivals();
  /** Trade id -> when the partner's line started the wait for their payment. */
  private readonly watches = new Map<string, number>();
  private readonly collected = new Set<string>();
  /** Trades whose collect ended: the next tick reads the bag for them. */
  private readonly recheck = new Set<string>();

  /** A line of the partner starts the watch of each agreed trade with them that is still owed and was agreed by then, once. */
  heard(trades: readonly Trade[], speaker: string, at: number): void {
    for (const t of trades) {
      const waiting = (t.state === "agreed" || t.state === "i_gave") && owedItems(t).length > 0 && (t.agreedAt ?? Infinity) <= at;
      if (waiting && t.partner.toLowerCase() === speaker.toLowerCase() && !this.collected.has(t.id) && !this.watches.has(t.id)) this.watches.set(t.id, at);
    }
  }

  /** The trade was paid in part or whole by a credit: its watch is over. */
  paid(tradeId: string): void { this.watches.delete(tradeId); }

  /** A collect ended, whatever its outcome. */
  collectEnded(tradeId: string): void { this.recheck.add(tradeId); }

  /** The trade ended: everything held for it goes. */
  forget(tradeId: string): void {
    for (const held of [this.watches, this.collected, this.recheck]) held.delete(tradeId);
    this.arrivals.forget(tradeId);
  }

  /** The trades whose bag is read now: a collect just ended (once), or a watch has run its 5 s with the partner in reach and no hand-off pending. */
  readNow(view: CollectView, now: number): Set<string> {
    const ids = new Set([...this.recheck, ...this.due(view, now)]);
    this.recheck.clear();
    return ids;
  }

  /** The partner spoke after agreeing and nothing came in 5 s while they stand near: pick up what they may have dropped, once. */
  start(view: CollectView, now: number, take: (h: Handoff) => void): void {
    for (const id of this.due(view, now)) {
      const trade = view.find(id);
      if (trade === undefined) continue;
      this.watches.delete(id);
      this.collected.add(id);
      view.pending.set(id, "collect");
      take({ kind: "collect", tradeId: id, items: owedItems(trade) });
    }
  }

  /** Watches due now; a watch of a closed or fully paid trade is dropped. */
  private due(view: CollectView, now: number): string[] {
    const due: string[] = [];
    for (const [id, since] of this.watches) {
      const trade = view.find(id);
      if (trade === undefined || !isOpen(trade) || owedItems(trade).length === 0) {
        this.watches.delete(id);
        continue;
      }
      const there = partnerPosition(view.partners, trade.partner);
      const near = there !== null && view.position !== null && manhattan(view.position, there) <= COLLECT_RADIUS;
      if (now - since >= COLLECT_WATCH_MS && near && !view.pending.has(id)) due.push(id);
    }
    return due;
  }
}

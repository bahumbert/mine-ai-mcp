// The give half of a trade controller's memory: what of my side the partner took, how a give went, when it may be taken again.
import { isOpen } from "./trade.ts";
import type { GiveProgress, ItemCount, Trade } from "./types.ts";

/** A hand-off dropped by a shelter or a stop is taken again after this long. */
export const RETAKE_AFTER_MS = 30_000;

export class GiveBook {
  private readonly failures = new Map<string, number>();
  private readonly droppedAt = new Map<string, number>();
  /** Trades whose last give found the recipient moving: retaken after the wait only with the partner near, whatever the failures. */
  private readonly busy = new Set<string>();
  /** Trade id -> when its give was handed to the agent: a give pending longer than the pay-back time is stuck (queued behind an order), and no longer holds the deadline back. */
  private readonly takenAt = new Map<string, number>();
  /** Trade id -> item -> count of my side given by a `give_item` outside the hand-off (memory only: a restart loses it). */
  private readonly outside = new Map<string, Map<string, number>>();

  constructor(private readonly now: () => number, private readonly payBackMs: number) {}

  /** What of my side the partner took outside the hand-off, per item; undefined when nothing was. */
  givenOf(tradeId: string): ReadonlyMap<string, number> | undefined { return this.outside.get(tradeId); }

  /** Adds items the partner took to what is credited for the trade, capped at the side. */
  credit(trade: Trade, item: string, count: number): void {
    const wanted = trade.give.find((g) => g.item === item)?.count ?? 0;
    const given = this.outside.get(trade.id) ?? new Map<string, number>();
    given.set(item, Math.min(wanted, (given.get(item) ?? 0) + Math.max(0, count)));
    this.outside.set(trade.id, given);
  }

  /** The credit of a trade whose side is given whole is no longer needed. */
  clearCredit(tradeId: string): void { this.outside.delete(tradeId); }

  /** What of my side is still to give for a trade: null when it is not open or my side was given. */
  leftOf(t: Trade): ItemCount[] | null {
    if (!isOpen(t) || t.gaveAt !== null) return null;
    const given = this.outside.get(t.id);
    return t.give.map((g) => ({ item: g.item, count: g.count - (given?.get(g.item) ?? 0) })).filter((g) => g.count > 0);
  }

  /** The give was handed to the agent. */
  taken(tradeId: string): void {
    this.takenAt.set(tradeId, this.now());
    this.droppedAt.delete(tradeId);
  }

  /** The give was dropped or found nothing taken: it waits before it is retaken. */
  dropped(tradeId: string): void { this.droppedAt.set(tradeId, this.now()); }

  /** The give found the recipient moving: no failure counted, retaken with the partner near. */
  markBusy(tradeId: string): void { this.busy.add(tradeId); }

  /** The give ended otherwise than busy. */
  clearBusy(tradeId: string): void { this.busy.delete(tradeId); }

  /** Counts a failed try and answers how many tries failed. */
  failed(tradeId: string): number {
    const failures = (this.failures.get(tradeId) ?? 0) + 1;
    this.failures.set(tradeId, failures);
    return failures;
  }

  /** A give that failed or found the recipient moving is retaken only with the partner near. */
  retakeNeedsPartner(tradeId: string): boolean { return (this.failures.get(tradeId) ?? 0) > 0 || this.busy.has(tradeId); }

  /** The give was dropped, or failed, less than the retake wait ago. */
  waitingToRetake(tradeId: string): boolean { return this.now() - (this.droppedAt.get(tradeId) ?? -Infinity) < RETAKE_AFTER_MS; }

  /** A give for the trade is pending and was taken less than the pay-back time ago: it is bounded by its own walk, toss and wait. */
  running(tradeId: string, pending: boolean): boolean { return pending && this.now() - (this.takenAt.get(tradeId) ?? this.now()) < this.payBackMs; }

  /** When the pending give was taken, if it was. */
  takenSince(tradeId: string): number | undefined { return this.takenAt.get(tradeId); }

  /** What of my side an open trade has given and why its give waits, for the line the model reads. */
  progress(tradeId: string, idle: boolean, partnerAway: boolean, nearWithin: number): GiveProgress {
    const given = [...(this.outside.get(tradeId) ?? [])].filter(([, count]) => count > 0).map(([item, count]) => ({ item, count }));
    const retake = idle && this.waitingToRetake(tradeId);
    const away = idle && this.retakeNeedsPartner(tradeId) && partnerAway;
    return { given, waits: away ? "partner_away" : retake ? "retake" : null, nearWithin };
  }

  /** The trade ended: its credit, pending clock and busy mark go (the failure count and the drop time stay, as they did). */
  forget(tradeId: string): void {
    this.outside.delete(tradeId);
    this.takenAt.delete(tradeId);
    this.busy.delete(tradeId);
  }
}

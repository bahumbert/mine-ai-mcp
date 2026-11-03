// The hand-offs a trade controller asked the agent for: which are on its stack, which are due to be taken, and when a dropped one is taken again.
import { RETAKE_AFTER_MS, type GiveBook } from "./gives.ts";
import { awaitKey, type Handoff } from "./handoff.ts";
import { owedItems } from "./trade.ts";
import type { Trade } from "./types.ts";

export class HandoffQueue {
  /** Hand-offs the agent was asked for and has not ended, by trade id. */
  readonly pending = new Map<string, "give" | "collect">();
  /** Trades whose wait for their side was taken and not dropped (a wait that ended is not taken again). */
  private readonly awaited = new Set<string>();
  /** Trades whose wait is on the agent's stack now. */
  readonly awaiting = new Set<string>();
  /** When each dropped wait for a partner's side was dropped (keyed by `awaitKey`). */
  private readonly awaitDroppedAt = new Map<string, number>();

  constructor(private readonly gives: GiveBook, private readonly now: () => number, private readonly take: (h: Handoff) => void) {}

  /** They are to pay first, or I paid first, and nothing came: wait near them, once (a dropped wait after a while). */
  awaitDue(t: Trade): boolean {
    const owedFirst = (t.state === "agreed" && t.first === "them") || (t.state === "i_gave" && t.first === "me");
    if (!owedFirst || owedItems(t).length === 0 || this.awaited.has(t.id)) return false;
    const dropped = this.awaitDroppedAt.get(awaitKey(t.id));
    return dropped === undefined || this.now() - dropped >= RETAKE_AFTER_MS;
  }

  /** The wait is no pending hand-off: a collect or a give that comes due goes on top of it. */
  takeAwait(t: Trade): void {
    this.awaited.add(t.id);
    this.awaiting.add(t.id);
    this.take({ kind: "await", tradeId: t.id, partner: t.partner });
  }

  /** A wait ended for good: it is no longer on the stack. */
  awaitOver(tradeId: string): void { this.awaiting.delete(tradeId); }

  /** A wait was dropped (a stop, a shelter): it is taken again after a while. */
  awaitDropped(tradeId: string): void {
    this.awaited.delete(tradeId);
    this.awaitDroppedAt.set(awaitKey(tradeId), this.now());
  }

  /** My side is due: they paid first, or I go first; a failed or dropped give waits for its retry condition (`partnerNear` is asked only then). */
  giveDue(t: Trade, partnerNear: () => boolean): boolean {
    const mineToGive = t.gaveAt === null && t.give.length > 0 && (t.state === "they_gave" || (t.state === "agreed" && t.first === "me"));
    if (!mineToGive || this.pending.has(t.id)) return false;
    if (this.gives.waitingToRetake(t.id)) return false;
    return !this.gives.retakeNeedsPartner(t.id) || partnerNear();
  }

  takeGive(t: Trade): void {
    this.pending.set(t.id, "give");
    this.gives.taken(t.id);
    this.take({ kind: "give", tradeId: t.id, partner: t.partner, items: t.give });
  }

  /** A hand-off was dropped (a night shelter, a stop): the trade stays due and the give is taken again after a while. */
  dropped(tradeId: string): void {
    this.pending.delete(tradeId);
    this.gives.dropped(tradeId);
  }

  /** Whether the agent holds a give for the trade now. */
  givePending(tradeId: string): boolean { return this.pending.get(tradeId) === "give"; }
}

// The ledgers the trade controller keeps for what happens outside a trade: gives and payments before the trade exists, who stood near, the collect fallback.
import type { BotSnapshot } from "../runtime-client.ts";
import type { Handoff } from "./handoff.ts";
import { CollectFallback, type CollectView } from "./collects.ts";
import { EarlierLedger, NearLedger } from "./earlier.ts";
import type { GiveBook } from "./gives.ts";
import { creditTrade } from "./trade.ts";
import type { Clocks, ItemCount, Trade } from "./types.ts";

/** What the ledgers need of the controller: the credits of gives, the book's trades, and the write of a received payment. */
export interface LedgerHost {
  readonly gives: GiveBook;
  find(tradeId: string): Trade | undefined;
  recordReceived(trade: Trade): Promise<void>;
}

export class TradeLedgers {
  /** Gives a partner took, and payments picked up while they talked, with no trade yet: kept for the next trade with them. */
  readonly earlier = new EarlierLedger();
  readonly near = new NearLedger();
  /** The collect fallback and what each agreed trade's bag held at agreement (items that arrived unseen are credited from the inventory). */
  readonly collects = new CollectFallback();
  /** Per proposal: the earlier gives it took from the ledger, which go back there when it ends unagreed. */
  private readonly fromLedger = new Map<string, ItemCount[]>();

  constructor(private readonly host: LedgerHost) {}

  /** A trade just made takes the partner's earlier gives still inside the window (`at.now`, monotonic), once (capped at its side); an agreed one also the payment picked up before the agreement, credited on `at.wallNow`. Returns the trade as it stands then. */
  async claimEarlier(trade: Trade, at: Clocks, carried: BotSnapshot["inventory"]): Promise<Trade> {
    const claimed = this.earlier.claimGives(trade, at.now);
    for (const e of claimed) this.host.gives.credit(trade, e.item, e.count);
    if (trade.state === "proposed" && claimed.length > 0) this.fromLedger.set(trade.id, claimed);
    const { trade: next, used } = creditTrade(trade, trade.state === "agreed" ? this.earlier.claimGains(trade, carried, at.now) : [], at.wallNow);
    if (used.length > 0) await this.host.recordReceived(next).catch((error: unknown) => {
      // The write failed: the payment is kept for the retry (while the book shows no credit), not lost with the claim.
      if (this.host.find(trade.id)?.received.length === trade.received.length) this.earlier.gained(used, new Map([[trade.partner.toLowerCase(), 0]]), at.now);
      throw error;
    });
    return next;
  }

  /** The earlier gives a proposal took from the ledger (they go back there when it ends unagreed). */
  carriedOver(tradeId: string): ItemCount[] | undefined { return this.fromLedger.get(tradeId); }

  /** A trade ended: the ledger gives its proposal took go back when it was cancelled unagreed (the window restarts now: the original time is not kept), then its ledger entries and collect watch are forgotten. */
  tradeEnded(trade: Trade, now: number): void {
    if (trade.state === "cancelled" && trade.agreedAt === null) for (const e of this.fromLedger.get(trade.id) ?? []) this.earlier.gave(trade.partner, e.item, e.count, now);
    this.fromLedger.delete(trade.id);
    this.collects.forget(trade.id);
  }

  /** A tick: the players who stood near are noted for the gains this tick will credit. */
  noteTick(snapshot: BotSnapshot, handoffDistance: number, now: number): void { this.near.note(snapshot, handoffDistance, now); }

  /** A partner's line (`at.wallNow` its wall time, `at.now` the monotonic reading of hearing it): inside the opening distance it opens the earlier ledger's watch, and after agreement it starts the collect fallback's short watch for their payment. */
  heard(trades: readonly Trade[], speaker: string, at: Clocks, distance: number | null, openingDistance: number): void {
    if (distance !== null && distance <= openingDistance) this.earlier.heard(speaker, at.now);
    this.collects.heard(trades, speaker, at);
  }

  /** A trade was agreed: its bag at agreement is the baseline for items that arrive unseen. */
  agreedWith(trade: Trade, carried: BotSnapshot["inventory"]): void { this.collects.arrivals.start(trade, carried); }

  /** A tick with no baseline: the bag it saw is the new baseline of every agreed trade. */
  rebase(trades: readonly Trade[], carried: BotSnapshot["inventory"]): void { this.collects.arrivals.rebase(trades, carried); }

  /** The collect fallback's turn of a tick: a watch that ran out reads the bag, and a collect that came due is handed to the agent. */
  startCollects(view: CollectView, now: number, take: (h: Handoff) => void): void { this.collects.start(view, now, take); }

  /** A wait or collect ended: it reads the bag once and what reached it unseen is credited. */
  collectEnded(tradeId: string): void { this.collects.collectEnded(tradeId); }

  /** Whether a player's window is open (the agent keeps ticking for it). */
  watching(now: number): boolean { return this.earlier.watching(now); }
}

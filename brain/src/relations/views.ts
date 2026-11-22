// What the trade controller reads out of its live state for others: the adapters crediting and the collects read, and the questions the agent asks of a trade.
import type { Position } from "../runtime-client.ts";
import type { CollectView } from "./collects.ts";
import type { TradeControllerDeps } from "./controller-deps.ts";
import type { CreditHost } from "./credits.ts";
import type { GiveBook } from "./gives.ts";
import type { HandoffQueue } from "./handoff-queue.ts";
import { heldOwed } from "./held.ts";
import type { OwedItem } from "./items.ts";
import type { TradeLedgers } from "./ledgers.ts";
import { type HeldWindow, isOpen, owedItems } from "./trade.ts";
import { type ItemCount, MINUTE_MS, type Trade, type TradeEvent } from "./types.ts";

/** What a trade event is called in the journal and in `recordStep`. */
export type TradeEventName = TradeEvent["event"];

/** The controller's live state a read goes through: each call answers what the controller holds now, never a copy taken earlier. */
export interface ViewHost {
  readonly deps: TradeControllerDeps;
  readonly gives: GiveBook;
  readonly queue: HandoffQueue;
  readonly ledgers: TradeLedgers;
  partners(): ReadonlyMap<string, Position | null>;
  position(): Position | null;
  find(tradeId: string): Trade | undefined;
  heldWindow(): HeldWindow;
  recordStep(trade: Trade, event: TradeEventName, note?: string): Promise<void>;
}

export function collectViewOf(host: ViewHost): CollectView {
  return { pending: host.queue.pending, find: (id) => host.find(id), partners: host.partners(), position: host.position() };
}

/** What crediting reads: the book as it stands now and the controller's ledgers. */
export function creditHostOf(host: ViewHost): CreditHost {
  return { trades: host.deps.book.trades(), settings: host.deps.settings, pending: host.queue.pending, partners: host.partners(), near: host.ledgers.near, earlier: host.ledgers.earlier, collects: host.ledgers.collects, log: host.deps.log,
    recordReceived: (trade) => host.recordStep(trade, "received"), giveRunning: (id) => host.gives.running(id, host.queue.givePending(id)), collectView: () => collectViewOf(host) };
}

/** What of my side is still to give for a trade: null when it is not open or my side was given. */
export function leftToGive(host: ViewHost, tradeId: string): ItemCount[] | null {
  const trade = host.find(tradeId);
  return trade === undefined ? null : host.gives.leftOf(trade);
}

/** My side not yet given of every agreed trade (`agreed`, `they_gave`): a proposal holds nothing back, `i_gave` has nothing left to give. A payment held for an ended trade is listed too, for its window. */
export function owedBy(host: ViewHost): OwedItem[] {
  const trades = host.deps.book.trades();
  return [...trades.filter((t) => t.state === "agreed" || t.state === "they_gave")
    .flatMap((t) => (host.gives.leftOf(t) ?? []).map((g) => ({ ...g, partner: t.partner, tradeId: t.id }))), ...heldOwed(trades, host.heldWindow())];
}

/**
 * How long my give for the trade may still run before the pay-back clock ends the trade: from the agreement while
 * nothing was given, from my give once I paid first, from when the give was taken once they paid (`settleTrade`); 0 for a trade that is not open.
 */
export function payBackLeftMs(host: ViewHost, tradeId: string): number {
  const trade = host.find(tradeId);
  if (trade === undefined || !isOpen(trade)) return 0;
  const since = trade.state === "they_gave" ? host.gives.takenSince(tradeId) ?? trade.receivedAt ?? trade.agreedAt ?? trade.createdAt : trade.state === "i_gave" ? trade.gaveAt ?? trade.createdAt : trade.agreedAt ?? trade.createdAt;
  return Math.max(0, host.deps.settings.payBackMinutes * MINUTE_MS - (host.deps.wallNow() - since));
}

/** Whether their payment is still to come for a trade: it is agreed and nothing came yet, or I gave first and some is still owed (the wait for their side ends otherwise). */
export function awaitsTheirSide(host: ViewHost, tradeId: string): boolean {
  const trade = host.find(tradeId);
  return trade !== undefined && (trade.state === "i_gave" || (trade.state === "agreed" && trade.received.length === 0)) && owedItems(trade).length > 0;
}

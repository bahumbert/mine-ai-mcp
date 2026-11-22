// Writing a trade down and running its clock: a trade saved in its partner's record with its events journalled, and every open trade's deadlines settled.
import type { HandoffHost } from "./handoff-lifecycle.ts";
import { withTrade } from "./record.ts";
import { scoreEndedTrade } from "./trade-score.ts";
import { giveLate, isOpen, settleTrade } from "./trade.ts";
import type { Trade, TradeState } from "./types.ts";
import type { TradeEventName } from "./views.ts";

const EVENT_OF_STATE: Record<TradeState, TradeEventName> = { proposed: "proposed", agreed: "agreed", i_gave: "gave", they_gave: "received", done: "done", broken: "broken", cancelled: "cancelled" };

/** Saves the trade in its partner's record (counting an end into the facts) and journals the events. */
export async function recordTrade(host: HandoffHost, given: Trade, ...events: TradeEventName[]): Promise<void> {
  const ended = !isOpen(given);
  // What of my side was handed over when the trade ended (the credit of gives outside the hand-off and of tosses taken) goes on the ended trade: the line of a held payment says it.
  const credited = ended && given.gaveAt === null ? [...(host.gives.givenOf(given.id) ?? [])].map(([item, count]) => ({ item, count })) : [];
  const trade = credited.length === 0 ? given : giveLate(given, credited, null).trade;
  if (trade.state !== "proposed") host.deps.board?.withdraw(trade.id);
  // An end and its score are one write: a replayed end cannot be scored twice, a crash cannot store the end without its score.
  if (ended) {
    for (const row of await scoreEndedTrade(host.deps.book, trade, host.deps.wallNow())) host.deps.journal(row);
  } else {
    await host.deps.book.update(trade.partner, (r) => withTrade(r, trade, host.heldWindow()));
  }
  for (const event of events) host.deps.journal({ kind: "trade", event, partner: trade.partner, tradeId: trade.id, give: trade.give, get: trade.get, first: trade.first, note: trade.note });
  if (!ended) return;
  host.ledgers.tradeEnded(trade, host.deps.now());
  host.nobodyGave.delete(trade.id);
  host.gives.forget(trade.id);
}

/** Runs every open trade's clock; a state the clock changed is saved, and a give that came due is handed to the agent. */
export async function settleOpenTrades(host: HandoffHost, now: number): Promise<void> {
  for (const trade of host.deps.book.trades().filter(isOpen)) {
    const settled = settleTrade(trade, now, host.deps.settings, { givePending: host.gives.running(trade.id, host.queue.givePending(trade.id)) });
    if (settled.nobodyGave) host.nobodyGave.add(trade.id);
    else host.nobodyGave.delete(trade.id);
    if (settled.trade.state !== trade.state) {
      await host.record(settled.trade, EVENT_OF_STATE[settled.trade.state]);
      if (settled.trade.state === "broken" && settled.trade.brokenBy === "me") host.tellEnd(settled.trade, "broke it");
    }
    if (isOpen(settled.trade) && host.queue.giveDue(settled.trade, () => host.partnerNear(settled.trade, host.position()))) host.queue.takeGive(settled.trade);
    if (isOpen(settled.trade) && host.queue.awaitDue(settled.trade)) host.queue.takeAwait(settled.trade);
  }
}

// Crediting what reached the bag to the trades it pays: gains seen between two ticks, and items that arrived unseen.
import type { BotSnapshot, Position } from "../runtime-client.ts";
import type { CollectFallback, CollectView } from "./collects.ts";
import { EARLIER_GIVE_MS, type EarlierLedger, type NearLedger } from "./earlier.ts";
import { sideText } from "./items.ts";
import { attributeGains, creditTrade, inventoryGains, isOpen, ownGains, settleTrade } from "./trade.ts";
import { MINUTE_MS, type Trade, type TradeSettings } from "./types.ts";

/** What the controller holds that crediting reads and writes. */
export interface CreditHost {
  readonly trades: readonly Trade[];
  readonly settings: TradeSettings;
  readonly pending: ReadonlyMap<string, "give" | "collect">;
  readonly partners: ReadonlyMap<string, Position | null>;
  readonly near: NearLedger;
  readonly earlier: EarlierLedger;
  readonly collects: CollectFallback;
  readonly log: (line: string) => void;
  recordReceived(trade: Trade): Promise<void>;
  giveRunning(tradeId: string): boolean;
  collectView(): CollectView;
}

/** What the bag gained since the last tick goes to the trades it pays (or to the earlier ledger, or to nobody). */
export async function creditGains(host: CreditHost, snapshot: BotSnapshot, previous: { readonly inventory: BotSnapshot["inventory"]; readonly partners: ReadonlyMap<string, Position | null> }, ownStepYields: ReadonlySet<string>, now: number, ownWork: boolean): Promise<void> {
  const gains = inventoryGains(previous.inventory, snapshot.inventory);
  if (gains.length === 0) return;
  const { trades, earlier, collects } = host;
  // A collect picks up the partner's items from the ground wherever they have walked off to, and its own step yields them.
  const collecting = trades.filter((t) => host.pending.get(t.id) === "collect");
  const partners = new Map(host.partners);
  for (const t of collecting) partners.set(t.partner, snapshot.position);
  const mined = ownGains(gains, ownStepYields, ownWork, trades, collecting);
  const credited = attributeGains({ gains, trades, partners, previous: previous.partners, self: snapshot.position, ownStepYields: mined, handoffDistance: host.settings.handoffDistance, recentlyNear: host.near.recently(now) });
  for (const [id, items] of credited) {
    const trade = trades.find((t) => t.id === id);
    if (trade === undefined) continue;
    const { trade: next, used } = creditTrade(trade, items, now);
    if (used.length === 0) continue;
    // A payment kept for this partner before this tick (a tick that had no baseline) must not stay kept for their next trade (review 2026-10-29 S1).
    earlier.consume(trade.partner, used, now);
    collects.arrivals.explain(used);
    collects.paid(id);
    await host.recordReceived(next);
  }
  collects.arrivals.explain(gains.filter((g) => mined.has(g.item)));
  const kept = earlier.keepUnpaidFor({ gains, credited, mined, partners, previous: previous.partners, self: snapshot.position, handoffDistance: host.settings.handoffDistance, recentlyNear: host.near.recently(now) }, now);
  // A kept payment is another player's (or this partner's later trade): no arrival for any trade open now.
  if (kept === null) return;
  collects.arrivals.explain(kept.items);
  host.log(`trade: ${sideText(kept.items)} picked up while a player talked to me (kept for ${kept.player}), with no trade agreed yet; kept for a trade agreed within ${EARLIER_GIVE_MS / MINUTE_MS} min`);
}

/** Credits what reached the bag unseen (walked over after the agreement) to the trades whose collect ended, is about to start, or which the clock ends. */
export async function creditArrived(host: CreditHost, inventory: BotSnapshot["inventory"], ownStepYields: ReadonlySet<string>, now: number): Promise<void> {
  const due = host.collects.readNow(host.collectView(), now);
  const ends = (t: Trade): boolean => !isOpen(settleTrade(t, now, host.settings, { givePending: host.giveRunning(t.id) }).trade);
  for (const { trade, next, used } of host.collects.arrivals.credits(host.trades, { inventory, ownStepYields, now, wanted: (t) => due.has(t.id) || ends(t) })) {
    host.log(`trade: ${sideText(used)} from ${trade.partner} found in the bag, walked over after the agreement`);
    host.earlier.consume(trade.partner, used, now);
    await host.recordReceived(next);
  }
}

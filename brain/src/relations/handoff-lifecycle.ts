// The hand-off lifecycle of a trade, as functions of the controller's live state: a start (at once, or at the next tick), a give counted, retried or failed, and a toss that outlived its trade.
import type { BotSnapshot, Position } from "../runtime-client.ts";
import type { TradeEndWhy } from "./board.ts";
import { EARLIER_GIVE_MS } from "./earlier.ts";
import { type Clocks, type ItemCount, MINUTE_MS, type Trade } from "./types.ts";
import type { HandoffEnd } from "./handoff.ts";
import { countLateToss, giveToHeldTrades } from "./held.ts";
import { sideText } from "./items.ts";
import type { PartnerRecord } from "./partner-record.ts";
import { cancelTrade, failTrade, isOpen, markGave } from "./trade.ts";
import { type TradeEventName, type ViewHost } from "./views.ts";

/** A give is tried this many times (the second only with the partner in talk range) before it counts as failed. */
const GIVE_ATTEMPTS = 2;

/** What the last tick saw: my inventory and where each player stood. */
export interface Seen { readonly inventory: BotSnapshot["inventory"]; readonly partners: ReadonlyMap<string, Position | null> }

/** The controller's live state a hand-off step reads and writes: each call answers what it holds now, so a step that runs after a tick sees that tick's bag. */
export interface HandoffHost extends ViewHost {
  readonly shown: PartnerRecord;
  /** Agreed trades (oldest agreement first) that had no inventory to claim against when they were agreed: started by the next tick, from its bag. */
  readonly startAtNextTick: Set<string>;
  /** Trades nobody has given on yet, for the line the model reads. */
  readonly nobodyGave: Set<string>;
  outsideGiveTarget(partner: string, item: string, due: boolean): Trade | undefined;
  previous(): Seen | null;
  carriedNow(snapshot?: BotSnapshot): BotSnapshot["inventory"];
  /** No baseline: the next tick counts no gain. */
  forgetSeen(): void;
  partnerNear(trade: Trade, at: Position | null): boolean;
  record(trade: Trade, ...events: TradeEventName[]): Promise<void>;
  /** An agreed trade I ended or broke: the partner bot of this brain is told, so its record ends the same trade. */
  tellEnd(trade: Trade, why: TradeEndWhy): void;
}

/**
 * A trade just agreed: earlier gives and payments are claimed, then my side is given at once if covered, or handed to the agent if due.
 * With no inventory to claim against (a board accept after a tick that failed) the start waits for the next tick.
 */
export async function startAgreed(host: HandoffHost, agreed: Trade, partner: string, at: Clocks, carried?: BotSnapshot["inventory"]): Promise<void> {
  if (carried === undefined && host.previous() === null) {
    host.startAtNextTick.add(agreed.id);
    return;
  }
  const current = await host.ledgers.claimEarlier(agreed, at, carried ?? host.carriedNow());
  // The bag the claim used; a deferred start runs inside a tick, which has already replaced `previous` by the new bag.
  const seen = carried ?? host.previous()?.inventory;
  if (seen !== undefined) host.ledgers.agreedWith(current, seen);
  if (await giveIfCovered(host, current, partner)) return;
  if (host.queue.giveDue(current, () => host.partnerNear(current, null))) host.queue.takeGive(current);
}

/** My side was all given before it was due: the trade is given at once (done when they gave too), with no hand-off. Proposed trades wait for the agreement. */
export async function giveIfCovered(host: HandoffHost, trade: Trade, partner: string): Promise<boolean> {
  const due = trade.state === "agreed" || trade.state === "they_gave";
  if (!due || trade.give.length === 0 || (host.gives.leftOf(trade) ?? []).length > 0) return false;
  host.gives.clearCredit(trade.id);
  const gave = markGave(trade, host.deps.wallNow());
  await host.recordStep(gave, "gave", `gave ${sideText(trade.give)} to ${partner}, outside the hand-off`);
  return true;
}

/** The board accepts that waited for a baseline are started from this tick's bag, oldest agreement first; one that fails keeps its place and drops the baseline, so the retry reads a fresh bag. */
export async function startDeferred(host: HandoffHost, previous: Seen | null, snapshot: BotSnapshot, at: Clocks): Promise<void> {
  for (const id of [...host.startAtNextTick]) {
    const trade = host.find(id);
    if (trade === undefined || (trade.state !== "agreed" && trade.state !== "they_gave")) {
      host.startAtNextTick.delete(id);
      continue;
    }
    try {
      await startAgreed(host, trade, trade.partner, at, previous?.inventory ?? snapshot.inventory);
    } catch (error) {
      host.forgetSeen();
      throw error;
    }
    host.startAtNextTick.delete(id);
  }
}

/** A `give_item` the partner took, outside the trade's hand-off, counts toward my side of the oldest open trade with them whose side has the item (a proposed one too; capped at what is lacking); the side covered and agreed, the trade is given. */
export async function gaveOutside(host: HandoffHost, partner: string, item: string, count: number): Promise<void> {
  const trade = host.outsideGiveTarget(partner, item, false);
  if (trade === undefined) {
    const left = await giveToHeldTrades(host.deps.book, partner, item, count, host.heldWindow(), host.deps.log);
    if (left <= 0) return;
    host.ledgers.earlier.gave(partner, item, left, host.deps.now());
    return void host.deps.log(`trade: ${left} ${item} given to ${partner} outside a hand-off matches no open trade of mine; not counted yet, kept for a trade proposed within ${EARLIER_GIVE_MS / MINUTE_MS} min`);
  }
  host.gives.credit(trade, item, count);
  await giveIfCovered(host, trade, partner);
}

/** A hand-off's give was partly or fully taken: what the partner took counts toward my side, so a retake gives only what is left. */
export async function tookInHandoff(host: HandoffHost, tradeId: string, taken: readonly ItemCount[]): Promise<void> {
  const trade = host.find(tradeId);
  if (trade === undefined || trade.gaveAt !== null) return;
  if (!isOpen(trade)) return void (await countLateToss(host.deps.book, trade, taken, host.heldWindow(), host.deps.log));
  for (const { item, count } of taken) host.gives.credit(trade, item, count);
}

/** A hand-off ended: a give is counted given, or failed (items gone at once; otherwise tried once more with the partner near, a not-taken one also after a wait), or waits on a busy recipient (no failure counted; retaken after a wait with the partner near). */
export async function handoffEnded(host: HandoffHost, tradeId: string, outcome: Exclude<HandoffEnd["outcome"], "dropped">, detail: string): Promise<void> {
  const kind = host.queue.pending.get(tradeId) ?? "give";
  host.queue.pending.delete(tradeId);
  if (kind === "give" && outcome !== "busy") host.gives.clearBusy(tradeId);
  const trade = host.find(tradeId);
  if (trade === undefined) return;
  // A toss that was taken after the trade ended (the partner cancelled meanwhile) is my side given, late.
  if (!isOpen(trade)) {
    if (kind !== "give") return;
    if (outcome === "done" && trade.gaveAt === null) await countLateToss(host.deps.book, trade, trade.give, host.heldWindow(), host.deps.log);
    else if (outcome !== "done") await host.shown.claim(tradeId);
    return;
  }
  // A toss the partner took after my wait ran out shows in its record: counted now, so the retry does not give it twice and no failure is counted for it.
  if (kind === "give" && outcome !== "done" && outcome !== "busy") {
    await host.shown.claim(tradeId);
    if (host.find(tradeId)?.gaveAt !== null) return;
  }
  const now = host.deps.wallNow();
  if (kind === "collect") {
    host.ledgers.collectEnded(tradeId);
    host.deps.log(`trade: collect for ${tradeId} ${outcome}: ${detail}`);
  } else if (outcome === "done") {
    const gave = markGave(trade, now);
    await host.recordStep(gave, "gave", detail);
  } else if (outcome === "items_gone") {
    await breakGive(host, trade, now, detail);
  } else if (outcome === "busy") {
    host.gives.markBusy(tradeId);
    host.gives.dropped(tradeId);
    host.deps.log(`trade: the give for ${tradeId} waits: ${detail}; it stays due`);
  } else {
    const failures = host.gives.failed(tradeId);
    const why = outcome === "not_taken" ? `${trade.partner} did not take ${sideText(host.gives.leftOf(trade) ?? trade.give)} (${GIVE_ATTEMPTS} tries); I kept them` : detail;
    if (failures >= GIVE_ATTEMPTS) await endFailedGive(host, trade, now, why);
    else host.deps.log(`trade: the give for ${tradeId} ${outcome === "not_taken" ? "was not taken" : "failed"} (${detail}); it stays due`);
    if (outcome === "not_taken") host.gives.dropped(tradeId);
  }
}

/**
 * A give not taken, or out of reach, after its attempts. A gift (nothing asked back) the recipient does not take, or walks
 * away from, is no promise of mine broken: cancelled, no fact, no score (spec 2026-11-07-gift-asked-for D3); else broken by me.
 */
async function endFailedGive(host: HandoffHost, trade: Trade, now: number, why: string): Promise<void> {
  if (trade.get.length > 0) return breakGive(host, trade, now, why);
  await host.record(cancelTrade(trade, now, why), "cancelled");
  host.tellEnd(trade, "cancelled");
}

/** My give failed for good: the trade is broken by me, and the partner bot is told. */
async function breakGive(host: HandoffHost, trade: Trade, now: number, why: string): Promise<void> {
  const broken = failTrade(trade, now, why);
  await host.record(broken, "broken");
  host.tellEnd(broken, "broke it");
}

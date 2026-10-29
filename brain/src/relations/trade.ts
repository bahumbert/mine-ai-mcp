// The trade state machine and payment attribution: pure, every clock is a wall-clock `now` passed in.
import { manhattan } from "../conversation/state.ts";
import type { TradeDecision } from "../mind.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";
import { sideText } from "./items.ts";
import { type ItemCount, MINUTE_MS, type Trade, type TradeSettings, type TradeState } from "./types.ts";

interface DealArgs {
  readonly self: string;
  readonly partner: string;
  readonly give: readonly ItemCount[];
  readonly get: readonly ItemCount[];
  readonly first: "me" | "them";
  readonly now: number;
}

function newTrade(a: DealArgs, state: "proposed" | "agreed"): Trade {
  return {
    id: `${a.self}-${a.partner}-${a.now}`, partner: a.partner, give: a.give, get: a.get, first: a.first, state,
    createdAt: a.now, agreedAt: state === "agreed" ? a.now : null, receivedAt: null, gaveAt: null, received: [], endedAt: null,
    brokenBy: null, late: false, note: "",
  };
}

/** A propose or accept that repeats a trade that ended `done` this recently is a late chat reply, not a new deal. */
const REPEAT_AFTER_DONE_MS = 2 * MINUTE_MS;

export const flipped = (first: "me" | "them"): "me" | "them" => (first === "me" ? "them" : "me");
export const sameTerms = (a: TradeDecision, b: TradeDecision): boolean => JSON.stringify([a.give, a.get, a.first]) === JSON.stringify([b.give, b.get, b.first]);

const dealKey = (items: readonly ItemCount[]): string => JSON.stringify([...items].map((i) => [i.item, i.count]).sort());
/** The same items and counts on both sides, in any order; who gives first does not matter. */
export const sameDealTerms = (a: Pick<TradeDecision, "give" | "get">, b: Pick<TradeDecision, "give" | "get">): boolean => dealKey(a.give) === dealKey(b.give) && dealKey(a.get) === dealKey(b.get);

/** The trade with the speaker that ended `done` within the repeat window on the same terms, if any: a chat reply written while it was open lands after it. */
export function repeatOfDone(trades: readonly Trade[], speaker: string, terms: TradeDecision, now: number): Trade | undefined {
  return trades.find((t) => t.state === "done" && t.partner.toLowerCase() === speaker.toLowerCase() && t.endedAt !== null && now - t.endedAt <= REPEAT_AFTER_DONE_MS && sameDealTerms(t, terms));
}

/** The newest trade the filter keeps; on equal `createdAt` the later one in the list wins. */
export function newestTrade(trades: readonly Trade[], match: (t: Trade) => boolean): Trade | null {
  let newest: Trade | null = null;
  for (const t of trades) {
    if (match(t) && (newest === null || t.createdAt >= newest.createdAt)) newest = t;
  }
  return newest;
}

export function proposeTrade(a: DealArgs): Trade {
  return newTrade(a, "proposed");
}

/** From a proposal (it keeps its id), or a new agreed trade when this side accepts an offer it heard. */
export function agreeTrade(t: Trade | null, a: DealArgs): Trade {
  if (t === null) return newTrade(a, "agreed");
  return { ...t, give: a.give, get: a.get, first: a.first, state: "agreed", agreedAt: a.now };
}

/** A trade that was agreed and has not fallen apart: agreed, being paid, or done. */
export const AGREED_STATES: ReadonlySet<Trade["state"]> = new Set(["agreed", "i_gave", "they_gave", "done"]);

const OPEN_STATES: ReadonlySet<TradeState> = new Set(["proposed", "agreed", "i_gave", "they_gave"]);

/** Open: still moving. A broken trade is ended, though a late payment can still close it (see `awaitsPayment`). */
export function isOpen(t: Trade): boolean {
  return OPEN_STATES.has(t.state);
}

/** True for trades whose credits are still accepted: open and agreed ones, and ones they left unpaid. */
function awaitsPayment(t: Trade): boolean {
  return (t.state !== "proposed" && OPEN_STATES.has(t.state)) || (t.state === "broken" && t.brokenBy === "them");
}

/** What they still owe, item by item (counts above zero only). */
export function owedItems(t: Trade): ItemCount[] {
  const out: ItemCount[] = [];
  for (const want of t.get) {
    const got = t.received.find((r) => r.item === want.item)?.count ?? 0;
    if (got < want.count) out.push({ item: want.item, count: want.count - got });
  }
  return out;
}

function mergeCounts(into: readonly ItemCount[], add: readonly ItemCount[]): ItemCount[] {
  const out = into.map((c) => ({ ...c }));
  for (const c of add) {
    const found = out.find((o) => o.item === c.item);
    if (found) found.count += c.count;
    else out.push({ ...c });
  }
  return out;
}

/** "0 of 5 iron_ingot, 2 of 3 oak_log": what came against what was agreed. */
function describePaid(t: Trade): string {
  return t.get.map((w) => `${t.received.find((r) => r.item === w.item)?.count ?? 0} of ${w.count} ${w.item}`).join(", ");
}

/** The state their payment gives (no clock): done, done late, or they_gave. */
function advance(t: Trade, now: number): Trade {
  if (!awaitsPayment(t) || owedItems(t).length > 0) return t;
  if (t.gaveAt !== null) {
    return { ...t, state: "done", brokenBy: null, late: t.state === "broken", endedAt: now, note: t.state === "broken" ? "paid in full after the deadline" : t.note };
  }
  if (t.give.length === 0) return { ...t, state: "done", endedAt: now };
  return t.get.length === 0 ? t : { ...t, state: "they_gave" };
}

export function markGave(t: Trade, now: number): Trade {
  return advance({ ...t, state: "i_gave", gaveAt: now }, now);
}

/** Credits what the partner handed over, never more than is owed; `used` is what was taken from `gains`. */
export function creditTrade(t: Trade, gains: readonly ItemCount[], now: number): { trade: Trade; used: readonly ItemCount[] } {
  if (!awaitsPayment(t)) return { trade: t, used: [] };
  const used: ItemCount[] = [];
  for (const o of owedItems(t)) {
    const have = gains.filter((g) => g.item === o.item).reduce((sum, g) => sum + g.count, 0);
    if (have > 0) used.push({ item: o.item, count: Math.min(have, o.count) });
  }
  if (used.length === 0) return { trade: t, used };
  return { trade: advance({ ...t, received: mergeCounts(t.received, used), receivedAt: now }, now), used };
}

/** My give failed: the trade is broken by me. */
export function failTrade(t: Trade, now: number, why: string): Trade {
  return { ...t, state: "broken", brokenBy: "me", endedAt: now, note: why };
}

export function cancelTrade(t: Trade, now: number, why: string): Trade {
  return { ...t, state: "cancelled", endedAt: now, note: why };
}

/**
 * Applies the clock to a trade: expiry, nobody-gave, the pay-back deadline (for their payment, and for my give once they
 * paid, unless a hand-off for it is pending: `givePending`); `giveDue` when they paid first.
 */
export function settleTrade(trade: Trade, now: number, s: TradeSettings, o: { readonly givePending?: boolean } = {}): { trade: Trade; nobodyGave: boolean; giveDue: boolean } {
  const t = advance(trade, now);
  const startMs = s.startMinutes * MINUTE_MS;
  const payBackMs = s.payBackMinutes * MINUTE_MS;
  const result = (next: Trade, nobodyGave = false) => ({ trade: next, nobodyGave, giveDue: next.state === "they_gave" });
  if (t.state === "proposed") {
    return result(now - t.createdAt >= startMs ? cancelTrade(t, now, "no answer") : t);
  }
  if (t.state === "i_gave" && t.gaveAt !== null && now - t.gaveAt >= payBackMs) {
    return result({ ...t, state: "broken", brokenBy: "them", endedAt: now, note: `they paid ${describePaid(t)}` });
  }
  if (t.state === "agreed") return result(...settleUnstarted(t, now, startMs, payBackMs));
  if (t.state === "they_gave" && t.gaveAt === null && o.givePending !== true && now - (t.receivedAt ?? t.agreedAt ?? t.createdAt) >= payBackMs) {
    return result(failTrade(t, now, `could not hand over ${sideText(t.give)} within ${s.payBackMinutes} min`));
  }
  return result(t);
}

/** An agreed trade where I have not given: nobody-gave after `startMs`, then cancelled at `payBackMs`. */
function settleUnstarted(t: Trade, now: number, startMs: number, payBackMs: number): [Trade, boolean] {
  const since = now - (t.agreedAt ?? t.createdAt);
  const nothingCame = t.received.length === 0;
  if (since >= payBackMs) {
    return [cancelTrade(t, now, nothingCame ? "nobody gave" : `they gave only ${describePaid(t)}`), false];
  }
  return [t, nothingCame && since >= startMs];
}

function totals(stacks: BotSnapshot["inventory"]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of stacks) out.set(s.name, (out.get(s.name) ?? 0) + s.count);
  return out;
}

/** What the inventory gained between two snapshots: positive differences per item name. */
export function inventoryGains(before: BotSnapshot["inventory"], after: BotSnapshot["inventory"]): ItemCount[] {
  const was = totals(before);
  const out: ItemCount[] = [];
  for (const [item, count] of totals(after)) {
    const gained = count - (was.get(item) ?? 0);
    if (gained > 0) out.push({ item, count: gained });
  }
  return out;
}

/** Where the named player stood in a tick's player list, whatever the case of the name; null when absent. */
export function partnerPosition(positions: ReadonlyMap<string, Position | null>, name: string): Position | null {
  const key = name.toLowerCase();
  for (const [who, position] of positions) if (who.toLowerCase() === key) return position;
  return null;
}

/** The partner's distance when within hand-off distance now or at the previous tick; null when out or unknown. */
function nearDistance(o: { partners: ReadonlyMap<string, Position | null>; previous: ReadonlyMap<string, Position | null>; self: Position; handoffDistance: number }, name: string): number | null {
  const distances = [partnerPosition(o.partners, name), partnerPosition(o.previous, name)]
    .filter((p): p is Position => p !== null)
    .map((p) => manhattan(o.self, p));
  if (distances.length === 0) return null;
  const best = Math.min(...distances);
  return best <= o.handoffDistance ? best : null;
}

/**
 * Splits this tick's inventory gains between trades: a gain of X goes to a trade expecting X whose partner is within
 * hand-off distance now or at the previous tick, or was lately (`recentlyNear`: lower-case names; a payment picked up
 * after the partner turned away), never while my own running step yields X; nearest partner first (a recently near
 * one ranks at hand-off distance), then the oldest trade; each trade takes at most what it is owed. Returns trade id -> credited.
 */
export function attributeGains(o: {
  readonly gains: readonly ItemCount[];
  readonly trades: readonly Trade[];
  readonly partners: ReadonlyMap<string, Position | null>;
  readonly previous: ReadonlyMap<string, Position | null>;
  readonly self: Position;
  readonly ownStepYields: ReadonlySet<string>;
  readonly handoffDistance: number;
  readonly recentlyNear: ReadonlySet<string>;
}): Map<string, ItemCount[]> {
  const credited = new Map<string, ItemCount[]>();
  const near = new Map(o.trades.filter(awaitsPayment).flatMap((t): [string, number][] => {
    const d = nearDistance(o, t.partner) ?? (o.recentlyNear.has(t.partner.toLowerCase()) ? o.handoffDistance : null);
    return d === null ? [] : [[t.id, d]];
  }));
  const ranked = o.trades.filter((t) => near.has(t.id))
    .sort((a, b) => near.get(a.id)! - near.get(b.id)! || (a.agreedAt ?? a.createdAt) - (b.agreedAt ?? b.createdAt));
  for (const gain of o.gains) {
    if (o.ownStepYields.has(gain.item)) continue;
    let left = gain.count;
    for (const t of ranked) {
      const want = owedItems(t).find((w) => w.item === gain.item)?.count ?? 0;
      const taken = Math.min(left, want - (credited.get(t.id)?.find((c) => c.item === gain.item)?.count ?? 0));
      if (taken <= 0) continue;
      credited.set(t.id, mergeCounts(credited.get(t.id) ?? [], [{ item: gain.item, count: taken }]));
      left -= taken;
    }
  }
  return credited;
}

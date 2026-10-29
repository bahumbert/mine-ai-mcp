import type { BotSnapshot, Position } from "../runtime-client.ts";
import { manhattan } from "../conversation/state.ts";
import { owedItems } from "./trade.ts";
import { type ItemCount, MINUTE_MS, type Trade } from "./types.ts";

/** How long a give or a gain waits for a trade with the player (memory only: a brain restart loses it). */
export const EARLIER_GIVE_MS = 10 * MINUTE_MS;
export const EARLIER_GAIN_MS = 10 * MINUTE_MS;

interface Entry {
  readonly player: string;
  readonly item: string;
  count: number;
  readonly at: number;
}

const lower = (name: string): string => name.toLowerCase();
const fresh = (now: number, ttl: number) => (e: Entry): boolean => now - e.at <= ttl;

/**
 * What changed hands with a player before any trade with them was agreed: my gives they took, and the items I picked up
 * while they were talking to me (a payment tossed before the deal). A trade agreed later takes both, once.
 */
export class EarlierLedger {
  private gives: Entry[] = [];
  private gains: Entry[] = [];
  /** Player (lower case) -> when they last talked to me. */
  private readonly heardAt = new Map<string, number>();

  /** A line from the player opens their window, or extends it. */
  heard(player: string, at: number): void {
    this.heardAt.set(lower(player), at);
  }

  /** Some player's window is open, or a recorded gain still waits for its trade: gains are worth watching for. */
  watching(now: number): boolean {
    for (const [player, at] of this.heardAt) {
      if (now - at <= EARLIER_GAIN_MS) return true;
      this.heardAt.delete(player);
    }
    return this.gains.some(fresh(now, EARLIER_GAIN_MS));
  }

  gave(partner: string, item: string, count: number, at: number): void {
    this.gives = this.gives.filter(fresh(at, EARLIER_GIVE_MS));
    this.gives.push({ player: lower(partner), item, count, at });
  }

  /** What the partner took of my side before a trade, still inside the window. */
  givesTo(partner: string, now: number): ItemCount[] {
    return this.gives.filter((e) => e.player === lower(partner) && fresh(now, EARLIER_GIVE_MS)(e)).map(({ item, count }) => ({ item, count }));
  }

  /** A trade just made takes the partner's earlier gives for its side, once. */
  claimGives(trade: Trade, now: number): ItemCount[] {
    this.gives = this.gives.filter(fresh(now, EARLIER_GIVE_MS));
    const claimed: ItemCount[] = [];
    for (const e of [...this.gives]) {
      if (e.player !== lower(trade.partner) || !trade.give.some((g) => g.item === e.item)) continue;
      claimed.push({ item: e.item, count: e.count });
      this.gives.splice(this.gives.indexOf(e), 1);
    }
    return claimed;
  }

  /**
   * Records the gains the one nearest player with an open window explains (two at the same distance: nobody).
   * `near`: player (lower case) -> distance, within hand-off distance. Returns what it recorded.
   */
  gained(gains: readonly ItemCount[], near: ReadonlyMap<string, number>, now: number): ItemCount[] {
    return this.gainedBy(gains, near, now)?.items ?? [];
  }

  /** `gained` that also names the player (lower case) the gains were recorded for; null when nothing was recorded. */
  private gainedBy(gains: readonly ItemCount[], near: ReadonlyMap<string, number>, now: number): { player: string; items: ItemCount[] } | null {
    if (gains.length === 0) return null;
    const open = [...near].filter(([player]) => now - (this.heardAt.get(player) ?? -Infinity) <= EARLIER_GAIN_MS).sort((a, b) => a[1] - b[1]);
    if (open.length === 0 || (open.length > 1 && open[0]![1] === open[1]![1])) return null;
    const player = open[0]![0];
    this.gains = this.gains.filter(fresh(now, EARLIER_GAIN_MS));
    for (const g of gains) this.gains.push({ player, item: g.item, count: g.count, at: now });
    return { player, items: [...gains] };
  }

  /** What the partner's recorded gains hold inside the window, summed per item; a read, nothing is consumed. */
  keptFrom(partner: string, now: number): ItemCount[] {
    const sums = new Map<string, number>();
    for (const e of this.gains.filter((x) => x.player === lower(partner) && fresh(now, EARLIER_GAIN_MS)(x))) sums.set(e.item, (sums.get(e.item) ?? 0) + e.count);
    return [...sums].map(([item, count]) => ({ item, count }));
  }

  /**
   * (Review 2026-10-29 S1.) The partner's recorded gains that a trade has now been credited for are taken out, oldest first and capped at what
   * the ledger holds: the same payment must not stay kept for a later trade (a tick without a baseline credits it as a new gain).
   */
  consume(partner: string, items: readonly ItemCount[], now: number): void {
    this.gains = this.gains.filter(fresh(now, EARLIER_GAIN_MS));
    for (const { item, count } of items) this.takeGains(partner, item, count);
    this.gains = this.gains.filter((e) => e.count > 0);
  }

  /** Takes up to `room` of the partner's recorded gains of the item, oldest first; answers how many it took. Emptied entries stay for the caller to drop. */
  private takeGains(partner: string, item: string, room: number): number {
    let left = room;
    for (const e of this.gains.filter((x) => x.player === lower(partner) && x.item === item)) {
      const take = Math.min(e.count, left);
      e.count -= take;
      left -= take;
    }
    return room - left;
  }

  /** `gained` for the part of a tick's gains no open trade took (`credited`: trade id -> items) and my own step did not yield (`mined`); names the player they were kept for. */
  keepUnpaid(o: Parameters<EarlierLedger["keepUnpaidFor"]>[0], now: number): ItemCount[] {
    return this.keepUnpaidFor(o, now)?.items ?? [];
  }

  /** `keepUnpaid` that names the player (lower case) the gains were kept for; null when nothing was kept. */
  keepUnpaidFor(o: { gains: readonly ItemCount[]; credited: ReadonlyMap<string, readonly ItemCount[]>; mined: ReadonlySet<string> } & Parameters<typeof nearPlayers>[0], now: number): { player: string; items: ItemCount[] } | null {
    const paid = new Map<string, number>();
    for (const items of o.credited.values()) for (const i of items) paid.set(i.item, (paid.get(i.item) ?? 0) + i.count);
    const rest = o.gains.filter((g) => !o.mined.has(g.item)).map((g) => ({ item: g.item, count: g.count - (paid.get(g.item) ?? 0) })).filter((g) => g.count > 0);
    return rest.length === 0 ? null : this.gainedBy(rest, nearPlayers(o), now);
  }

  /** A trade just agreed takes what its partner's recorded gains cover of what they owe, capped at what I carry now; consumed. */
  claimGains(trade: Trade, carried: BotSnapshot["inventory"], now: number): ItemCount[] {
    this.gains = this.gains.filter(fresh(now, EARLIER_GAIN_MS));
    const claimed: ItemCount[] = [];
    for (const owed of owedItems(trade)) {
      const room = Math.min(owed.count, carried.filter((c) => c.name === owed.item).reduce((n, c) => n + c.count, 0));
      const took = this.takeGains(trade.partner, owed.item, room);
      if (took > 0) claimed.push({ item: owed.item, count: took });
    }
    this.gains = this.gains.filter((e) => e.count > 0);
    return claimed;
  }
}

/** Player (lower case) -> distance for everyone within hand-off distance now or at the previous tick; the ones lately near rank at hand-off distance. */
export function nearPlayers(o: { partners: ReadonlyMap<string, Position | null>; previous: ReadonlyMap<string, Position | null>; self: Position; handoffDistance: number; recentlyNear: ReadonlySet<string> }): Map<string, number> {
  const near = new Map<string, number>();
  for (const positions of [o.partners, o.previous]) {
    for (const [name, position] of positions) {
      if (position === null) continue;
      const d = manhattan(o.self, position);
      if (d <= o.handoffDistance) near.set(lower(name), Math.min(d, near.get(lower(name)) ?? Infinity));
    }
  }
  for (const name of o.recentlyNear) if (!near.has(name)) near.set(name, o.handoffDistance);
  return near;
}

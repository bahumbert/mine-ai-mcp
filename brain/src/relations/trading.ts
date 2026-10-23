// The `trading` activity's code routine: go to a partner, ask for what the bot lacks, and judge the talk by what the
// trade controller recorded (spec 2026-10-21-trading-activity-design).
import type { Activity } from "../activities.ts";
import { pickPartner, positionOf, socialise, type SocialiseDeps } from "../conversation/socialise.ts";
import { manhattan } from "../conversation/state.ts";
import { namesWord } from "../llm-mind.ts";
import type { OpenFacts } from "../conversation/controller.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import type { SkillResult } from "../skills.ts";
import type { TradeController } from "./controller.ts";
import { minutesByPurpose, RECENT_MINUTES, type ActivityTime } from "../time-spent.ts";
import { stackSizeOf } from "./item-ids.ts";
import { AGREED_STATES } from "./trade.ts";
import type { ItemCount, Trade } from "./types.ts";

const MIN_MS = 60_000;
/** A need, and a partner's refusal, are forgotten after this long. */
const ASK_MEMORY_MS = 10 * 60_000;
/** Two trading objectives that fail before any ask within this long pause trading for as long. */
const FAST_FAILURE_WINDOW_MS = 5 * 60_000;
const FAST_FAILURES_TO_PAUSE = 2;
const PAUSE_MS = 5 * 60_000;
const MAX_NEEDS = 3;
const MAX_OFFER_STACKS = 5;
/** Longest run of words that makes one item id ("iron ingot" = 2, "white stained glass" = 3). */
const MAX_ID_WORDS = 3;
/** What socialise says when no talk took place: no refusal is recorded then. */
/** A deliberate trading opening waits this long (wall clock) for the model, a conversation slot or its own talk to end. */
export const OPENING_WAIT_MS = 45_000;
const NO_TALK = /did not come|had nothing to say/u;
const DID_NOT_COME = /did not come/u;

type Inventory = BotSnapshot["inventory"];

/** Item ids named in the text ("3 iron ingots" -> iron_ingot, longest id first), else `needs`. */
export function wantedItems(objective: string, needs: readonly string[]): string[] {
  const words = objective.toLowerCase().match(/[a-z]+(?:_[a-z]+)*/gu) ?? [];
  const found: string[] = [];
  for (let at = 0; at < words.length;) {
    let matched = 0;
    for (let n = Math.min(MAX_ID_WORDS, words.length - at); n >= 1 && matched === 0; n--) {
      const id = words.slice(at, at + n).join("_");
      const item = [id, id.replace(/s$/u, "")].find((candidate) => stackSizeOf(candidate) !== null);
      if (item !== undefined) {
        if (!found.includes(item)) found.push(item);
        matched = n;
      }
    }
    at += Math.max(1, matched);
  }
  return found.length > 0 ? found : [...needs];
}

/** Up to five of the biggest carried stacks that are not what the bot asks for. */
export function offerFrom(inventory: Inventory, want: readonly string[]): ItemCount[] {
  return inventory
    .filter((stack) => stack.count > 0 && !want.includes(stack.name))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_OFFER_STACKS)
    .map((stack) => ({ item: stack.name, count: stack.count }));
}

const carries = (inventory: Inventory, item: string): boolean => inventory.some((stack) => stack.name === item && stack.count > 0);

/** The items the bot could not get, for a few minutes. */
class Needs {
  private items: readonly string[] = [];
  private at = 0;

  set(items: readonly string[], now: number): void {
    this.items = [...items];
    this.at = now;
  }

  current(now: number, inventory: Inventory): string[] {
    if (now - this.at > ASK_MEMORY_MS) this.items = [];
    this.items = this.items.filter((item) => !carries(inventory, item));
    return this.items.slice(0, MAX_NEEDS);
  }

  /** The same items are set now (a failed objective that wants what is already needed brings nothing new). */
  sameAs(items: readonly string[]): boolean {
    return items.length === this.items.length && items.every((item) => this.items.includes(item));
  }

  drop(item: string): void {
    this.items = this.items.filter((kept) => kept !== item);
  }
}

/** Who refused which item, per bot and for a few minutes only. */
class Refusals {
  private readonly at = new Map<string, number>();
  /** When an ask to that partner for those items was last missed (the talk ended before the bot could ask). */
  private readonly missedAt = new Map<string, number>();

  private key = (partner: string, item: string): string => `${partner.toLowerCase()}\u0000${item}`;

  add(partner: string, items: readonly string[], now: number): void {
    for (const item of items) this.at.set(this.key(partner, item), now);
  }

  /** The bot never got to ask: the first miss is noted, a second within the memory time is a refusal (a partner who always ends the talk first cannot loop the bot). */
  missed(partner: string, items: readonly string[], now: number): void {
    const key = this.key(partner, [...items].sort().join(","));
    if (now - (this.missedAt.get(key) ?? -Infinity) <= ASK_MEMORY_MS) this.add(partner, items, now);
    else this.missedAt.set(key, now);
  }

  /** That partner refused any item lately. */
  refusedAnything(partner: string, now: number): boolean {
    const prefix = this.key(partner, "");
    return [...this.at].some(([key, at]) => key.startsWith(prefix) && now - at <= ASK_MEMORY_MS);
  }

  /** Every item of the ask was refused by that partner lately. */
  isRefused(partner: string, items: readonly string[], now: number): boolean {
    return items.length > 0 && items.every((item) => now - (this.at.get(this.key(partner, item)) ?? -Infinity) <= ASK_MEMORY_MS);
  }
}

/** One bot's trade asks: what it needs and who said no. In memory only, never shared between bots. */
export class TradeAsks {
  readonly needs = new Needs();
  readonly refused = new Refusals();
  /** When the trading objectives that failed before any ask failed, within the window only. */
  private fastFailures: number[] = [];
  private pausedUntil = -Infinity;

  /** An own objective failed: the items it was out to get and does not carry are what it could trade for; a different need ends the pause. */
  failed(wanted: Iterable<string>, inventory: Inventory, now: number): void {
    const missing = [...wanted].filter((item) => stackSizeOf(item) !== null && !carries(inventory, item));
    if (missing.length === 0) return;
    if (!this.needs.sameAs(missing)) this.resume();
    this.needs.set(missing, now);
  }

  /** A trading objective ended failed before any talk ("already carry", "nothing to trade for", "no one to trade with"): two within a few minutes pause trading. */
  failedFast(now: number): void {
    this.fastFailures = [...this.fastFailures.filter((at) => now - at <= FAST_FAILURE_WINDOW_MS), now];
    if (this.fastFailures.length >= FAST_FAILURES_TO_PAUSE) this.pausedUntil = now + PAUSE_MS;
  }

  /** Trading is not drawn: its objectives keep failing before any ask. */
  paused(now: number): boolean {
    return now < this.pausedUntil;
  }

  /** Ends the pause and forgets the fast failures: a new need, a trade proposed to the bot, a trading objective that reached the talk. */
  resume(): void {
    this.fastFailures = [];
    this.pausedUntil = -Infinity;
  }

  /** Removes a need that every one of the given partners refused. */
  dropRefused(partners: readonly string[], now: number): void {
    if (partners.length === 0) return;
    for (const item of this.needs.current(now, [])) {
      if (partners.every((partner) => this.refused.isRefused(partner, [item], now))) this.needs.drop(item);
    }
  }
}

/** Below this share of the window trading is forced into the draw while a need is set (spec pass line 40 %: forcing stops well before it). */
export const FORCED_SHARE = 0.25;
/** At or above this share of the window trading is not drawn at all. */
export const MAX_SHARE = 0.4;
/** Neither limit applies before the window is this long: one early trade is not 100 %. */
export const MIN_SHARE_WINDOW_MINUTES = 10;

export interface TradingShare {
  /** Trading minutes over the window, 0 to 1. */
  readonly share: number;
  readonly windowMinutes: number;
}

/**
 * The share of the agent's wall-clock time since it started (at most the last hour) that went to trading steps. Steps
 * cover only part of the run (model calls between them are no step), so the share is taken against the clock, not
 * against step time. A step that began before the window counts its part inside; records from before `startedAt` (a
 * restart) fall outside it.
 */
export function tradingShare(times: readonly ActivityTime[], now: number, startedAt: number): TradingShare {
  const windowMinutes = Math.min(RECENT_MINUTES, Math.max(0, now - startedAt) / MIN_MS);
  if (windowMinutes <= 0) return { share: 0, windowMinutes: 0 };
  const minutes = minutesByPurpose(times, now - windowMinutes * MIN_MS).find((total) => total.activity === "trading")?.minutes ?? 0;
  return { share: Math.min(1, minutes / windowMinutes), windowMinutes };
}

const limitApplies = (share: TradingShare | undefined): share is TradingShare => share !== undefined && share.windowMinutes >= MIN_SHARE_WINDOW_MINUTES;

/** The two activities drawn, with trading as the second when there is something to trade for, it can be done and it has not had its share of the time yet. */
export function withTrading(drawn: readonly Activity[], available: readonly Activity[], needs: readonly string[], share?: TradingShare): Activity[] {
  if (needs.length === 0 || !available.includes("trading") || drawn[0] === "trading" || (limitApplies(share) && share.share >= FORCED_SHARE)) return [...drawn];
  return drawn[0] === undefined ? ["trading"] : [drawn[0], "trading"];
}

/** Whether the partner is seen and at most `reach` blocks away (Manhattan), and how far (null = not seen, so out of reach). */
export function reachOf(name: string, snapshot: BotSnapshot, reach: number): { readonly inReach: boolean; readonly away: number | null } {
  const position = positionOf(snapshot, name);
  if (position === null) return { inReach: false, away: null };
  const away = manhattan(snapshot.position, position);
  return { inReach: away <= reach, away };
}

/** The partners seen and within reach, in order (the caller leaves itself out of `partners`). */
export function partnersInReach(partners: readonly string[], snapshot: BotSnapshot, reach: number): string[] {
  return partners.filter((partner) => reachOf(partner, snapshot, reach).inReach);
}

/** The partners that did not refuse any trade lately. */
export function tradingPartners(partners: readonly string[], asks: TradeAsks, now: number): string[] {
  return partners.filter((partner) => !asks.refused.refusedAnything(partner, now));
}

/**
 * The goal tier's activities without `trading` while no partner is within reach, every partner in reach refused lately
 * (it would only fail "no one to trade with"), its objectives keep failing before any ask, or trading has taken
 * {@link MAX_SHARE} of the time. `inReach` (omitted: every partner) is {@link partnersInReach} of `partners`.
 */
export function withoutRefusedTrading(available: readonly Activity[], partners: readonly string[], asks: TradeAsks, now: number, share?: TradingShare, inReach: readonly string[] = partners): Activity[] {
  const hopeless = asks.paused(now) || (partners.length > 0 && tradingPartners(inReach, asks, now).length === 0) || (limitApplies(share) && share.share >= MAX_SHARE);
  return hopeless ? available.filter((activity) => activity !== "trading") : [...available];
}

/** The goal tier's trade-needs fact: what is needed, the partners not yet refused for it, and what can be offered. */
export function tradeNeedsFacts(needs: readonly string[], partners: readonly string[], asks: TradeAsks, inventory: Inventory, now: number): { items: string[]; partners: string[]; offer: ItemCount[] } {
  return { items: [...needs], partners: partners.filter((partner) => !asks.refused.isRefused(partner, needs, now)), offer: offerFrom(inventory, needs) };
}

/**
 * What a trading objective sets out to do: the items it asks for and the partner to ask, or why it cannot. Only
 * `inReach` partners (omitted: every partner) are asked; an objective naming one who is not fails, whoever else is near.
 */
export function tradePlan(objective: string, needs: readonly string[], partners: readonly string[], asks: TradeAsks, snapshot: BotSnapshot, now: number, inReach: readonly string[] = partners): { readonly want: string[]; readonly partner: string } | { readonly failed: string } {
  // An item the objective names that it carries is what it offers, not what it asks for.
  const mentioned = wantedItems(objective, []);
  const named = mentioned.filter((item) => !carries(snapshot.inventory, item));
  // Every item it names is already in the bags: what it carries is the offer, and it asks for the needs.
  if (mentioned.length > 0 && named.length === 0 && needs.length === 0) return { failed: `already carry ${mentioned.join(", ")}` };
  const want = named.length > 0 ? named : [...needs];
  if (want.length === 0) return { failed: "nothing to trade for" };
  const tooFar = partners.find((partner) => namesWord(objective, partner) && !inReach.includes(partner));
  if (tooFar !== undefined) return { failed: `${tooFar} is too far away to trade with` };
  if (partners.length > 0 && inReach.length === 0) return { failed: `no one within reach to trade ${want.join(", ")} with` };
  const eligible = inReach.filter((partner) => !asks.refused.isRefused(partner, want, now));
  const partner = eligible.length === 0 ? null : pickPartner(objective, eligible, snapshot);
  return partner === null ? { failed: `no one to trade ${want.join(", ")} with` } : { want, partner };
}

export interface TradeRoutineDeps extends Omit<SocialiseDeps, "openFacts"> {
  readonly want: readonly string[];
  readonly asks: TradeAsks;
  readonly trades: Pick<TradeController, "latestWith">;
  readonly openFacts: Omit<OpenFacts, "snapshot" | "intent">;
}

/** A trade the partner turned down or let fall apart: a no, whether or not the ask was heard by the code. */
const DECLINED = new Set(["cancelled", "broken"]);
const sideText = (items: readonly ItemCount[]): string => items.map((i) => `${i.count} ${i.item}`).join(", ");

/** What a trading objective reports when a trade was agreed: who with and the terms. */
export const agreedDetail = (partner: string, trade: Pick<Trade, "give" | "get">): string => `agreed with ${partner}: ${sideText(trade.give)} for ${sideText(trade.get)}`;

/**
 * The `trading` routine: talks like `socialise` with the intent to trade, then reads the trade controller. A trade
 * with the partner proposed since the routine's start and agreed (or further) is done. The partner refused these
 * items for a few minutes when the ask was said (or a trade was declined). A talk that ended before the ask, even
 * after one more try, only counts as a refusal the second time within those minutes ({@link Refusals.missed}); a
 * talk that never took place counts as neither, except a partner who did not come (a miss too).
 */
export async function tradeRoutine(deps: TradeRoutineDeps): Promise<SkillResult> {
  const { runtime, signal, partner, want, asks, trades, talks, since } = deps;
  const now = (): number => (deps.clock ?? { now: () => Date.now() }).now();
  const snapshot = await runtime.status();
  const intent: OpenFacts["intent"] = { kind: "trade", want, offer: offerFrom(snapshot.inventory, want) };
  // The intent reaches a line whichever way the talk starts: in the opening, or in her reply to a talk already open.
  talks.carryIntent(partner, intent);
  try {
    const talk = (from: number) => socialise({ ...deps, since: from, openWaitMs: OPENING_WAIT_MS, openFacts: { ...deps.openFacts, intent } });
    // A partner who did not come is a miss like one who never let the bot ask; a model with nothing to say is neither.
    const noTalk = (talked: SkillResult & { status: "failed" }): SkillResult => {
      if (DID_NOT_COME.test(talked.detail)) asks.refused.missed(partner, want, now());
      return talked;
    };
    const unfinished = (talked: SkillResult): SkillResult | null =>
      talked.status === "stopped" || signal.aborted ? { status: "stopped" } : talked.status === "failed" && NO_TALK.test(talked.detail) ? noTalk(talked) : null;
    let ended = unfinished(await talk(since));
    if (ended !== null) return ended;
    asks.resume();
    let trade = trades.latestWith(partner, since);
    if (!(trade !== null && AGREED_STATES.has(trade.state)) && !talks.askedSince(partner, since)) {
      // The talk was already open (or over) and nothing asked: once more, so a fresh opening carries the ask.
      ended = unfinished(await talk(now()));
      if (ended !== null) return ended;
      trade = trades.latestWith(partner, since);
    }
    if (trade !== null && AGREED_STATES.has(trade.state)) {
      return { status: "done", detail: agreedDetail(partner, trade) };
    }
    if (talks.askedSince(partner, since) || (trade !== null && DECLINED.has(trade.state))) {
      asks.refused.add(partner, want, now());
      return { status: "failed", detail: `${partner} did not trade ${want.join(", ")}` };
    }
    asks.refused.missed(partner, want, now());
    return { status: "failed", detail: `did not get to ask ${partner}` };
  } finally {
    talks.releaseIntent();
  }
}

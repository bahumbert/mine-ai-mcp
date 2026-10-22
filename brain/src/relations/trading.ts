// The `trading` activity's code routine: go to a partner, ask for what the bot lacks, and judge the talk by what the
// trade controller recorded (spec 2026-10-21-trading-activity-design).
import type { Activity } from "../activities.ts";
import { pickPartner, socialise, type SocialiseDeps } from "../conversation/socialise.ts";
import type { OpenFacts } from "../conversation/controller.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import type { SkillResult } from "../skills.ts";
import type { TradeController } from "./controller.ts";
import { stackSizeOf } from "./item-ids.ts";
import type { ItemCount } from "./types.ts";

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

/** The two activities drawn, with trading as the second when there is something to trade for and it can be done. */
export function withTrading(drawn: readonly Activity[], available: readonly Activity[], needs: readonly string[]): Activity[] {
  if (needs.length === 0 || !available.includes("trading") || drawn[0] === "trading") return [...drawn];
  return drawn[0] === undefined ? ["trading"] : [drawn[0], "trading"];
}

/** The partners that did not refuse any trade lately. */
export function tradingPartners(partners: readonly string[], asks: TradeAsks, now: number): string[] {
  return partners.filter((partner) => !asks.refused.refusedAnything(partner, now));
}

/** The goal tier's activities without `trading` while every partner refused lately (it would only fail "no one to trade with") or its objectives keep failing before any ask. */
export function withoutRefusedTrading(available: readonly Activity[], partners: readonly string[], asks: TradeAsks, now: number): Activity[] {
  const hopeless = asks.paused(now) || (partners.length > 0 && tradingPartners(partners, asks, now).length === 0);
  return hopeless ? available.filter((activity) => activity !== "trading") : [...available];
}

/** The goal tier's trade-needs fact: what is needed, the partners not yet refused for it, and what can be offered. */
export function tradeNeedsFacts(needs: readonly string[], partners: readonly string[], asks: TradeAsks, inventory: Inventory, now: number): { items: string[]; partners: string[]; offer: ItemCount[] } {
  return { items: [...needs], partners: partners.filter((partner) => !asks.refused.isRefused(partner, needs, now)), offer: offerFrom(inventory, needs) };
}

/** What a trading objective sets out to do: the items it asks for and the partner to ask, or why it cannot. */
export function tradePlan(objective: string, needs: readonly string[], partners: readonly string[], asks: TradeAsks, snapshot: BotSnapshot, now: number): { readonly want: string[]; readonly partner: string } | { readonly failed: string } {
  // An item the objective names that it carries is what it offers, not what it asks for.
  const mentioned = wantedItems(objective, []);
  const named = mentioned.filter((item) => !carries(snapshot.inventory, item));
  // Every item it names is already in the bags: what it carries is the offer, and it asks for the needs.
  if (mentioned.length > 0 && named.length === 0 && needs.length === 0) return { failed: `already carry ${mentioned.join(", ")}` };
  const want = named.length > 0 ? named : [...needs];
  if (want.length === 0) return { failed: "nothing to trade for" };
  const eligible = partners.filter((partner) => !asks.refused.isRefused(partner, want, now));
  const partner = eligible.length === 0 ? null : pickPartner(objective, eligible, snapshot);
  return partner === null ? { failed: `no one to trade ${want.join(", ")} with` } : { want, partner };
}

export interface TradeRoutineDeps extends Omit<SocialiseDeps, "openFacts"> {
  readonly want: readonly string[];
  readonly asks: TradeAsks;
  readonly trades: Pick<TradeController, "latestWith">;
  readonly openFacts: Omit<OpenFacts, "snapshot" | "intent">;
}

const AGREED = new Set(["agreed", "i_gave", "they_gave", "done"]);
/** A trade the partner turned down or let fall apart: a no, whether or not the ask was heard by the code. */
const DECLINED = new Set(["cancelled", "broken"]);
const sideText = (items: readonly ItemCount[]): string => items.map((i) => `${i.count} ${i.item}`).join(", ");

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
    const talk = (from: number) => socialise({ ...deps, since: from, openFacts: { ...deps.openFacts, intent } });
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
    if (!(trade !== null && AGREED.has(trade.state)) && !talks.askedSince(partner, since)) {
      // The talk was already open (or over) and nothing asked: once more, so a fresh opening carries the ask.
      ended = unfinished(await talk(now()));
      if (ended !== null) return ended;
      trade = trades.latestWith(partner, since);
    }
    if (trade !== null && AGREED.has(trade.state)) {
      return { status: "done", detail: `agreed with ${partner}: ${sideText(trade.give)} for ${sideText(trade.get)}` };
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

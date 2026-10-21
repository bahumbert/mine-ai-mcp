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
const MAX_NEEDS = 3;
const MAX_OFFER_STACKS = 5;
/** Longest run of words that makes one item id ("iron ingot" = 2, "white stained glass" = 3). */
const MAX_ID_WORDS = 3;
/** What socialise says when no talk took place: no refusal is recorded then. */
const NO_TALK = /did not come|had nothing to say/u;

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

  drop(item: string): void {
    this.items = this.items.filter((kept) => kept !== item);
  }
}

/** Who refused which item, per bot and for a few minutes only. */
class Refusals {
  private readonly at = new Map<string, number>();

  private key = (partner: string, item: string): string => `${partner.toLowerCase()}\u0000${item}`;

  add(partner: string, items: readonly string[], now: number): void {
    for (const item of items) this.at.set(this.key(partner, item), now);
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

  /** An own objective failed: the items it was out to get and does not carry are what it could trade for. */
  failed(wanted: Iterable<string>, inventory: Inventory, now: number): void {
    const missing = [...wanted].filter((item) => stackSizeOf(item) !== null && !carries(inventory, item));
    if (missing.length > 0) this.needs.set(missing, now);
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

/** The goal tier's trade-needs fact: what is needed, the partners not yet refused for it, and what can be offered. */
export function tradeNeedsFacts(needs: readonly string[], partners: readonly string[], asks: TradeAsks, inventory: Inventory, now: number): { items: string[]; partners: string[]; offer: ItemCount[] } {
  return { items: [...needs], partners: partners.filter((partner) => !asks.refused.isRefused(partner, needs, now)), offer: offerFrom(inventory, needs) };
}

/** What a trading objective sets out to do: the items it asks for and the partner to ask, or why it cannot. */
export function tradePlan(objective: string, needs: readonly string[], partners: readonly string[], asks: TradeAsks, snapshot: BotSnapshot, now: number): { readonly want: string[]; readonly partner: string } | { readonly failed: string } {
  // An item the objective names that it carries is what it offers, not what it asks for.
  const named = wantedItems(objective, []).filter((item) => !carries(snapshot.inventory, item));
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
const sideText = (items: readonly ItemCount[]): string => items.map((i) => `${i.count} ${i.item}`).join(", ");

/**
 * The `trading` routine: talks like `socialise` with the intent to trade, then reads the trade controller. A trade
 * with the partner proposed since the routine's start and agreed (or further) is done; else it failed and the
 * partner is remembered as having refused these items, unless the talk never took place.
 */
export async function tradeRoutine(deps: TradeRoutineDeps): Promise<SkillResult> {
  const { runtime, signal, partner, want, asks, trades, since } = deps;
  const now = (): number => (deps.clock ?? { now: () => Date.now() }).now();
  const snapshot = await runtime.status();
  const intent: OpenFacts["intent"] = { kind: "trade", want, offer: offerFrom(snapshot.inventory, want) };
  const talked = await socialise({ ...deps, openFacts: { ...deps.openFacts, intent } });
  if (talked.status === "stopped" || signal.aborted) return { status: "stopped" };
  if (talked.status === "failed" && NO_TALK.test(talked.detail)) return talked;
  const trade = trades.latestWith(partner, since);
  if (trade !== null && AGREED.has(trade.state)) {
    return { status: "done", detail: `agreed with ${partner}: ${sideText(trade.give)} for ${sideText(trade.get)}` };
  }
  asks.refused.add(partner, want, now());
  return { status: "failed", detail: `${partner} did not trade ${want.join(", ")}` };
}

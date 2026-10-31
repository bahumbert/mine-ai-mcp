// The checks a trade decision passes before it becomes a trade: ids, what I carry, limits, room for what I get.
import type { TradeDecision } from "../mind.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import type { BoardOffer } from "./board.ts";
import { DEFAULT_STACK, stackSizeOf } from "./item-ids.ts";
import { carriedOf } from "./items.ts";
import { isOpen } from "./trade.ts";
import { reachOf } from "./trading.ts";
import type { ItemCount, Trade } from "./types.ts";

const MAX_SIDE_ENTRIES = 4;
const INVENTORY_SLOTS = 36;

export interface CheckInput {
  readonly decision: TradeDecision;
  readonly speaker: string;
  readonly snapshot: BotSnapshot;
  readonly trades: readonly Trade[];
  readonly maxOpenTrades: number;
  /** The speaker counts only when seen and at most this many blocks away (`relations.tradeReach`). */
  readonly reach: number;
  /** Items of my side the partner already took (a give outside a hand-off), per item: they count as carried. */
  readonly givenOutside?: ReadonlyMap<string, number>;
}

/** What other trades I already promised and have not handed over, per item. */
function promisedOf(trades: readonly Trade[], item: string, except: string | undefined): number {
  return trades.filter((t) => t.id !== except && (t.state === "agreed" || t.state === "they_gave") && t.gaveAt === null)
    .flatMap((t) => t.give).filter((g) => g.item === item).reduce((sum, g) => sum + g.count, 0);
}

function whatIsWrongWithMySide(i: CheckInput, answered: Trade | undefined): string | null {
  for (const { item, count } of i.decision.give) {
    const carried = carriedOf(i.snapshot.inventory, item) + (i.givenOutside?.get(item) ?? 0);
    const promised = promisedOf(i.trades, item, answered?.id);
    if (carried - promised < count) {
      const free = carried - promised;
      // An accept cannot change the offer's terms, so the model is told what it may propose instead (a counter-offer).
      const hint = i.decision.action === "accept" && free > 0 ? `: you may propose ${free} instead` : "";
      return `you carry ${carried} ${item}${promised > 0 ? `, ${promised} of them promised in other trades` : ""}, not ${count}${hint}`;
    }
  }
  return null;
}

/** Slots the inventory needs for what I get, against the free ones (plus those the give empties). */
function whatIsWrongWithRoom(i: CheckInput): string | null {
  const { inventory } = i.snapshot;
  let freed = 0;
  for (const { item, count } of i.decision.give) {
    if (count >= carriedOf(inventory, item)) freed += inventory.filter((s) => s.name === item).length;
  }
  let needed = 0;
  for (const { item, count } of i.decision.get) {
    const stack = stackSizeOf(item) ?? DEFAULT_STACK;
    const space = inventory.filter((s) => s.name === item).reduce((sum, s) => sum + Math.max(0, stack - s.count), 0);
    needed += Math.ceil(Math.max(0, count - space) / stack);
  }
  const free = INVENTORY_SLOTS - inventory.length + freed;
  return needed > free ? `there is no room in your inventory for what you get: it needs ${needed} free slots and you have ${free}` : null;
}

const unknownItem = (side: readonly ItemCount[]): string | undefined => side.find((e) => stackSizeOf(e.item) === null)?.item;

/** Null when a propose or accept can become a trade, else the reason, written for the model that sent it. */
export function checkTradeDecision(i: CheckInput): string | null {
  const { decision: d } = i;
  if (d.action === "decline" || d.action === "cancel") return null;
  const { inReach, away } = reachOf(i.speaker, i.snapshot, i.reach);
  if (!inReach) return `${i.speaker} is too far away to trade with (${away === null ? "out of sight" : `${away} blocks away`}): no trade from here; say they can come to you`;
  if (d.give.length > MAX_SIDE_ENTRIES || d.get.length > MAX_SIDE_ENTRIES) return `a side has at most ${MAX_SIDE_ENTRIES} entries`;
  const badId = unknownItem(d.give) ?? unknownItem(d.get);
  if (badId !== undefined) return `"${badId}" is not a Minecraft item id`;
  const open = i.trades.filter(isOpen);
  const mine = open.find((t) => t.partner.toLowerCase() === i.speaker.toLowerCase());
  // My own proposal to them is answered by an accept, and replaced by a propose; any later state blocks both.
  const answered = mine?.state === "proposed" ? mine : undefined;
  if (mine !== undefined && answered === undefined) return `you already have a trade open with ${i.speaker} (${mine.state}): finish or cancel it first`;
  if (open.length - (answered === undefined ? 0 : 1) >= i.maxOpenTrades) return `you already have ${open.length} trades open, the most at once`;
  return whatIsWrongWithMySide(i, answered) ?? whatIsWrongWithRoom(i);
}

export interface ProposalState {
  readonly speaker: string;
  /** My open trade with them. */
  readonly mine: Trade | undefined;
  /** The id of my offer to them on the board; read for a bot partner only (a player has no board). */
  readonly ownOfferId: string | undefined;
  readonly local: boolean;
  readonly theirOffer: BoardOffer | undefined;
  /** When the line I answer was heard; absent when the caller does not know. */
  readonly heardAt: number | undefined;
  /** The id of their offer the model read, if any: an offer it read is answered, however late its post was stamped. */
  readonly seenOfferId: string | undefined;
}

/**
 * Null when a propose goes on (replacing my open proposal to them; a counter-offer when their offer stood when the line
 * was heard), else the log line saying why it is dropped: a trade past `proposed`, a proposal they already answered
 * (their accept leaves the board before my record follows), or their offer posted later (the two crossed: the older stands).
 */
export function whyProposalDropped(s: ProposalState): string | null {
  if (s.mine !== undefined && s.mine.state !== "proposed") return `trade: a proposal to ${s.speaker} ignored, ${s.mine.id} is still open`;
  if (s.mine !== undefined && s.local && s.ownOfferId !== s.mine.id) return `trade: a proposal to ${s.speaker} ignored, they already answered ${s.mine.id}`;
  const counter = s.theirOffer !== undefined && s.heardAt !== undefined && (s.theirOffer.postedAt <= s.heardAt || s.theirOffer.id === s.seenOfferId);
  return s.theirOffer !== undefined && !counter ? `trade: my proposal to ${s.speaker} dropped, their older proposal to me stands` : null;
}

/** What a replaced proposal's partner took outside the hand-off, less the earlier-ledger gives that return to the ledger when it ends: the replacing proposal starts with it. */
export function givesCarriedOver(taken: ReadonlyMap<string, number> | undefined, backToLedger: readonly ItemCount[] | undefined): [string, number][] {
  const back = new Map((backToLedger ?? []).map((e) => [e.item, e.count]));
  return [...taken ?? []].map(([item, count]): [string, number] => [item, count - (back.get(item) ?? 0)]).filter(([, count]) => count > 0);
}

/** What the model read when it decided on a line: when that line was heard, and the id of the speaker's offer on the board then. */
export interface DecisionSeen { readonly heardAt: number; readonly seenOfferId?: string }

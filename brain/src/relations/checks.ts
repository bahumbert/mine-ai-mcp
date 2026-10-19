// The checks a trade decision passes before it becomes a trade: ids, what I carry, limits, room for what I get.
import type { TradeDecision } from "../mind.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import { stackSizeOf } from "./item-ids.ts";
import { isOpen } from "./trade.ts";
import type { ItemCount, Trade } from "./types.ts";

const MAX_SIDE_ENTRIES = 4;
const INVENTORY_SLOTS = 36;
const DEFAULT_STACK = 64;

export interface CheckInput {
  readonly decision: TradeDecision;
  readonly speaker: string;
  readonly snapshot: BotSnapshot;
  readonly trades: readonly Trade[];
  readonly maxOpenTrades: number;
}

const carriedOf = (inventory: BotSnapshot["inventory"], item: string): number => inventory.filter((s) => s.name === item).reduce((sum, s) => sum + s.count, 0);

/** What other trades I already promised and have not handed over, per item. */
function promisedOf(trades: readonly Trade[], item: string, except: string | undefined): number {
  return trades.filter((t) => t.id !== except && (t.state === "agreed" || t.state === "they_gave") && t.gaveAt === null)
    .flatMap((t) => t.give).filter((g) => g.item === item).reduce((sum, g) => sum + g.count, 0);
}

function whatIsWrongWithMySide(i: CheckInput, answered: Trade | undefined): string | null {
  for (const { item, count } of i.decision.give) {
    const carried = carriedOf(i.snapshot.inventory, item);
    const promised = promisedOf(i.trades, item, answered?.id);
    if (carried - promised < count) {
      return `you carry ${carried} ${item}${promised > 0 ? `, ${promised} of them promised in other trades` : ""}, not ${count}`;
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
  if (d.give.length > MAX_SIDE_ENTRIES || d.get.length > MAX_SIDE_ENTRIES) return `a side has at most ${MAX_SIDE_ENTRIES} entries`;
  const badId = unknownItem(d.give) ?? unknownItem(d.get);
  if (badId !== undefined) return `"${badId}" is not a Minecraft item id`;
  const open = i.trades.filter(isOpen);
  const mine = open.find((t) => t.partner.toLowerCase() === i.speaker.toLowerCase());
  const answered = mine?.state === "proposed" && d.action === "accept" ? mine : undefined;
  if (mine !== undefined && answered === undefined) return `you already have a trade open with ${i.speaker} (${mine.state}): finish or cancel it first`;
  if (open.length - (answered === undefined ? 0 : 1) >= i.maxOpenTrades) return `you already have ${open.length} trades open, the most at once`;
  return whatIsWrongWithMySide(i, answered) ?? whatIsWrongWithRoom(i);
}

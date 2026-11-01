// The chat call with a trade: the relations block goes in, a trade the checks refuse is sent back once, then dropped.
import { targetItems, type Step } from "../actions.ts";
import type { ChatDecision, ChatInput, Mind } from "../mind.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import type { TradeController } from "./controller.ts";
import { carriedOf } from "./items.ts";

/** What the current objective lacks: its wanted items none of which is carried (names only, the model weighs how much). */
export function describeLacks(wanted: Iterable<string>, inventory: BotSnapshot["inventory"]): string[] {
  return [...wanted].filter((item) => carriedOf(inventory, item) === 0);
}

export interface RefusedTrade {
  readonly mind: Pick<Mind, "chat">;
  /** The chat input the first reply answered, with the relations block it was given. */
  readonly input: ChatInput;
  /** The first reply, whose trade is not accepted until the checks pass. */
  readonly first: ChatDecision;
  readonly trades: TradeController;
  readonly speaker: string;
  /** What the chat call started from: the checks fall back to it when a fresh read fails. */
  readonly snapshot: BotSnapshot;
  /** The world as it is now: a model call takes seconds, so each check reads it again. */
  readonly fresh: () => Promise<BotSnapshot>;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
}

/** A checked reply and the snapshot its last check read. */
export interface CheckedTrade {
  readonly decision: ChatDecision;
  readonly snapshot: BotSnapshot;
}

/** The world a check reads: a fresh snapshot, else the earlier one (one line logged), unless the run is aborted. */
async function worldNow(o: RefusedTrade, earlier: BotSnapshot): Promise<BotSnapshot> {
  try {
    return await o.fresh();
  } catch (error) {
    if (o.signal.aborted) throw error;
    o.log(`  trade check on the chat snapshot: ${String(error)}`);
    return earlier;
  }
}

/**
 * A reply with a trade: the checks (ids, what is carried, limits, room) run on the world as it is after the model call; a
 * trade they refuse goes back once with the reason, as the conversations' opening rule does; refused again, the line
 * stands and the trade is dropped.
 */
export async function resendRefusedTrade(o: RefusedTrade): Promise<CheckedTrade> {
  if (o.first.trade === undefined) return { decision: o.first, snapshot: o.snapshot };
  const world = await worldNow(o, o.snapshot);
  const reason = o.trades.checkDecision(o.first.trade, o.speaker, world);
  if (reason === null) return { decision: o.first, snapshot: world };
  o.log(`  trade refused: ${reason}; sent back once`);
  const block = `${o.input.relations?.block ?? ""}

The trade in your last reply was refused: ${reason}. Answer again; leave "trade" out or change it so it can be made.`;
  const second = await o.mind.chat({ ...o.input, relations: { ...o.input.relations, block, tradeOn: true } }, o.signal);
  if (second.trade === undefined) return { decision: { ...second, tradeDropped: true }, snapshot: world };
  // The re-answer that leaves the trade out still came after a refused one: its order is no plain line.
  const later = await worldNow(o, world);
  const again = o.trades.checkDecision(second.trade, o.speaker, later);
  if (again === null) return { decision: second, snapshot: later };
  o.log(`  trade refused again: ${again}; dropped`);
  const { trade: _dropped, ...kept } = second;
  return { decision: { ...kept, tradeDropped: true }, snapshot: later };
}

/** The items a running step is out to get (or the block it mines): its gains are its own work, never a partner's payment. */
export function itemsYieldedBy(step: Step): ReadonlySet<string> {
  return new Set([...targetItems(step).map((target) => target.item), ...(step.skill === "collect_block" ? [step.block] : [])]);
}

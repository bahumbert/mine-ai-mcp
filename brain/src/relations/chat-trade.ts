// The chat call with a trade: the relations block goes in, a trade the checks refuse is sent back once, then dropped.
import { targetItems, type Step } from "../actions.ts";
import type { ChatDecision, ChatInput, Mind } from "../mind.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import type { TradeController } from "./controller.ts";

/** What the current objective lacks: its wanted items none of which is carried (names only, the model weighs how much). */
export function describeLacks(wanted: Iterable<string>, inventory: BotSnapshot["inventory"]): string[] {
  return [...wanted].filter((item) => !inventory.some((stack) => stack.name === item));
}

export interface RefusedTrade {
  readonly mind: Mind;
  /** The chat input the first reply answered, with the relations block it was given. */
  readonly input: ChatInput;
  /** The first reply, whose trade is not accepted until the checks pass. */
  readonly first: ChatDecision;
  readonly trades: TradeController;
  readonly speaker: string;
  readonly snapshot: BotSnapshot;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
}

/**
 * A reply with a trade: the checks (ids, what is carried, limits, room) run; a trade they refuse goes back once with the
 * reason, as the conversations' opening rule does; refused again, the line stands and the trade is dropped.
 */
export async function resendRefusedTrade(o: RefusedTrade): Promise<ChatDecision> {
  const reason = o.first.trade === undefined ? null : o.trades.checkDecision(o.first.trade, o.speaker, o.snapshot);
  if (reason === null) return o.first;
  o.log(`  trade refused: ${reason}; sent back once`);
  const block = `${o.input.relations?.block ?? ""}

The trade in your last reply was refused: ${reason}. Answer again; leave "trade" out or change it so it can be made.`;
  const second = await o.mind.chat({ ...o.input, relations: { block, tradeOn: true } }, o.signal);
  const again = second.trade === undefined ? null : o.trades.checkDecision(second.trade, o.speaker, o.snapshot);
  if (again === null) return second;
  o.log(`  trade refused again: ${again}; dropped`);
  const { trade: _dropped, ...kept } = second;
  return kept;
}

/** The items a running step is out to get (or the block it mines): its gains are its own work, never a partner's payment. */
export function itemsYieldedBy(step: Step): ReadonlySet<string> {
  return new Set([...targetItems(step).map((target) => target.item), ...(step.skill === "collect_block" ? [step.block] : [])]);
}

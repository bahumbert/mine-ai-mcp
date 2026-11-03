// What an ended trade does to the partner's score: the event it makes, and the record change that stores the end and scores it as one.
import type { RelationBook } from "./book.ts";
import { sideText } from "./items.ts";
import { heldWindow, withEndedTrade } from "./record.ts";
import { newScoredRows, withScoreEvent } from "./score.ts";
import type { Relation, RelationEvent, ScoreInput, Scoring, Trade } from "./types.ts";

/** "2 of 3 bread": what of their side has not come in. */
function owedText(t: Trade): string {
  return t.get.map((w) => ({ item: w.item, count: w.count, left: w.count - (t.received.find((r) => r.item === w.item)?.count ?? 0) }))
    .filter((w) => w.left > 0).map((w) => `${w.left} of ${w.count} ${w.item}`).join(", ");
}

function doneScore(before: Trade | undefined, trade: Trade): ScoreInput | null {
  if (trade.get.length === 0) return null;
  if (trade.give.length === 0) return { kind: "gift_received", why: `gave you ${sideText(trade.get)}` };
  const paid = `paid ${sideText(trade.get)} for your ${sideText(trade.give)}`;
  if (trade.late && before?.state === "broken" && before.brokenBy === "them") return { kind: "kept_late", why: `${paid}, late`, tradeId: trade.id };
  return { kind: "trade_done", why: paid };
}

/** The event an end state makes, given the entry the record already held for the trade; null when it makes none or was seen before (same state, same side to blame). */
export function tradeEndScore(before: Trade | undefined, trade: Trade): ScoreInput | null {
  if (before !== undefined && before.state === trade.state && before.brokenBy === trade.brokenBy) return null;
  if (trade.state === "done") return doneScore(before, trade);
  if (trade.state === "broken" && trade.brokenBy === "them") return { kind: "promise_broken", why: `did not pay ${owedText(trade)}`, tradeId: trade.id };
  return null;
}

/** Stores the ended trade (counting its facts) and scores it, from the entry the record held: one pure change for one `book.update`. */
export function withTradeEnd(r: Relation, trade: Trade, now: number, s: Scoring): Relation {
  const input = tradeEndScore(r.trades.find((t) => t.id === trade.id), trade);
  const ended = withEndedTrade(r, trade, heldWindow(now, s));
  return input === null ? ended : withScoreEvent(ended, input, now, s);
}

/** Saves the ended trade and its score in one write; the journal rows of the score events that write added (none when the trade scored nothing or its end was seen before). */
export async function scoreEndedTrade(book: RelationBook, trade: Trade, now: number): Promise<RelationEvent[]> {
  let rows: RelationEvent[] = [];
  await book.update(trade.partner, (r) => {
    const next = withTradeEnd(r, trade, now, book.scoring);
    rows = newScoredRows(r, next);
    return next;
  });
  return rows;
}

import assert from "node:assert/strict";
import test from "node:test";
import { testScoring } from "../testing.ts";
import { newRelation, withTrade } from "./record.ts";
import { RelationBook } from "./book.ts";
import { scoreEndedTrade, tradeEndScore, withTradeEnd } from "./trade-score.ts";
import { agreeTrade, creditTrade, failTrade, markGave, settleTrade } from "./trade.ts";
import type { ItemCount, Trade, TradeSettings } from "./types.ts";

const settings: TradeSettings = { payBackMinutes: 10, startMinutes: 3, handoffDistance: 4, offersForgetMinutes: 60, maxOpenTrades: 3, tradeReach: 32 };
const MIN = 60_000;
const t0 = 1_000_000;
const logs: ItemCount[] = [{ item: "oak_log", count: 5 }];
const iron: ItemCount[] = [{ item: "iron_ingot", count: 3 }];
const bread: ItemCount[] = [{ item: "bread", count: 3 }];
const scoring = testScoring();
const deal = (over: Partial<{ give: ItemCount[]; get: ItemCount[]; first: "me" | "them" }> = {}) =>
  agreeTrade(null, { self: "Ayla", partner: "Theo", give: logs, get: iron, first: "me", now: t0, ...over });
const brokenByThem = (get = iron): Trade => settleTrade(markGave(deal({ get }), t0), t0 + 10 * MIN, settings).trade;

test("done is trade_done", () => {
  const done = creditTrade(markGave(deal(), t0), iron, t0 + MIN).trade;
  assert.deepEqual(tradeEndScore(undefined, done), { kind: "trade_done", why: "paid 3 iron_ingot for your 5 oak_log" });
});

test("gift to me is gift_received; my gift scores nothing", () => {
  const gift = creditTrade(deal({ give: [], first: "them" }), iron, t0).trade;
  assert.deepEqual(tradeEndScore(undefined, gift), { kind: "gift_received", why: "gave you 3 iron_ingot" });
  assert.equal(tradeEndScore(undefined, markGave(deal({ get: [] }), t0)), null);
});

test("broken by them is promise_broken, naming what is missing", () => {
  const broken = brokenByThem(bread);
  assert.equal(broken.brokenBy, "them");
  assert.deepEqual(tradeEndScore(undefined, broken), { kind: "promise_broken", why: "did not pay 3 of 3 bread", tradeId: broken.id });
  const part = settleTrade(creditTrade(markGave(deal({ get: bread }), t0), [{ item: "bread", count: 1 }], t0 + MIN).trade, t0 + 12 * MIN, settings).trade;
  assert.equal(tradeEndScore(undefined, part)?.why, "did not pay 2 of 3 bread");
});

test("broken by me and cancelled score nothing", () => {
  assert.equal(tradeEndScore(undefined, failTrade(deal(), t0 + MIN, "items gone")), null);
  assert.equal(tradeEndScore(undefined, settleTrade(deal({ first: "them" }), t0 + 10 * MIN, settings).trade), null);
});

test("late payment is kept_late with the trade id", () => {
  const broken = brokenByThem();
  const late = creditTrade(broken, iron, t0 + 20 * MIN).trade;
  assert.equal(late.late, true);
  assert.deepEqual(tradeEndScore(broken, late), { kind: "kept_late", why: "paid 3 iron_ingot for your 5 oak_log, late", tradeId: late.id });
});

test("withTradeEnd stores the end, counts the facts and scores in one change", () => {
  const fresh = newRelation("Theo", t0, 0);
  const done = creditTrade(markGave(deal(), t0), iron, t0 + MIN).trade;
  const r = withTradeEnd(withTrade(fresh, deal()), done, t0 + MIN, scoring);
  assert.deepEqual([r.facts.tradesDone, r.score, r.ledger.map((e) => e.kind)], [1, 8, ["trade_done"]]);
  assert.deepEqual(withTradeEnd(r, done, t0 + MIN, scoring), r, "a replay changes nothing");
});

test("replayed end scores once even when two writes are started together", async () => {
  const saved: unknown[] = [];
  const book = new RelationBook({ save: async (m) => { saved.push(m); }, remove: async () => {}, now: () => t0, log: () => {}, scoring });
  const broken = brokenByThem();
  const rows = await Promise.all([scoreEndedTrade(book, broken, t0 + 10 * MIN), scoreEndedTrade(book, broken, t0 + 10 * MIN)]);
  assert.deepEqual(rows.map((written) => written.map((row) => row.kind === "relation" && row.event === "scored" ? row.scoreKind : null)), [["promise_broken"], []]);
  assert.deepEqual(book.get("Theo")?.ledger.map((e) => e.kind), ["promise_broken"]);
  assert.equal(book.get("Theo")?.facts.promisesBroken, 1);
});

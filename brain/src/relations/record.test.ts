import assert from "node:assert/strict";
import test from "node:test";
import { testScoring } from "../testing.ts";
import { withScoreEvent } from "./score.ts";
import { describeRelation, forgetOldSaid, newRelation, parseRelationNote, relationNote, withEndedTrade, withSaid, withTrade } from "./record.ts";
import { agreeTrade, creditTrade, failTrade, markGave, settleTrade } from "./trade.ts";
import type { GiveProgress, ItemCount, Relation, Trade, TradeSettings } from "./types.ts";

const settings: TradeSettings = { payBackMinutes: 10, startMinutes: 3, handoffDistance: 4, offersForgetMinutes: 60, maxOpenTrades: 3, tradeReach: 32 };
const MIN = 60_000;
const t0 = 1_000_000;
const bread: ItemCount[] = [{ item: "bread", count: 5 }];
const ingots: ItemCount[] = [{ item: "iron_ingot", count: 5 }];
const deal = (first: "me" | "them", over: Partial<{ give: ItemCount[]; get: ItemCount[]; now: number }> = {}) =>
  agreeTrade(null, { self: "Ayla", partner: "Theo", give: bread, get: ingots, first, now: t0, ...over });
const scoring = testScoring();
const fresh = () => newRelation("Theo", t0, 0);

test("a new relation is empty", () => {
  const r = fresh();
  assert.deepEqual([r.score, r.scoredAt, r.ledger.length, r.requests.length, r.lastHurt, r.trades.length, r.facts.tradesDone, r.lastDealt], [0, t0, 0, 0, null, 0, 0, t0]);
  assert.equal(newRelation("Theo", t0, 15).score, 15, "a new relation starts at the first impression");
});

test("done after I went first counts a trade done and a promise kept", () => {
  const done = creditTrade(markGave(deal("me"), t0), ingots, t0 + MIN).trade;
  const r = withEndedTrade(fresh(), done);
  assert.equal(r.facts.tradesDone, 1);
  assert.equal(r.facts.promisesKept, 1);
  assert.equal(r.trades.length, 1);
  assert.equal(withEndedTrade(r, done).facts.tradesDone, 1, "the same ended trade is counted once");
});

test("done after they went first counts no promise kept", () => {
  const theyGave = creditTrade(deal("them"), ingots, t0 + MIN).trade;
  const r = withEndedTrade(fresh(), markGave(theyGave, t0 + 2 * MIN));
  assert.deepEqual([r.facts.tradesDone, r.facts.promisesKept], [1, 0]);
});

test("broken by them counts a broken promise, paid late takes it back", () => {
  const broken = settleTrade(markGave(deal("me"), t0), t0 + 10 * MIN, settings).trade;
  const r = withEndedTrade(fresh(), broken);
  assert.equal(r.facts.promisesBroken, 1);
  const late = creditTrade(broken, ingots, t0 + 20 * MIN).trade;
  const after = withEndedTrade(r, late);
  assert.deepEqual([after.facts.promisesBroken, after.facts.keptLate, after.facts.tradesDone, after.facts.promisesKept], [0, 1, 1, 0]);
});

test("broken by me counts a failure to pay", () => {
  const r = withEndedTrade(fresh(), failTrade(deal("me"), t0 + MIN, "items gone"));
  assert.deepEqual([r.facts.iFailedToPay, r.facts.promisesBroken], [1, 0]);
});

test("gifts are counted by direction", () => {
  const given = withEndedTrade(fresh(), markGave(deal("me", { get: [] }), t0));
  assert.deepEqual([given.facts.giftsGiven, given.facts.giftsReceived, given.facts.tradesDone], [1, 0, 0]);
  const received = withEndedTrade(fresh(), creditTrade(deal("them", { give: [] }), ingots, t0).trade);
  assert.deepEqual([received.facts.giftsReceived, received.facts.giftsGiven], [1, 0]);
});

test("a cancelled trade counts no fact", () => {
  const cancelled = settleTrade(deal("them"), t0 + 10 * MIN, settings).trade;
  const r = withEndedTrade(fresh(), cancelled);
  assert.deepEqual(r.facts, fresh().facts);
});

test("only open trades and the last 3 ended ones are kept", () => {
  let r = withTrade(fresh(), deal("me", { now: t0 }));
  for (let i = 1; i <= 4; i += 1) r = withEndedTrade(r, markGave(deal("me", { get: [], now: t0 + i * 1_000 }), t0 + i * 1_000));
  assert.equal(r.trades.length, 4);
  assert.equal(r.trades.filter((t) => t.state === "agreed").length, 1);
  assert.equal(r.trades.filter((t) => t.state === "done").length, 3);
  assert.equal(r.facts.giftsGiven, 4, "facts survive the trimmed history");
  const replaced = withTrade(r, { ...r.trades.find((t) => t.state === "agreed")!, state: "i_gave" });
  assert.equal(replaced.trades.length, 4);
});

test("withSaid merges by item, newest wins, and old entries are forgotten", () => {
  let r = withSaid(fresh(), [{ item: "iron_ingot", count: 20 }, "white_wool"], ["bread"], t0);
  r = withSaid(r, [{ item: "iron_ingot", count: 4 }], [], t0 + 5 * MIN);
  assert.deepEqual(r.saidHas.map((s) => [s.item, s.count, s.at]), [["white_wool", null, t0], ["iron_ingot", 4, t0 + 5 * MIN]]);
  assert.deepEqual(r.saidNeeds.map((s) => s.item), ["bread"]);
  const later = forgetOldSaid(r, t0 + 61 * MIN, 60);
  assert.deepEqual(later.saidHas.map((s) => s.item), ["iron_ingot"]);
  assert.deepEqual(later.saidNeeds, []);
});

test("describeRelation for a stranger", () => {
  assert.equal(describeRelation(null, "Theo", t0, scoring), "You have not dealt with Theo before; your first impression is that you have no strong feeling about Theo.");
});

test("describeRelation for a full record", () => {
  let r = fresh();
  r = { ...r, facts: { ...r.facts, tradesDone: 4, keptLate: 1 } };
  r = withTrade(r, markGave(deal("me", { now: t0 }), t0 + MIN));
  r = withSaid(r, ["iron_ingot"], ["white_wool"], t0);
  const text = describeRelation(r, "Theo", t0 + 20 * MIN, scoring);
  assert.match(text, /You and Theo: 0, you have no strong feeling about Theo\./u);
  assert.match(text, /4 trades done, 1 kept late, 0 broken/u);
  assert.match(text, /you gave 5 bread 19 min ago, Theo owes 5 iron_ingot/u);
  assert.match(text, /Theo said 20 min ago they have iron_ingot/u);
  assert.match(text, /they need white_wool/u);
});

test("S1/S4: the Open line is true for nothing given, part given, a failed give with the partner away and a dropped give", () => {
  const agreedFirstMe = deal("me");
  const theyGave = creditTrade(deal("them"), ingots, t0 + MIN).trade;
  const given3 = [{ item: "bread", count: 3 }];
  const progress = (over: Partial<GiveProgress>) => () => ({ given: [], waits: null, nearWithin: 6, ...over });
  const rows: { name: string; trade: Trade; progress?: () => GiveProgress; line: string }[] = [
    { name: "nothing given", trade: agreedFirstMe, progress: progress({}), line: "agreed 2 min ago: you give 5 bread, Theo gives 5 iron_ingot, you first; nothing handed over yet: you have not given your 5 bread and have not received their 5 iron_ingot" },
    { name: "no progress known", trade: agreedFirstMe, line: "agreed 2 min ago: you give 5 bread, Theo gives 5 iron_ingot, you first; nothing handed over yet: you have not given your 5 bread and have not received their 5 iron_ingot" },
    { name: "part given in a hand-off", trade: agreedFirstMe, progress: progress({ given: given3 }), line: "agreed 2 min ago: you give 5 bread, Theo gives 5 iron_ingot, you first; you gave 3 bread of your 5 bread, 2 bread still to give; you have not received their 5 iron_ingot" },
    { name: "part given by give_item, handed over for me", trade: theyGave, progress: progress({ given: given3 }), line: "Theo gave 5 iron_ingot; you gave 3 bread of your 5 bread, 2 bread still to give (it is handed over for you)" },
    { name: "give failed, partner away", trade: theyGave, progress: progress({ waits: "partner_away" }), line: "Theo gave 5 iron_ingot; you have not given your 5 bread yet (the hand-over failed; it is tried again when Theo is within 6 blocks)" },
    { name: "give dropped, waiting", trade: theyGave, progress: progress({ waits: "retake" }), line: "Theo gave 5 iron_ingot; you have not given your 5 bread yet (the hand-over was interrupted; it is tried again shortly)" },
  ];
  for (const row of rows) {
    const text = describeRelation(withTrade(fresh(), row.trade), "Theo", t0 + 2 * MIN, scoring, row.progress);
    assert.ok(text.endsWith(`Open: ${row.line}.`), `${row.name}: ${text}`);
  }
});

test("relation note round trip and a bad note", () => {
  let r = withScoreEvent(fresh(), { kind: "hurt", why: "hit you" }, t0, scoring);
  r = withTrade(r, deal("me"));
  const { note, context } = relationNote(r);
  assert.equal(context, "relation:Theo");
  assert.equal(JSON.parse(note).v, 2);
  assert.deepEqual(parseRelationNote(note), r);
  assert.equal(parseRelationNote("{bad"), null);
  assert.equal(parseRelationNote('{"partner":"Theo"}'), null);
});

test("D2: an old relation note whose trades have no receivedAt parses, with receivedAt null", () => {
  const relation = { ...newRelation("Theo", 1, 0), trades: [{ id: "a", partner: "Theo", give: [], get: [], first: "me", state: "agreed", createdAt: 1, agreedAt: 1, gaveAt: null, received: [], endedAt: null, brokenBy: null, late: false, note: "" }] };
  const parsed = parseRelationNote(JSON.stringify({ v: 2, ...relation }));
  assert.equal(parsed?.trades[0]?.receivedAt, null);
});

const withOne = (t: ReturnType<typeof deal>) => withTrade(fresh(), t);

test("describeTrade agreed says nothing was handed over on either side", () => {
  const text = describeRelation(withOne(deal("them", { give: [{ item: "cobblestone", count: 60 }], get: [{ item: "cooked_beef", count: 16 }] })), "GlutenFoul", t0, scoring);
  assert.match(text, /agreed 0 min ago: you give 60 cobblestone, GlutenFoul gives 16 cooked_beef, GlutenFoul first; nothing handed over yet: you have not given your 60 cobblestone and have not received their 16 cooked_beef/u);
});

test("describeTrade they_gave says my side is not given yet", () => {
  const trade = creditTrade(deal("them", { give: [{ item: "cobblestone", count: 60 }], get: [{ item: "cooked_beef", count: 16 }] }), [{ item: "cooked_beef", count: 16 }], t0).trade;
  const text = describeRelation(withOne(trade), "GlutenFoul", t0, scoring);
  assert.match(text, /GlutenFoul gave 16 cooked_beef; you have not given your 60 cobblestone yet \(it is handed over for you\)/u);
});

test("describeTrade agreed with a partial payment says what arrived and what is owed", () => {
  const trade = creditTrade(deal("them", { give: [{ item: "cobblestone", count: 60 }], get: [{ item: "cooked_beef", count: 16 }] }), [{ item: "cooked_beef", count: 6 }], t0).trade;
  assert.equal(trade.state, "agreed");
  const text = describeRelation(withOne(trade), "GlutenFoul", t0, scoring);
  assert.match(text, /you have not given your 60 cobblestone yet; GlutenFoul handed over 6 cooked_beef and still owes 10 cooked_beef/u);
  assert.doesNotMatch(text, /nothing handed over yet/u);
});

const ledgerFixture = (): Relation => ({
  ...fresh(), score: 45, scoredAt: t0 + 60 * MIN,
  ledger: [
    { kind: "request_refused", delta: -3, why: "refused your request", at: t0 },
    { kind: "trade_done", delta: 8, why: "paid 3 iron_ingot for your 5 oak_log", at: t0 + 50 * MIN },
  ],
});

test("describe shows score band and reasons", () => {
  assert.equal(
    describeRelation(ledgerFixture(), "Theo", t0 + 60 * MIN, scoring),
    "You and Theo: 45, you like Theo. Lately: +8 paid 3 iron_ingot for your 5 oak_log (10 min ago); -3 refused your request (1 h ago). 0 trades done, 0 kept late, 0 broken.",
  );
});

test("describe drifts before showing", () => {
  const r: Relation = { ...fresh(), score: -40 };
  assert.match(describeRelation(r, "Theo", t0 + 4 * 3_600_000, scoring), /^You and Theo: -20, you dislike Theo\. /u);
});

test("stranger shows first impression", () => {
  const friendly = { ...scoring, temperament: { ...scoring.temperament, firstImpression: 25 } };
  assert.equal(describeRelation(null, "Theo", t0, friendly), "You have not dealt with Theo before; your first impression is that you like Theo.");
});

test("describe words an earlier event without a delta", () => {
  const r: Relation = { ...fresh(), ledger: [{ kind: "earlier", delta: 0, why: "wary: he cheated", at: t0 }] };
  assert.match(describeRelation(r, "Theo", t0 + MIN, scoring), /Lately: wary: he cheated \(1 min ago\)\./u);
});

const v1Note = (over: object = {}) => JSON.stringify({
  partner: "Theo", feeling: -2, word: "wary", why: "he cheated",
  facts: fresh().facts, trades: [], saidHas: [], saidNeeds: [], lastDealt: t0 + 5, ...over,
});

test("v1 note migrated", () => {
  const r = parseRelationNote(v1Note());
  assert.equal(r?.score, -60);
  assert.equal(r?.scoredAt, t0 + 5);
  assert.deepEqual(r?.ledger, [{ kind: "earlier", delta: 0, why: "wary: he cheated", at: t0 + 5 }]);
  assert.deepEqual([r?.requests, r?.lastHurt], [[], null]);
  assert.equal(parseRelationNote(v1Note({ feeling: 3 }))?.score, 90);
});

test("v1 note with empty word has no earlier event", () => {
  const r = parseRelationNote(v1Note({ feeling: 0, word: "", why: "" }));
  assert.deepEqual([r?.score, r?.ledger], [0, []]);
  assert.ok(!Object.is(r?.score, -0));
});

test("v2 round trip", () => {
  const r = { ...ledgerFixture(), requests: [{ what: "5 oak_log", at: t0, inRange: true, agreed: false }], lastHurt: t0 + 7 };
  assert.deepEqual(parseRelationNote(relationNote(r).note), r);
});

test("a v2 note with a broken ledger reads null, not as a v1 note", () => {
  assert.equal(parseRelationNote(JSON.stringify({ v: 2, ...ledgerFixture(), ledger: "x" })), null);
});

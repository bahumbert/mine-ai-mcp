import assert from "node:assert/strict";
import test from "node:test";
import type { Position } from "../runtime-client.ts";
import type { ItemCount, Trade, TradeSettings } from "./types.ts";
import { agreeTrade, attributeGains, cancelTrade, creditTrade, failTrade, inventoryGains, isOpen, markGave, proposeTrade, settleTrade } from "./trade.ts";

const settings: TradeSettings = { payBackMinutes: 10, startMinutes: 3, handoffDistance: 4, offersForgetMinutes: 60, maxOpenTrades: 3, tradeReach: 32 };
const MIN = 60_000;
const t0 = 1_000_000;
const ingots: ItemCount[] = [{ item: "iron_ingot", count: 5 }];
const bread: ItemCount[] = [{ item: "bread", count: 5 }];
const deal = (first: "me" | "them", over: Partial<{ give: ItemCount[]; get: ItemCount[]; now: number }> = {}) =>
  agreeTrade(null, { self: "Ayla", partner: "Theo", give: bread, get: ingots, first, now: t0, ...over });

test("proposal expires", () => {
  const t = proposeTrade({ self: "Ayla", partner: "Theo", give: bread, get: ingots, first: "me", now: t0 });
  assert.equal(t.state, "proposed");
  assert.equal(t.id, `Ayla-Theo-${t0}`);
  assert.equal(settleTrade(t, t0 + 3 * MIN - 1, settings).trade.state, "proposed");
  const ended = settleTrade(t, t0 + 3 * MIN, settings).trade;
  assert.equal(ended.state, "cancelled");
  assert.match(ended.note, /no answer/u);
  assert.equal(ended.endedAt, t0 + 3 * MIN);
});

test("agreeing a proposal keeps its id and moves it to agreed", () => {
  const p = proposeTrade({ self: "Ayla", partner: "Theo", give: bread, get: ingots, first: "me", now: t0 });
  const a = agreeTrade(p, { self: "Ayla", partner: "Theo", give: bread, get: ingots, first: "me", now: t0 + 1_000 });
  assert.equal(a.id, p.id);
  assert.equal(a.state, "agreed");
  assert.equal(a.agreedAt, t0 + 1_000);
});

test("nobody gave", () => {
  const t = deal("them");
  const early = settleTrade(t, t0 + 3 * MIN, settings);
  assert.equal(early.nobodyGave, true);
  assert.equal(early.trade.state, "agreed");
  assert.equal(settleTrade(t, t0 + 3 * MIN - 1, settings).nobodyGave, false);
  const late = settleTrade(t, t0 + 10 * MIN, settings).trade;
  assert.equal(late.state, "cancelled");
  assert.match(late.note, /nobody gave/u);
});

test("I went first, paid in full", () => {
  const gave = markGave(deal("me"), t0 + 1_000);
  assert.equal(gave.state, "i_gave");
  const { trade, used } = creditTrade(gave, ingots, t0 + 2_000);
  assert.equal(trade.state, "done");
  assert.deepEqual(used, ingots);
  assert.equal(trade.endedAt, t0 + 2_000);
});

test("deadline on a stopped clock", () => {
  const t1 = t0 + 1_000;
  const gave = markGave(deal("me"), t1);
  assert.equal(settleTrade(gave, t1 + 10 * MIN - 1, settings).trade.state, "i_gave");
  const broken = settleTrade(gave, t1 + 10 * MIN, settings).trade;
  assert.equal(broken.state, "broken");
  assert.equal(broken.brokenBy, "them");
  assert.match(broken.note, /0 of 5 iron_ingot/u);
});

test("a short payment ends broken naming what came", () => {
  const gave = markGave(deal("me"), t0);
  const part = creditTrade(gave, [{ item: "iron_ingot", count: 3 }], t0 + MIN).trade;
  assert.equal(part.state, "i_gave");
  const broken = settleTrade(part, t0 + 10 * MIN, settings).trade;
  assert.equal(broken.state, "broken");
  assert.match(broken.note, /3 of 5 iron_ingot/u);
});

test("late payment", () => {
  const broken = settleTrade(markGave(deal("me"), t0), t0 + 10 * MIN, settings).trade;
  const { trade } = creditTrade(broken, ingots, t0 + 20 * MIN);
  assert.equal(trade.state, "done");
  assert.equal(trade.late, true);
  assert.equal(trade.brokenBy, null);
});

test("they gave first", () => {
  const { trade } = creditTrade(deal("them"), ingots, t0 + MIN);
  assert.equal(trade.state, "they_gave");
  assert.equal(settleTrade(trade, t0 + MIN, settings).giveDue, true);
  assert.equal(markGave(trade, t0 + 2 * MIN).state, "done");
});

test("gift", () => {
  const gift = deal("me", { get: [] });
  assert.equal(settleTrade(gift, t0 + MIN, settings).giveDue, false);
  assert.equal(markGave(gift, t0 + MIN).state, "done");
});

test("a gift received is done once credited", () => {
  const { trade } = creditTrade(deal("them", { give: [] }), ingots, t0 + MIN);
  assert.equal(trade.state, "done");
});

test("credit capped at owed", () => {
  const { trade, used } = creditTrade(markGave(deal("me"), t0), [{ item: "iron_ingot", count: 8 }, { item: "stick", count: 2 }], t0 + MIN);
  assert.deepEqual(used, ingots);
  assert.deepEqual(trade.received, ingots);
});

test("a failed give is broken by me, a cancel is cancelled", () => {
  const failed = failTrade(deal("me"), t0 + MIN, "items gone");
  assert.deepEqual([failed.state, failed.brokenBy, failed.note], ["broken", "me", "items gone"]);
  assert.equal(creditTrade(failed, ingots, t0 + 2 * MIN).trade.state, "broken");
  const cancelled = cancelTrade(deal("me"), t0 + MIN, "changed my mind");
  assert.deepEqual([cancelled.state, cancelled.note, isOpen(cancelled)], ["cancelled", "changed my mind", false]);
  assert.equal(isOpen(deal("me")), true);
});

const at = (x: number): Position => ({ x, y: 0, z: 0 });
const logTrade = (partner: string, now: number): Trade => agreeTrade(null, { self: "Ayla", partner, give: bread, get: [{ item: "oak_log", count: 5 }], first: "me", now });
const attribute = (o: Partial<Parameters<typeof attributeGains>[0]> & { trades: readonly Trade[] }) => attributeGains({
  gains: [{ item: "oak_log", count: 5 }], partners: new Map(), previous: new Map(), self: at(0), ownStepYields: new Set(), handoffDistance: 4, recentlyNear: new Set(), ...o,
});

test("own step yielding the item is not credited", () => {
  const trade = logTrade("Theo", t0);
  const out = attribute({ trades: [trade], partners: new Map([["Theo", at(2)]]), ownStepYields: new Set(["oak_log"]) });
  assert.equal(out.size, 0);
  assert.deepEqual(attribute({ trades: [trade], partners: new Map([["Theo", at(2)]]) }).get(trade.id), [{ item: "oak_log", count: 5 }]);
});

test("partner just out of range", () => {
  const trade = logTrade("Theo", t0);
  assert.equal(attribute({ trades: [trade], partners: new Map([["Theo", at(5)]]), previous: new Map([["Theo", at(5)]]) }).size, 0);
  assert.equal(attribute({ trades: [trade], partners: new Map([["Theo", at(5)]]), previous: new Map([["Theo", at(3)]]) }).size, 1);
});

test("absent partner", () => {
  const trade = logTrade("Theo", t0);
  assert.equal(attribute({ trades: [trade], partners: new Map([["Theo", null]]) }).size, 0);
  assert.equal(attribute({ trades: [trade] }).size, 0);
});

test("two partners expect the same item: nearest wins, then the oldest trade", () => {
  const theo = logTrade("Theo", t0 + 5);
  const bruno = logTrade("Bruno", t0);
  const near = attribute({ trades: [theo, bruno], partners: new Map([["Theo", at(1)], ["Bruno", at(3)]]) });
  assert.deepEqual([...near.keys()], [theo.id]);
  const tie = attribute({ trades: [theo, bruno], partners: new Map([["Theo", at(2)], ["Bruno", at(2)]]) });
  assert.deepEqual([...tie.keys()], [bruno.id]);
});

test("a gain larger than owed spills to the next trade, never past what is owed", () => {
  const theo = logTrade("Theo", t0);
  const bruno = logTrade("Bruno", t0 + 5);
  const out = attribute({ gains: [{ item: "oak_log", count: 8 }], trades: [theo, bruno], partners: new Map([["Theo", at(1)], ["Bruno", at(2)]]) });
  assert.deepEqual(out.get(theo.id), [{ item: "oak_log", count: 5 }]);
  assert.deepEqual(out.get(bruno.id), [{ item: "oak_log", count: 3 }]);
});

test("a proposed or failed-by-me trade is not credited", () => {
  const p = proposeTrade({ self: "Ayla", partner: "Theo", give: bread, get: [{ item: "oak_log", count: 5 }], first: "me", now: t0 });
  assert.equal(attribute({ trades: [p], partners: new Map([["Theo", at(1)]]) }).size, 0);
  const failed = failTrade(logTrade("Theo", t0), t0 + 1, "gone");
  assert.equal(attribute({ trades: [failed], partners: new Map([["Theo", at(1)]]) }).size, 0);
});

test("inventoryGains sums stacks per name and keeps only positive differences", () => {
  const before = [{ name: "oak_log", count: 10 }, { name: "oak_log", count: 4 }, { name: "bread", count: 5 }];
  const after = [{ name: "oak_log", count: 10 }, { name: "oak_log", count: 9 }, { name: "bread", count: 2 }, { name: "iron_ingot", count: 3 }];
  assert.deepEqual(inventoryGains(before, after), [{ item: "oak_log", count: 5 }, { item: "iron_ingot", count: 3 }]);
});

test("a partner near within the last 30 s counts as near for a payment picked up after they turned away", () => {
  const trade = logTrade("Theo", t0);
  const out = attribute({ trades: [trade], partners: new Map(), previous: new Map(), recentlyNear: new Set(["theo"]) });
  assert.deepEqual(out.get(trade.id), [{ item: "oak_log", count: 5 }]);
  assert.equal(attribute({ trades: [trade], partners: new Map(), previous: new Map(), recentlyNear: new Set() }).size, 0, "not near lately: not credited");
});

test("a recently near partner never gets what my own running step yields", () => {
  const trade = logTrade("Theo", t0);
  assert.equal(attribute({ trades: [trade], recentlyNear: new Set(["theo"]), ownStepYields: new Set(["oak_log"]) }).size, 0);
});

test("two trades owed the same item: the recent partner is credited, the one never near is not", () => {
  const theo = logTrade("Theo", t0 + 5);
  const bruno = logTrade("Bruno", t0);
  const out = attribute({ trades: [bruno, theo], recentlyNear: new Set(["theo"]) });
  assert.deepEqual([...out.keys()], [theo.id]);
});

test("a recently near partner ranks as at hand-off distance: after one really near, before nobody", () => {
  const theo = logTrade("Theo", t0);
  const bruno = logTrade("Bruno", t0 + 5);
  const out = attribute({ trades: [theo, bruno], partners: new Map([["Bruno", at(1)]]), recentlyNear: new Set(["theo"]), gains: [{ item: "oak_log", count: 5 }] });
  assert.deepEqual([...out.keys()], [bruno.id], "Bruno, 1 block away, comes first");
});

import assert from "node:assert/strict";
import test from "node:test";
import type { TradeDecision } from "../mind.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import { FakeRuntime } from "../testing.ts";
import { checkTradeDecision } from "./checks.ts";
import type { Trade } from "./types.ts";

const decision = (over: Partial<TradeDecision> = {}): TradeDecision => ({ action: "propose", give: [{ item: "bread", count: 5 }], get: [{ item: "iron_ingot", count: 5 }], first: "me", ...over });
const snapshotWithTheoAt = (x: number | null): BotSnapshot => ({
  ...new FakeRuntime().snapshot,
  inventory: [{ name: "bread", count: 10 }],
  players: x === null ? [] : [{ username: "Theo", position: { x, y: 64, z: 0 } }],
});
const openTrade = (over: Partial<Trade> = {}): Trade => ({ id: "Ayla-Theo-1", partner: "Theo", give: [], get: [], first: "me", state: "proposed", createdAt: 1, agreedAt: null, receivedAt: null, gaveAt: null, received: [], endedAt: null, brokenBy: null, late: false, note: "", ...over });
const check = (d: TradeDecision, theoAt: number | null, over: { trades?: Trade[]; maxOpenTrades?: number } = {}) =>
  checkTradeDecision({ decision: d, speaker: "Theo", snapshot: snapshotWithTheoAt(theoAt), trades: over.trades ?? [], maxOpenTrades: over.maxOpenTrades ?? 3, reach: 32 });

test("F10 a propose from a speaker 40 blocks away is refused with the distance; unseen, with 'out of sight'", () => {
  assert.match(check(decision(), 40) ?? "", /^Theo is too far away to trade with \(40 blocks away\): no trade from here; say they can come to you$/u);
  assert.match(check(decision(), null) ?? "", /^Theo is too far away to trade with \(out of sight\): no trade from here; say they can come to you$/u);
});

test("F10 an accept of my own open proposal from a speaker now out of reach is refused", () => {
  assert.match(check(decision({ action: "accept" }), 50, { trades: [openTrade()] }) ?? "", /too far away to trade with \(50 blocks away\)/u);
});

test("F10 a speaker exactly at the reach passes; a decline and a cancel pass at any distance, seen or not", () => {
  assert.equal(check(decision(), 32), null);
  for (const action of ["decline", "cancel"] as const) {
    assert.equal(check(decision({ action }), 500), null);
    assert.equal(check(decision({ action }), null), null);
  }
});

test("F10 a speaker in reach still meets every other check", () => {
  assert.match(check(decision({ get: [{ item: "not_an_item", count: 1 }] }), 5) ?? "", /not a Minecraft item id/u);
  assert.match(check(decision({ give: [{ item: "bread", count: 50 }] }), 5) ?? "", /you carry 10 bread, not 50/u);
  assert.match(check(decision(), 5, { trades: [openTrade({ state: "agreed" })] }) ?? "", /already have a trade open with Theo/u);
  assert.match(check(decision(), 5, { trades: [openTrade({ partner: "Mia" }), openTrade({ partner: "Bo" })], maxOpenTrades: 2 }) ?? "", /2 trades open, the most at once/u);
  assert.match(check(decision({ get: [{ item: "oak_log", count: 64 * 40 }] }), 5) ?? "", /no room in your inventory/u);
});

test("a propose to a partner I already have a proposal open with passes (it replaces it); an agreed trade still blocks", () => {
  assert.equal(check(decision(), 5, { trades: [openTrade()] }), null);
  assert.match(check(decision(), 5, { trades: [openTrade({ state: "agreed" })] }) ?? "", /already have a trade open with Theo \(agreed\)/u);
  assert.match(check(decision(), 5, { trades: [openTrade({ state: "they_gave" })] }) ?? "", /already have a trade open with Theo \(they_gave\)/u);
});

test("a replacing propose at maxOpenTrades passes; another partner's proposal at the limit is still refused", () => {
  const full = [openTrade(), openTrade({ id: "x", partner: "Mia" }), openTrade({ id: "y", partner: "Bo" })];
  assert.equal(check(decision(), 5, { trades: full, maxOpenTrades: 3 }), null);
  assert.match(check(decision(), 5, { trades: full.slice(1), maxOpenTrades: 2 }) ?? "", /2 trades open, the most at once/u);
});

test("an accept refused for an amount says how many I may propose instead; none when I carry nothing of it", () => {
  assert.match(check(decision({ action: "accept", give: [{ item: "bread", count: 18 }] }), 5) ?? "", /you carry 10 bread, not 18: you may propose 10 instead$/u);
  assert.doesNotMatch(check(decision({ action: "accept", give: [{ item: "cobblestone", count: 18 }] }), 5) ?? "", /you may propose/u);
  const promised = openTrade({ id: "p", partner: "Mia", state: "agreed", give: [{ item: "bread", count: 4 }] });
  assert.match(check(decision({ action: "accept", give: [{ item: "bread", count: 18 }] }), 5, { trades: [promised] }) ?? "", /you carry 10 bread, 4 of them promised in other trades, not 18: you may propose 6 instead$/u);
});

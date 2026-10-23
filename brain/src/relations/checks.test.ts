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
const openTrade = (over: Partial<Trade> = {}): Trade => ({ id: "Ayla-Theo-1", partner: "Theo", give: [], get: [], first: "me", state: "proposed", createdAt: 1, agreedAt: null, gaveAt: null, received: [], endedAt: null, brokenBy: null, late: false, note: "", ...over });
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
  assert.match(check(decision(), 5, { trades: [openTrade()] }) ?? "", /already have a trade open with Theo/u);
  assert.match(check(decision(), 5, { trades: [openTrade({ partner: "Mia" }), openTrade({ partner: "Bo" })], maxOpenTrades: 2 }) ?? "", /2 trades open, the most at once/u);
  assert.match(check(decision({ get: [{ item: "oak_log", count: 64 * 40 }] }), 5) ?? "", /no room in your inventory/u);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { BotSnapshot } from "../runtime-client.ts";
import { Arrivals } from "./collects.ts";
import { proposeTrade } from "./trade.ts";
import type { Trade } from "./types.ts";

const bag = (iron: number): BotSnapshot["inventory"] => (iron > 0 ? [{ name: "iron_ingot", count: iron }] : []);
const trade = (get = 16): Trade => proposeTrade({ self: "Ayla", partner: "Theo", give: [{ item: "bread", count: 5 }], get: [{ item: "iron_ingot", count: get }], first: "them", now: 0 });
const none: ReadonlySet<string> = new Set();

test("items that came after the agreement are unattributed up to what is owed", () => {
  const a = new Arrivals();
  const t = trade(16);
  a.start(t, bag(2));
  assert.deepEqual(a.arrived(t, bag(10), none), [{ item: "iron_ingot", count: 8 }]);
  assert.deepEqual(a.arrived(t, bag(40), none), [{ item: "iron_ingot", count: 16 }], "capped at what is owed");
});

test("a credit made after the agreement is not credited again (16 owed, 8 credited, 8 walked over)", () => {
  const a = new Arrivals();
  const t = trade(16);
  a.start(t, bag(0));
  a.explain([{ item: "iron_ingot", count: 8 }]);
  const left = { ...t, received: [{ item: "iron_ingot", count: 8 }] };
  assert.deepEqual(a.arrived(left, bag(8), none), [], "the bag only gained what was credited");
  assert.deepEqual(a.arrived(left, bag(16), none), [{ item: "iron_ingot", count: 8 }]);
});

test("items eaten or crafted after the agreement: carried below the baseline credits nothing", () => {
  const a = new Arrivals();
  const t = trade(5);
  a.start(t, bag(3));
  assert.deepEqual(a.arrived(t, bag(1), none), []);
  assert.deepEqual(a.arrived(t, bag(3), none), [], "what came back up to the baseline is not new");
});

test("the item from my own step is not credited", () => {
  const a = new Arrivals();
  const t = trade(5);
  a.start(t, bag(0));
  assert.deepEqual(a.arrived(t, bag(5), new Set(["iron_ingot"])), []);
});

test("no baseline (a restart, an agreement with no inventory seen, a forgotten trade): nothing is credited", () => {
  const a = new Arrivals();
  assert.deepEqual(a.arrived(trade(5), bag(5), none), []);
  const t = trade(5);
  a.start(t, bag(0));
  a.forget(t.id);
  assert.deepEqual(a.arrived(t, bag(5), none), []);
});

test("a rebase takes the baseline again from the bag: the gap's gains are no arrival", () => {
  const a = new Arrivals();
  const t = trade(5);
  a.start(t, bag(0));
  a.rebase([t], bag(5));
  assert.deepEqual(a.arrived(t, bag(5), none), []);
  assert.deepEqual(a.arrived(t, bag(7), none), [{ item: "iron_ingot", count: 2 }]);
});

test("a credit to another trade is explained for every baseline taken before it", () => {
  const a = new Arrivals();
  const older = trade(5);
  const newer = { ...trade(5), id: "other" };
  a.start(older, bag(0));
  a.start(newer, bag(0));
  a.explain([{ item: "iron_ingot", count: 5 }]);
  assert.deepEqual(a.arrived(newer, bag(5), none), [], "those 5 were credited to the older trade");
});

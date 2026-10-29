import assert from "node:assert/strict";
import test from "node:test";
import { EARLIER_GAIN_MS, EARLIER_GIVE_MS, EarlierLedger, nearPlayers } from "./earlier.ts";
import { agreeTrade } from "./trade.ts";
import type { ItemCount } from "./types.ts";

const t0 = 1_000_000;
const SEC = 1_000;
const beef = (count: number): ItemCount[] => [{ item: "cooked_beef", count }];
const trade = (partner = "Owner", getCount = 16) => agreeTrade(null, { self: "Finn", partner, give: [{ item: "cobblestone", count: 60 }], get: beef(getCount), first: "them", now: t0 });
const carrying = (count: number) => [{ name: "cooked_beef", count }];

test("a gain near a player who talked is claimed by their trade for that item", () => {
  const l = new EarlierLedger();
  l.heard("Owner", t0);
  assert.deepEqual(l.gained(beef(16), new Map([["owner", 2]]), t0 + 10 * SEC), beef(16));
  assert.deepEqual(l.claimGains(trade(), carrying(16), t0 + 20 * SEC), beef(16));
});

test("no window, no record", () => {
  const l = new EarlierLedger();
  assert.deepEqual(l.gained(beef(16), new Map([["owner", 2]]), t0), []);
  assert.deepEqual(l.claimGains(trade(), carrying(16), t0), []);
});

test("credit is capped by what is carried now and by what is owed", () => {
  const l = new EarlierLedger();
  l.heard("Owner", t0);
  l.gained(beef(16), new Map([["owner", 2]]), t0);
  assert.deepEqual(l.claimGains(trade(), carrying(10), t0), beef(10));
  const m = new EarlierLedger();
  m.heard("Owner", t0);
  m.gained(beef(16), new Map([["owner", 2]]), t0);
  assert.deepEqual(m.claimGains(trade("Owner", 5), carrying(16), t0), beef(5));
});

test("two windowed players at the same distance: recorded for nobody; at different distances the nearest", () => {
  const l = new EarlierLedger();
  l.heard("Owner", t0);
  l.heard("Theo", t0);
  assert.deepEqual(l.gained(beef(4), new Map([["owner", 2], ["theo", 2]]), t0), []);
  assert.deepEqual(l.gained(beef(4), new Map([["owner", 3], ["theo", 2]]), t0), beef(4));
  assert.deepEqual(l.claimGains(trade("Owner"), carrying(4), t0), []);
  assert.deepEqual(l.claimGains(trade("Theo"), carrying(4), t0), beef(4));
});

test("a player who did not talk does not hide the one who did", () => {
  const l = new EarlierLedger();
  l.heard("Owner", t0);
  assert.deepEqual(l.gained(beef(4), new Map([["owner", 3], ["theo", 1]]), t0), beef(4));
});

test("entries expire after 10 min and a claimed entry is not claimed again", () => {
  const l = new EarlierLedger();
  l.heard("Owner", t0);
  l.gained(beef(16), new Map([["owner", 2]]), t0);
  assert.deepEqual(l.claimGains(trade(), carrying(16), t0 + EARLIER_GAIN_MS + 1), []);
  l.gained(beef(16), new Map([["owner", 2]]), t0);
  assert.deepEqual(l.claimGains(trade(), carrying(16), t0 + 1), beef(16));
  assert.deepEqual(l.claimGains(trade(), carrying(16), t0 + 2), []);
});

test("windows close 10 min after the last line", () => {
  const l = new EarlierLedger();
  assert.equal(l.watching(t0), false);
  l.heard("Owner", t0);
  assert.equal(l.watching(t0 + EARLIER_GAIN_MS), true);
  assert.equal(l.watching(t0 + EARLIER_GAIN_MS + 1), false);
});

test("S2: an unclaimed gain keeps the window open until 10 min after the gain, and a claimed one does not", () => {
  const l = new EarlierLedger();
  l.heard("Owner", t0);
  l.gained(beef(16), new Map([["owner", 2]]), t0 + 8 * 60 * SEC);
  assert.equal(l.watching(t0 + 11 * 60 * SEC), true, "the window by line closed at 10 min, the gain is still waiting");
  assert.equal(l.watching(t0 + 8 * 60 * SEC + EARLIER_GAIN_MS), true);
  assert.equal(l.watching(t0 + 8 * 60 * SEC + EARLIER_GAIN_MS + 1), false);
  assert.deepEqual(l.claimGains(trade(), carrying(16), t0 + 9 * 60 * SEC), beef(16));
  assert.equal(l.watching(t0 + 11 * 60 * SEC), false, "the only gain was claimed");
});

test("S5: gains and gives older than the window are dropped as new ones come in", () => {
  const l = new EarlierLedger();
  const step = 1_800;
  for (let i = 0; i < 1000; i += 1) {
    l.heard("Owner", t0 + i * step);
    l.gained(beef(1), new Map([["owner", 2]]), t0 + i * step);
    l.gave("Owner", "cobblestone", 1, t0 + i * step);
  }
  // Claiming at t0, before every entry, keeps all that survived the pruning: the last 10 min, 334 entries of 1.
  assert.equal(l.claimGains(trade("Owner", 10_000), carrying(10_000), t0).reduce((n, c) => n + c.count, 0), 334);
  assert.equal(l.claimGives(trade(), t0).length, 334);
});

test("earlier gives are claimed by the next trade with the partner, once, and expire", () => {
  const l = new EarlierLedger();
  l.gave("OWNER", "cobblestone", 60, t0);
  assert.deepEqual(l.givesTo("owner", t0 + 1), [{ item: "cobblestone", count: 60 }]);
  assert.deepEqual(l.claimGives(trade("Theo"), t0 + 1), []);
  assert.deepEqual(l.claimGives(trade(), t0 + 1), [{ item: "cobblestone", count: 60 }]);
  assert.deepEqual(l.claimGives(trade(), t0 + 2), []);
  l.gave("Owner", "cobblestone", 5, t0);
  assert.deepEqual(l.claimGives(trade(), t0 + EARLIER_GIVE_MS + 1), []);
});

test("nearPlayers: near now or at the previous tick, or lately near at hand-off distance", () => {
  const self = { x: 0, y: 64, z: 0 };
  const near = nearPlayers({
    partners: new Map([["Owner", { x: 2, y: 64, z: 0 }], ["Far", { x: 40, y: 64, z: 0 }]]),
    previous: new Map([["Theo", { x: 3, y: 64, z: 0 }]]), self, handoffDistance: 4, recentlyNear: new Set(["zed"]),
  });
  assert.deepEqual([...near].sort(), [["owner", 2], ["theo", 3], ["zed", 4]]);
});

test("keepUnpaid records only what no trade took and my own step did not yield", () => {
  const l = new EarlierLedger();
  l.heard("Owner", t0);
  const gains = [...beef(16), { item: "oak_log", count: 3 }];
  const where = { partners: new Map([["Owner", { x: 2, y: 64, z: 0 }]]), previous: new Map(), self: { x: 0, y: 64, z: 0 }, handoffDistance: 4, recentlyNear: new Set<string>() };
  const kept = l.keepUnpaid({ gains, credited: new Map([["trade-1", beef(6)]]), mined: new Set(["oak_log"]), ...where }, t0);
  assert.deepEqual(kept, beef(10));
  assert.deepEqual(l.claimGains(trade(), carrying(16), t0), beef(10));
});

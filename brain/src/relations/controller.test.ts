import assert from "node:assert/strict";
import test from "node:test";
import type { Memory } from "../memory.ts";
import type { TradeDecision } from "../mind.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";
import { FakeRuntime, scriptedMind, testPersona, testScoring } from "../testing.ts";
import { RelationBook } from "./book.ts";
import { TradeController } from "./controller.ts";
import type { Handoff } from "./handoff.ts";
import { newRelation, withTrade } from "./record.ts";
import { proposeTrade, sameDealTerms } from "./trade.ts";
import type { ItemCount, RelationEvent, Trade, TradeEvent, TradeSettings } from "./types.ts";

const MIN = 60_000;
const t0 = 1_000_000;
const settings: TradeSettings = { payBackMinutes: 10, startMinutes: 3, handoffDistance: 4, offersForgetMinutes: 60, maxOpenTrades: 3, tradeReach: 32 };
const signal = new AbortController().signal;
const bread = (count: number): ItemCount[] => [{ item: "bread", count }];
const ingots = (count: number): ItemCount[] => [{ item: "iron_ingot", count }];

interface Harness {
  readonly c: TradeController;
  readonly book: RelationBook;
  readonly handoffs: Handoff[];
  /** The wait-for-their-side hand-offs, kept apart from the gives and collects. */
  readonly awaits: Handoff[];
  readonly events: (TradeEvent | RelationEvent)[];
  readonly logs: string[];
  readonly chat: ReturnType<typeof scriptedMind>["chat"];
  readonly state: { now: number };
}

function harness(over: { settings?: Partial<TradeSettings> } = {}): Harness {
  const state = { now: t0 };
  const handoffs: Handoff[] = [];
  const awaits: Handoff[] = [];
  const events: (TradeEvent | RelationEvent)[] = [];
  const logs: string[] = [];
  const saved: Memory[] = [];
  const book = new RelationBook({ save: async (m) => { saved.push(m); }, remove: async () => {}, now: () => state.now, log: (l) => logs.push(l), scoring: testScoring() });
  const { chat } = scriptedMind();
  const c = new TradeController({
    self: "Ayla", persona: testPersona(), book, settings: { ...settings, ...over.settings }, now: () => state.now,
    takeHandoff: (h) => (h.kind === "await" ? awaits : handoffs).push(h),
    journal: (e) => events.push(e), log: (l) => logs.push(l),
  });
  return { c, book, handoffs, awaits, events, logs, chat, state };
}

const snapshot = (over: { inventory?: BotSnapshot["inventory"]; theo?: Position | null | "absent"; position?: Position } = {}): BotSnapshot => ({
  ...new FakeRuntime().snapshot,
  position: over.position ?? { x: 0, y: 64, z: 0 },
  inventory: over.inventory ?? [{ name: "bread", count: 10 }, { name: "oak_log", count: 10 }],
  // The other speakers of the tests stand next to the bot, so the reach check passes.
  players: over.theo === "absent" ? [] : [{ username: "Theo", position: over.theo === undefined ? { x: 2, y: 64, z: 0 } : over.theo }, ...["Bruno", "Ayla2", "Zed"].map((username) => ({ username, position: { x: 2, y: 64, z: 0 } }))],
});

const decision = (over: Partial<TradeDecision> = {}): TradeDecision => ({ action: "accept", give: bread(5), get: ingots(5), first: "me", ...over });
const kinds = (h: Harness): string[] => h.handoffs.map((x) => x.kind);
const theirTrade = (h: Harness) => h.book.get("Theo")!.trades.at(-1)!;

test("checks: each refusal gives its reason and a good decision passes", () => {
  const h = harness();
  const s = snapshot();
  assert.match(h.c.checkDecision(decision({ give: [{ item: "unobtainium_ingot", count: 1 }] }), "Theo", s) ?? "", /unobtainium_ingot/u);
  assert.match(h.c.checkDecision(decision({ get: [{ item: "not_an_item_at_all", count: 1 }] }), "Theo", s) ?? "", /not_an_item_at_all/u);
  assert.match(h.c.checkDecision(decision({ give: bread(11) }), "Theo", s) ?? "", /carry 10 bread/u);
  const five = ["stick", "dirt", "stone", "sand", "gravel"].map((item) => ({ item, count: 1 }));
  assert.match(h.c.checkDecision(decision({ get: five }), "Theo", s) ?? "", /at most 4/u);
  const full = snapshot({ inventory: Array.from({ length: 36 }, (_, i) => ({ name: i === 0 ? "bread" : `stack_${i}`, count: 64 })) });
  assert.match(h.c.checkDecision(decision({ give: bread(5), get: ingots(5) }), "Theo", full) ?? "", /room/u);
  assert.equal(h.c.checkDecision(decision(), "Theo", s), null);
  assert.equal(h.c.checkDecision(decision({ action: "decline", give: [], get: [] }), "Theo", s), null);
});

test("checks: a second open trade with one partner, and a fourth in all", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ action: "propose" }), "Theo", s);
  assert.equal(h.c.checkDecision(decision({ action: "propose" }), "Theo", s), null, "a new proposal replaces the open one");
  assert.equal(h.c.checkDecision(decision({ action: "accept" }), "Theo", s), null, "accepting that proposal is fine");
  await h.c.onDecision(decision({ action: "propose", give: bread(1) }), "Bruno", s);
  await h.c.onDecision(decision({ action: "propose", give: bread(1) }), "Ayla2", s);
  assert.match(h.c.checkDecision(decision({ action: "propose", give: bread(1) }), "Zed", s) ?? "", /3 trades/u);
});

test("first me gives at once", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "me" }), "Theo", snapshot());
  assert.equal(theirTrade(h).state, "agreed");
  assert.deepEqual(h.handoffs, [{ kind: "give", tradeId: theirTrade(h).id, partner: "Theo", items: bread(5) }]);
  assert.equal(h.events.at(-1)?.kind, "trade");
});

test("first them waits until they paid in full, then gives", async () => {
  const h = harness();
  const before = snapshot();
  await h.c.onDecision(decision({ first: "them" }), "Theo", before);
  await h.c.tick(before, new Set(), signal);
  assert.deepEqual(h.handoffs, []);
  h.state.now += 1_000;
  await h.c.tick(snapshot({ inventory: [...before.inventory, { name: "iron_ingot", count: 3 }] }), new Set(), signal);
  assert.deepEqual(h.handoffs, [], "a part payment does not make me give");
  h.state.now += 1_000;
  await h.c.tick(snapshot({ inventory: [...before.inventory, { name: "iron_ingot", count: 5 }] }), new Set(), signal);
  assert.equal(theirTrade(h).state, "they_gave");
  assert.deepEqual(kinds(h), ["give"]);
  await h.c.handoffEnded(theirTrade(h).id, "done", "gave");
  assert.equal(theirTrade(h).state, "done");
  assert.equal(h.book.get("Theo")!.facts.tradesDone, 1);
});

test("partial payment: broken at the deadline naming what came, no second give", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "me" }), "Theo", s);
  await h.c.handoffEnded(theirTrade(h).id, "done", "gave 5 bread");
  assert.equal(theirTrade(h).state, "i_gave");
  h.state.now += MIN;
  await h.c.tick(s, new Set(), signal);
  h.state.now += MIN;
  await h.c.tick(snapshot({ inventory: [...s.inventory, { name: "iron_ingot", count: 3 }] }), new Set(), signal);
  h.state.now += 10 * MIN;
  await h.c.tick(snapshot({ inventory: [...s.inventory, { name: "iron_ingot", count: 3 }] }), new Set(), signal);
  const trade = theirTrade(h);
  assert.equal(trade.state, "broken");
  assert.match(trade.note, /3 of 5 iron_ingot/u);
  assert.equal(h.book.get("Theo")!.facts.promisesBroken, 1);
  assert.equal(h.handoffs.length, 1, "only the first give");
});

test("a late payment closes a broken trade as kept late", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "me" }), "Theo", s);
  await h.c.handoffEnded(theirTrade(h).id, "done", "gave");
  await h.c.tick(s, new Set(), signal);
  h.state.now += 11 * MIN;
  await h.c.tick(s, new Set(), signal);
  assert.equal(theirTrade(h).state, "broken");
  h.state.now += MIN;
  await h.c.tick(snapshot({ inventory: [...s.inventory, { name: "iron_ingot", count: 5 }] }), new Set(), signal);
  assert.equal(theirTrade(h).state, "done");
  const facts = h.book.get("Theo")!.facts;
  assert.deepEqual([facts.promisesBroken, facts.keptLate, facts.tradesDone], [0, 1, 1]);
});

test("late payment nets keptLate", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "me" }), "Theo", s);
  await h.c.handoffEnded(theirTrade(h).id, "done", "gave");
  await h.c.tick(s, new Set(), signal);
  h.state.now += 11 * MIN;
  await h.c.tick(s, new Set(), signal);
  assert.equal(Math.round(h.book.get("Theo")!.score), -20, "the broken promise cost its amount");
  h.state.now += MIN;
  await h.c.tick(snapshot({ inventory: [...s.inventory, { name: "iron_ingot", count: 5 }] }), new Set(), signal);
  const r = h.book.get("Theo")!;
  assert.equal(Math.round(r.score), 3);
  assert.deepEqual(r.ledger.map((e) => [e.kind, e.delta]), [["promise_broken", -20], ["kept_late", 23]]);
  assert.deepEqual(h.events.filter((e) => e.kind === "relation").map((e) => e.kind === "relation" ? [e.scoreKind, e.delta, e.score] : null), [["promise_broken", -20, -20], ["kept_late", 23, 3]]);
});

test("a trade ended without a score (cancelled) leaves the ledger empty", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ action: "propose" }), "Theo", s);
  await h.c.onDecision(decision({ action: "decline", give: [], get: [] }), "Theo", s);
  assert.equal(theirTrade(h).state, "cancelled");
  assert.deepEqual([h.book.get("Theo")!.ledger.length, h.events.filter((e) => e.kind === "relation").length], [0, 0]);
});

test("my own step yielding the item is not credited, a collect hand-off is", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ give: [], get: ingots(5), first: "them", action: "accept" }), "Theo", s);
  await h.c.tick(s, new Set(), signal);
  h.state.now += 1_000;
  await h.c.tick(snapshot({ inventory: [...s.inventory, { name: "iron_ingot", count: 5 }] }), new Set(["iron_ingot"]), signal);
  assert.equal(theirTrade(h).state, "agreed", "my own mining of iron is not their payment");
});

test("collect fallback once: a partner line, no gain in 5 s, one collect", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "them" }), "Theo", s);
  await h.c.tick(s, new Set(), signal);
  h.c.heardLine("Theo", h.state.now, 2);
  h.state.now += 4_000;
  await h.c.tick(s, new Set(), signal);
  assert.deepEqual(h.handoffs, []);
  h.state.now += 1_000;
  await h.c.tick(s, new Set(), signal);
  assert.deepEqual(kinds(h), ["collect"]);
  assert.deepEqual(h.handoffs[0], { kind: "collect", tradeId: theirTrade(h).id, items: ingots(5) });
  await h.c.handoffEnded(theirTrade(h).id, "done", "picked up");
  h.c.heardLine("Theo", h.state.now, 2);
  h.state.now += 6_000;
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.handoffs.length, 1, "no second collect");
});

test("collect fallback waits for the partner to be near", async () => {
  const h = harness();
  const far = snapshot({ theo: { x: 40, y: 64, z: 0 } });
  await h.c.onDecision(decision({ first: "them" }), "Theo", far);
  await h.c.tick(far, new Set(), signal);
  h.c.heardLine("Theo", h.state.now, 2);
  h.state.now += 6_000;
  await h.c.tick(far, new Set(), signal);
  assert.deepEqual(h.handoffs, []);
});

test("items gone: my give failed because I no longer carry them", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "me" }), "Theo", snapshot());
  await h.c.handoffEnded(theirTrade(h).id, "items_gone", "no bread left");
  assert.equal(theirTrade(h).state, "broken");
  assert.equal(theirTrade(h).brokenBy, "me");
  assert.equal(h.book.get("Theo")!.facts.iFailedToPay, 1);
});

test("a failed give is retried once when the partner is near, then it is a failure to pay", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "me" }), "Theo", s);
  await h.c.handoffEnded(theirTrade(h).id, "failed", "cannot reach Theo");
  assert.equal(theirTrade(h).state, "agreed");
  await h.c.tick(snapshot({ theo: { x: 100, y: 64, z: 0 } }), new Set(), signal);
  assert.equal(h.handoffs.length, 1, "not while they are far");
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.handoffs.length, 2);
  await h.c.handoffEnded(theirTrade(h).id, "failed", "cannot reach Theo");
  assert.equal(theirTrade(h).state, "broken");
  assert.match(theirTrade(h).note, /cannot reach Theo/u);
  assert.equal(h.book.get("Theo")!.facts.iFailedToPay, 1);
});

test("a dropped hand-off leaves the trade due and it is taken again later", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "me" }), "Theo", s);
  h.c.handoffDropped(theirTrade(h).id);
  assert.equal(theirTrade(h).state, "agreed");
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.handoffs.length, 1, "not at once");
  h.state.now += 31_000;
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.handoffs.length, 2);
});

test("a give stopped after an earlier failure is retaken only once the partner is near, not 30 s later wherever they are (owner, 2026-10-25)", async () => {
  const h = harness();
  const s = snapshot();
  const far = snapshot({ theo: { x: 100, y: 64, z: 0 } });
  await h.c.onDecision(decision({ first: "me" }), "Theo", s);
  await h.c.handoffEnded(theirTrade(h).id, "failed", "cannot reach Theo");
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.handoffs.length, 2, "the retake with the partner near");
  h.c.handoffDropped(theirTrade(h).id);
  h.state.now += 31_000;
  await h.c.tick(far, new Set(), signal);
  assert.equal(h.handoffs.length, 2, "a stop does not lift the partner-near condition of a failed give");
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.handoffs.length, 3);
  assert.equal(theirTrade(h).state, "agreed", "the stop is no failure: the trade stays due");
});

test("S1: after part of a hand-off was taken the trade line says what was given and what is left", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "me" }), "Theo", snapshot());
  await h.c.tookInHandoff(theirTrade(h).id, bread(3));
  assert.ok(h.c.block(["Theo"], []).includes("you gave 3 bread of your 5 bread, 2 bread still to give"), h.c.block(["Theo"], []));
});

test("S4: a give that failed with the partner away says it is tried again when they are near", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "them" }), "Theo", snapshot());
  await h.c.tick(snapshot(), new Set(), signal);
  await h.c.tick(snapshot({ inventory: [{ name: "bread", count: 10 }, { name: "iron_ingot", count: 5 }] }), new Set(), signal);
  assert.equal(theirTrade(h).state, "they_gave");
  await h.c.handoffEnded(theirTrade(h).id, "failed", "cannot reach Theo");
  await h.c.tick(snapshot({ theo: { x: 20, y: 64, z: 0 } }), new Set(), signal);
  assert.ok(h.c.block(["Theo"], []).includes("tried again when Theo is within"), h.c.block(["Theo"], []));
});

test("S4: a refused give with the partner away says it waits for the partner within 30 s, a dropped one with no failure says interrupted", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "them" }), "Theo", snapshot());
  await h.c.tick(snapshot(), new Set(), signal);
  await h.c.tick(snapshot({ inventory: [{ name: "bread", count: 10 }, { name: "iron_ingot", count: 5 }] }), new Set(), signal);
  await h.c.handoffEnded(theirTrade(h).id, "not_taken", "left at the feet");
  await h.c.tick(snapshot({ theo: { x: 20, y: 64, z: 0 } }), new Set(), signal);
  assert.ok(h.c.block(["Theo"], []).includes("tried again when Theo is within"), h.c.block(["Theo"], []));
  const other = harness();
  await other.c.onDecision(decision({ first: "them" }), "Theo", snapshot());
  await other.c.tick(snapshot(), new Set(), signal);
  await other.c.tick(snapshot({ inventory: [{ name: "bread", count: 10 }, { name: "iron_ingot", count: 5 }] }), new Set(), signal);
  other.c.handoffDropped(theirTrade(other).id);
  assert.ok(other.c.block(["Theo"], []).includes("the hand-over was interrupted"), other.c.block(["Theo"], []));
});

test("S9: while the retry give runs the line says it is handed over, not that it waits for the partner", async () => {
  const h = harness();
  const near = snapshot({ inventory: [{ name: "bread", count: 10 }, { name: "iron_ingot", count: 5 }] });
  await h.c.onDecision(decision({ first: "them" }), "Theo", snapshot());
  await h.c.tick(snapshot(), new Set(), signal);
  await h.c.tick(near, new Set(), signal);
  await h.c.handoffEnded(theirTrade(h).id, "failed", "cannot reach Theo");
  await h.c.tick(near, new Set(), signal);
  assert.equal(h.handoffs.length, 2, "the retry give is taken with the partner near");
  await h.c.tick({ ...near, players: [{ username: "Theo", position: { x: 20, y: 64, z: 0 } }] }, new Set(), signal);
  assert.ok(h.c.block(["Theo"], []).includes("(it is handed over for you)"), h.c.block(["Theo"], []));
  assert.ok(!h.c.block(["Theo"], []).includes("tried again when"));
  h.c.handoffDropped(theirTrade(h).id);
  assert.ok(h.c.block(["Theo"], []).includes("tried again when Theo is within"), "the give no longer runs: it waits for the partner again");
});

test("a trade ended outside a conversation makes no model call", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "me" }), "Theo", s);
  await h.c.handoffEnded(theirTrade(h).id, "done", "gave");
  await h.c.tick(s, new Set(), signal);
  h.state.now += 11 * MIN;
  await h.c.tick(s, new Set(), signal);
  await h.c.settled();
  assert.equal(h.chat.requests.length, 0);
});

test("gist nudge scores the partner", async () => {
  const h = harness();
  await h.c.onConversationEnded([{ name: "Theo", nudge: { value: -6, why: "he was rude" }, has: ["iron_ingot"], needs: ["bread"] }]);
  const r = h.book.get("Theo")!;
  assert.equal(r.score, -6);
  assert.deepEqual(r.ledger.map((e) => [e.kind, e.delta, e.why]), [["nudge", -6, "he was rude"]]);
  assert.deepEqual(r.saidHas.map((x) => x.item), ["iron_ingot"]);
  assert.deepEqual(h.events, [{ kind: "relation", event: "scored", partner: "Theo", scoreKind: "nudge", delta: -6, score: -6, why: "he was rude" }]);
});

test("bad nudge keeps the gist and moves nothing", async () => {
  const h = harness();
  await h.c.onConversationEnded([{ name: "Theo", nudge: null, has: ["iron_ingot"], needs: [] }, { name: "Bruno", nudge: null, has: [], needs: [] }]);
  const r = h.book.get("Theo")!;
  assert.deepEqual([r.score, r.ledger.length], [0, 0]);
  assert.deepEqual(r.saidHas.map((x) => x.item), ["iron_ingot"]);
  assert.equal(h.book.get("Bruno"), null, "nothing said, nothing scored: no record");
  assert.deepEqual(h.events, []);
});

test("owing does not block work: nothing is handed off before the agreement says so, and the tick is quick", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ action: "propose", first: "me" }), "Theo", s);
  await h.c.onDecision(decision({ action: "propose", first: "them", give: bread(1) }), "Bruno", s);
  await h.c.onDecision(decision({ action: "accept", first: "them", give: bread(1), get: ingots(1) }), "Bruno", s);
  const started = Date.now();
  await h.c.tick(s, new Set(), signal);
  assert.ok(Date.now() - started < 100);
  assert.deepEqual(h.handoffs, []);
});

test("propose, decline and cancel move a trade through its states", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ action: "propose" }), "Theo", s);
  assert.equal(theirTrade(h).state, "proposed");
  await h.c.onDecision(decision({ action: "decline", give: [], get: [] }), "Theo", s);
  assert.equal(theirTrade(h).state, "cancelled");
  assert.equal(h.book.get("Theo")!.facts.promisesBroken, 0);
  await h.c.onDecision(decision({ action: "cancel", give: [], get: [] }), "Bruno", s);
  assert.equal(h.book.get("Bruno"), null, "cancelling nothing records nothing");
});

test("block carries the records, nobody-gave and what the objective lacks", async () => {
  const h = harness();
  const s = snapshot();
  h.book.load([newRelation("Theo", t0, 0)]);
  await h.c.onDecision(decision({ first: "them" }), "Theo", s);
  h.state.now += 3 * MIN;
  await h.c.tick(s, new Set(), signal);
  const block = h.c.block(["Theo", "Zed"], ["iron_ingot x3"]);
  assert.match(block, /You and Theo/u);
  assert.match(block, /not dealt with Zed/u);
  assert.match(block, /Nobody has given yet.*Theo/u);
  assert.match(block, /lacks: iron_ingot x3/u);
});

test("onDecision answers the trade id it recorded, and null when it recorded none", async () => {
  const h = harness();
  const s = snapshot();
  const proposed = await h.c.onDecision(decision({ action: "propose" }), "Theo", s);
  assert.equal(proposed, theirTrade(h).id);
  const agreed = await h.c.onDecision(decision({ action: "accept" }), "Theo", s);
  assert.equal(agreed, proposed, "the accepted proposal keeps its id");
  assert.equal(await h.c.onDecision(decision({ action: "propose" }), "Theo", s), null, "a proposal while an agreed trade is open is ignored");
  assert.equal(await h.c.onDecision(decision({ action: "decline", give: [], get: [] }), "Theo", s), null);
  assert.equal(await h.c.onDecision(decision({ action: "cancel", give: [], get: [] }), "Zed", s), null, "nothing open to cancel");
});

test("give outside a hand-off marks gave", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "me" }), "Theo", snapshot());
  await h.c.gaveOutside("Theo", "bread", 5);
  assert.equal(theirTrade(h).state, "i_gave");
  assert.equal(theirTrade(h).gaveAt, h.state.now);
  const gave = h.events.filter((e) => e.kind === "trade" && e.event === "gave");
  assert.equal(gave.length, 1);
  assert.match(String((gave[0] as TradeEvent).note), /gave 5 bread to Theo, outside the hand-off/u);
});

test("outside give on they_gave ends done", async () => {
  const h = harness();
  const before = snapshot();
  await h.c.onDecision(decision({ first: "them" }), "Theo", before);
  await h.c.tick(before, new Set(), signal);
  h.state.now += 1_000;
  await h.c.tick(snapshot({ inventory: [...before.inventory, { name: "iron_ingot", count: 5 }] }), new Set(), signal);
  assert.equal(theirTrade(h).state, "they_gave");
  await h.c.gaveOutside("Theo", "bread", 5);
  assert.equal(theirTrade(h).state, "done");
  assert.equal(h.events.at(-1)?.kind === "trade" && h.events.at(-1)?.event, "done");
});

test("partial outside give, the hand-off gives the rest", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "me" }), "Theo", snapshot());
  const id = theirTrade(h).id;
  await h.c.gaveOutside("Theo", "bread", 2);
  assert.equal(theirTrade(h).state, "agreed");
  assert.deepEqual(h.c.leftToGive(id), bread(3));
  await h.c.gaveOutside("Theo", "bread", 3);
  assert.equal(theirTrade(h).state, "i_gave");
  assert.equal(h.c.leftToGive(id), null, "my side was given");
});

test("S3: gives credited to a proposal that is declined go back to the ledger for the next one", async () => {
  const h = harness();
  const s = snapshot();
  const propose = (count: number) => h.c.onDecision(decision({ action: "propose", give: bread(count) }), "Theo", s);
  await h.c.gaveOutside("Theo", "bread", 4);
  await propose(4);
  assert.deepEqual(h.c.leftToGive(theirTrade(h).id), [], "the earlier give covered the first proposal");
  await h.c.onDecision(decision({ action: "decline", give: [], get: [] }), "Theo", s);
  assert.equal(theirTrade(h).state, "cancelled");
  h.state.now += 1_000;
  await propose(4);
  assert.deepEqual(h.c.leftToGive(theirTrade(h).id), [], "and the second one: the 4 bread went back");
});

test("S3: a proposal that expires 'no answer' gives the ledger's gives back too", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.gaveOutside("Theo", "bread", 4);
  await h.c.onDecision(decision({ action: "propose", give: bread(4) }), "Theo", s);
  h.state.now += 3 * MIN;
  await h.c.tick(s, new Set(), signal);
  assert.match(theirTrade(h).note, /no answer/u);
  await h.c.onDecision(decision({ action: "propose", give: bread(4) }), "Theo", s);
  assert.deepEqual(h.c.leftToGive(theirTrade(h).id), []);
});

test("S3: an agreed trade cancelled keeps nothing in the ledger", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "me" }), "Theo", s);
  await h.c.gaveOutside("Theo", "bread", 2);
  await h.c.onDecision(decision({ action: "cancel", give: [], get: [] }), "Theo", s);
  assert.equal(theirTrade(h).state, "cancelled");
  h.state.now += 1_000;
  await h.c.onDecision(decision({ action: "propose" }), "Theo", s);
  assert.deepEqual(h.c.leftToGive(theirTrade(h).id), bread(5), "nothing went back");
});

test("outside give to another partner is not counted", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "me" }), "Theo", snapshot());
  await h.c.gaveOutside("Zed", "bread", 5);
  assert.equal(theirTrade(h).state, "agreed");
  assert.deepEqual(h.c.leftToGive(theirTrade(h).id), bread(5));
});

test("outside give of another item is not counted", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "me" }), "Theo", snapshot());
  await h.c.gaveOutside("Theo", "oak_log", 5);
  assert.equal(theirTrade(h).state, "agreed");
  assert.deepEqual(h.c.leftToGive(theirTrade(h).id), bread(5));
  assert.ok(h.logs.some((l) => /outside/u.test(l)), "one log line says it was not counted");
});

test("outside give before agreement is not counted", async () => {
  const h = harness();
  await h.c.onDecision(decision({ action: "propose" }), "Theo", snapshot());
  await h.c.gaveOutside("Theo", "bread", 5);
  assert.equal(theirTrade(h).state, "proposed");
  assert.equal(theirTrade(h).gaveAt, null);
});

test("outside give after gave is not counted", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "me" }), "Theo", snapshot());
  await h.c.handoffEnded(theirTrade(h).id, "done", "gave");
  const gaveAt = theirTrade(h).gaveAt;
  const rows = h.events.length;
  h.state.now += 1_000;
  await h.c.gaveOutside("Theo", "bread", 5);
  assert.equal(theirTrade(h).gaveAt, gaveAt);
  assert.equal(h.events.length, rows, "no second gave row");
});

test("outside give capped at the side", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "me" }), "Theo", snapshot());
  await h.c.gaveOutside("Theo", "bread", 9);
  assert.equal(theirTrade(h).state, "i_gave");
  assert.equal(h.c.leftToGive(theirTrade(h).id), null);
  assert.deepEqual(theirTrade(h).give, bread(5), "the deal is not changed");
});

test("handoffSkipped forgets the pending hand-off so the trade is not given twice", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "me" }), "Theo", snapshot());
  const id = theirTrade(h).id;
  await h.c.gaveOutside("Theo", "bread", 5);
  h.c.handoffSkipped(id);
  await h.c.tick(snapshot(), new Set(), signal);
  assert.equal(h.handoffs.length, 1, "no second give hand-off");
});

test("latestWith: the newest trade with that partner since a time, any case, no other partner", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ action: "propose", give: bread(1) }), "Bruno", s);
  await h.c.onDecision(decision({ action: "propose", give: bread(2) }), "Theo", s);
  h.state.now += MIN;
  await h.c.onDecision(decision({ action: "decline", give: [], get: [] }), "Theo", s);
  h.state.now += MIN;
  await h.c.onDecision(decision({ action: "propose", give: bread(3) }), "Theo", s);
  assert.deepEqual(h.c.latestWith("THEO", 0)?.give, bread(3), "the newest of two");
  assert.equal(h.c.latestWith("theo", h.state.now + 1), null, "none proposed since then");
  assert.deepEqual(h.c.latestWith("bruno", 0)?.give, bread(1), "another partner's trade is its own");
  assert.equal(h.c.latestWith("Zed", 0), null);
  assert.equal(h.book.trades().length, 3, "a read writes nothing");
});

const withIron = (s: BotSnapshot, count: number): BotSnapshot => ({ ...s, inventory: [...s.inventory, { name: "iron_ingot", count }] });

async function agreedThemFirst(h: Harness, near: BotSnapshot): Promise<void> {
  await h.c.onDecision(decision({ give: [], get: ingots(5), first: "them" }), "Theo", near);
  await h.c.tick(near, new Set(), signal);
}

test("a payment picked up 12 s after the partner was near, out of sight since, is credited (stage 1c)", async () => {
  const h = harness();
  const near = snapshot({ theo: { x: 3, y: 64, z: 0 } });
  await agreedThemFirst(h, near);
  h.state.now += 2_000;
  await h.c.tick(near, new Set(), signal);
  h.state.now += 1_000;
  const gone = snapshot({ theo: "absent" });
  await h.c.tick(gone, new Set(), signal);
  h.state.now += 9_000;
  await h.c.tick(withIron(gone, 5), new Set(), signal);
  assert.equal(theirTrade(h).state, "done");
  assert.deepEqual(theirTrade(h).received, ingots(5));
});

test("a payment picked up 31 s after the partner was last near is not credited", async () => {
  const h = harness();
  const near = snapshot({ theo: { x: 3, y: 64, z: 0 } });
  await agreedThemFirst(h, near);
  h.state.now += 1_000;
  const gone = snapshot({ theo: "absent" });
  await h.c.tick(gone, new Set(), signal);
  h.state.now += 31_000;
  await h.c.tick(withIron(gone, 5), new Set(), signal);
  assert.equal(theirTrade(h).state, "agreed");
  assert.deepEqual(theirTrade(h).received, []);
});

test("a recently near partner's payment is not credited while my own step yields the item", async () => {
  const h = harness();
  const near = snapshot({ theo: { x: 3, y: 64, z: 0 } });
  await agreedThemFirst(h, near);
  h.state.now += 1_000;
  const gone = snapshot({ theo: "absent" });
  await h.c.tick(gone, new Set(), signal);
  h.state.now += 1_000;
  await h.c.tick(withIron(gone, 5), new Set(["iron_ingot"]), signal);
  assert.equal(theirTrade(h).state, "agreed");
});

test("a player who was never within hand-off distance is never remembered as near", async () => {
  const h = harness();
  const far = snapshot({ theo: { x: 50, y: 64, z: 0 } });
  await agreedThemFirst(h, far);
  h.state.now += 1_000;
  const gone = snapshot({ theo: "absent" });
  await h.c.tick(gone, new Set(), signal);
  h.state.now += 1_000;
  await h.c.tick(withIron(gone, 5), new Set(), signal);
  assert.equal(theirTrade(h).state, "agreed");
});

test("agreed with them first: one await hand-off is taken, a second tick takes none", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "them" }), "Theo", s);
  assert.deepEqual(h.awaits, [], "not at the decision: the next tick");
  await h.c.tick(s, new Set(), signal);
  await h.c.tick(s, new Set(), signal);
  assert.deepEqual(h.awaits, [{ kind: "await", tradeId: theirTrade(h).id, partner: "Theo" }]);
  assert.deepEqual(h.handoffs, [], "the wait is not a give or a collect");
  assert.equal(h.c.awaits(theirTrade(h).id), true);
});

test("agreed with me first: no await, the give is due at once", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "me" }), "Theo", s);
  await h.c.tick(s, new Set(), signal);
  assert.deepEqual(h.awaits, []);
  assert.deepEqual(kinds(h), ["give"]);
});

test("a trade that owes nothing is not awaited", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ give: bread(5), get: [], first: "them" }), "Theo", s);
  await h.c.tick(s, new Set(), signal);
  assert.deepEqual(h.awaits, []);
});

test("the payment credited while waiting ends the wait, then the give comes due and is taken", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "them" }), "Theo", s);
  await h.c.tick(s, new Set(), signal);
  const id = theirTrade(h).id;
  h.state.now += 1_000;
  await h.c.tick(withIron(s, 3), new Set(), signal);
  assert.equal(h.c.awaits(id), false, "a part payment ends the wait: the trade is no longer unpaid");
  h.state.now += 1_000;
  await h.c.tick(withIron(s, 5), new Set(), signal);
  assert.equal(h.c.awaits(id), false);
  assert.equal(theirTrade(h).state, "they_gave");
  assert.deepEqual(kinds(h), ["give"], "the give goes on top of the wait");
  assert.equal(h.awaits.length, 1);
});

test("awaits is false for a trade that is gone, cancelled or unknown", async () => {
  const h = harness();
  const s = snapshot();
  assert.equal(h.c.awaits("nope"), false);
  await h.c.onDecision(decision({ first: "them" }), "Theo", s);
  assert.equal(h.c.awaits(theirTrade(h).id), true);
  await h.c.onDecision(decision({ action: "cancel" }), "Theo", s);
  assert.equal(h.c.awaits(theirTrade(h).id), false);
});

test("a collect watch firing during the wait goes on top of it", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "them" }), "Theo", s);
  await h.c.tick(s, new Set(), signal);
  h.c.heardLine("Theo", h.state.now, 2);
  h.state.now += 6_000;
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.awaits.length, 1);
  assert.deepEqual(kinds(h), ["collect"]);
  assert.equal(h.c.awaits(theirTrade(h).id), true, "still waiting once the collect is over");
});

test("a stopped wait is dropped: the trade stays open and the await is taken again after 30 s, not at once", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "them" }), "Theo", s);
  await h.c.tick(s, new Set(), signal);
  const id = theirTrade(h).id;
  h.c.reconcileHandoffs(new Set());
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.awaits.length, 1, "not at once after a stop");
  h.state.now += 31_000;
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.awaits.length, 2);
  assert.equal(theirTrade(h).id, id);
  assert.equal(theirTrade(h).state, "agreed");
});

test("a wait that is still on the stack is not dropped by the reconcile; one dropped through its own end is", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "them" }), "Theo", s);
  await h.c.tick(s, new Set(), signal);
  const id = theirTrade(h).id;
  h.c.reconcileHandoffs(new Set([`await:${id}`]));
  h.state.now += 31_000;
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.awaits.length, 1);
  h.c.awaitEnded(id, "dropped");
  h.state.now += 31_000;
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.awaits.length, 2);
});

test("a wait that ended failed on its bound is not taken again; the trade is cancelled at the pay-back deadline", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "them" }), "Theo", s);
  await h.c.tick(s, new Set(), signal);
  const id = theirTrade(h).id;
  h.c.awaitEnded(id, "failed");
  h.state.now += 4 * MIN;
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.awaits.length, 1, "no second wait");
  assert.equal(h.c.awaits(id), true, "the trade still owes");
  h.state.now += 7 * MIN;
  await h.c.tick(s, new Set(), signal);
  assert.equal(theirTrade(h).state, "cancelled");
  assert.equal(h.c.awaits(id), false);
  assert.deepEqual(kinds(h), [], "no give either");
});

const empty = (): BotSnapshot => snapshot({ inventory: [] });

test("a hand-off's taken part counts toward my side: the rest stays due (F6)", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "me" }), "Theo", snapshot());
  const id = theirTrade(h).id;
  await h.c.tookInHandoff(id, bread(2));
  assert.deepEqual(h.c.leftToGive(id), bread(3));
  assert.equal(theirTrade(h).gaveAt, null, "not given until the hand-off ends done");
});

test("a give the partner took before my proposal, inside the window, is credited: agreed means gave at once, with no hand-off (s1d, bug B)", async () => {
  const h = harness();
  await h.c.gaveOutside("Theo", "bread", 5);
  h.state.now += 5 * MIN;
  await h.c.onDecision(decision({ action: "propose", first: "me" }), "Theo", empty());
  assert.equal(theirTrade(h).state, "proposed");
  await h.c.onDecision(decision({ first: "me" }), "Theo", empty());
  assert.equal(theirTrade(h).state, "i_gave");
  assert.deepEqual(h.handoffs, [], "nothing left to hand over");
});

test("a give 11 minutes before the proposal is a gift: not credited", async () => {
  const h = harness();
  await h.c.gaveOutside("Theo", "bread", 5);
  h.state.now += 11 * MIN;
  await h.c.onDecision(decision({ first: "me" }), "Theo", snapshot());
  assert.equal(theirTrade(h).state, "agreed");
  assert.deepEqual(h.c.leftToGive(theirTrade(h).id), bread(5));
  assert.deepEqual(kinds(h), ["give"]);
});

test("an earlier give of more than the side is credited up to the side", async () => {
  const h = harness();
  await h.c.gaveOutside("Theo", "bread", 9);
  await h.c.onDecision(decision({ first: "me" }), "Theo", empty());
  assert.equal(theirTrade(h).state, "i_gave");
  assert.deepEqual(theirTrade(h).give, bread(5));
});

test("an earlier give is consumed by the first trade: a second trade with the partner is not credited by it", async () => {
  const h = harness();
  await h.c.gaveOutside("Theo", "bread", 5);
  await h.c.onDecision(decision({ first: "me" }), "Theo", empty());
  await h.c.onDecision(decision({ action: "cancel", give: [], get: [] }), "Theo", empty());
  await h.c.onDecision(decision({ first: "me" }), "Theo", snapshot());
  assert.equal(theirTrade(h).state, "agreed", "the same items are not credited twice");
});

test("a give while my trade is proposed is credited and the trade stays proposed; accepting it is gave at once (s1d, bug B)", async () => {
  const h = harness();
  await h.c.onDecision(decision({ action: "propose", first: "me" }), "Theo", snapshot());
  await h.c.gaveOutside("Theo", "bread", 5);
  assert.equal(theirTrade(h).state, "proposed");
  assert.equal(h.c.checkDecision(decision({ first: "me" }), "Theo", empty()), null, "the carry check counts the credited give as carried");
  await h.c.onDecision(decision({ first: "me" }), "Theo", empty());
  assert.equal(theirTrade(h).state, "i_gave");
  assert.deepEqual(h.handoffs, []);
});

test("a proposed trade that is declined drops its credit: the items were a gift for a later trade", async () => {
  const h = harness();
  await h.c.onDecision(decision({ action: "propose", first: "me" }), "Theo", snapshot());
  await h.c.gaveOutside("Theo", "bread", 5);
  await h.c.onDecision(decision({ action: "decline", give: [], get: [] }), "Theo", snapshot());
  assert.match(h.c.checkDecision(decision({ first: "me" }), "Theo", empty()) ?? "", /carry 0 bread/u, "no credit left to count as carried");
  await h.c.onDecision(decision({ first: "me" }), "Theo", snapshot());
  assert.equal(theirTrade(h).state, "agreed");
  assert.deepEqual(h.c.leftToGive(theirTrade(h).id), bread(5));
});

test("two open trades with one partner: the oldest is credited first", async () => {
  const h = harness();
  const mk = (id: string, createdAt: number): Trade => ({ ...proposeTrade({ self: "Ayla", partner: "Theo", give: bread(5), get: ingots(5), first: "me", now: createdAt }), id });
  await h.book.update("Theo", (r) => withTrade(withTrade(r, mk("t-new", t0 + 10)), mk("t-old", t0)));
  await h.c.gaveOutside("Theo", "bread", 5);
  assert.deepEqual(h.c.leftToGive("t-old"), [], "the oldest took it");
  assert.deepEqual(h.c.leftToGive("t-new"), bread(5));
});

test("an agreed trade whose side was given before is gave at once and done when their side arrives", async () => {
  const h = harness();
  await h.c.gaveOutside("Theo", "bread", 5);
  const before = empty();
  await h.c.onDecision(decision({ first: "them" }), "Theo", before);
  assert.equal(theirTrade(h).state, "i_gave");
  assert.deepEqual(h.handoffs, []);
  await h.c.tick(before, new Set(), signal);
  h.state.now += 1_000;
  await h.c.tick(withIron(before, 5), new Set(), signal);
  assert.equal(theirTrade(h).state, "done");
});

/** A trade with Theo run to `done`: they pay first, I give. Leaves the clock at its end. */
async function runToDone(h: Harness): Promise<Trade> {
  const before = snapshot();
  await h.c.onDecision(decision({ first: "them" }), "Theo", before);
  await h.c.tick(before, new Set(), signal);
  h.state.now += 1_000;
  await h.c.tick(snapshot({ inventory: [...before.inventory, { name: "iron_ingot", count: 5 }] }), new Set(), signal);
  await h.c.handoffEnded(theirTrade(h).id, "done", "gave");
  assert.equal(theirTrade(h).state, "done");
  return theirTrade(h);
}
const tradesWithTheo = (h: Harness): number => h.book.get("Theo")!.trades.length;

test("sameDealTerms: the same items and counts in any order, the first-to-give ignored", () => {
  const two = [{ item: "bread", count: 2 }, { item: "oak_log", count: 1 }];
  const swapped = [{ item: "oak_log", count: 1 }, { item: "bread", count: 2 }];
  assert.equal(sameDealTerms({ give: two, get: ingots(1) }, { give: swapped, get: ingots(1) }), true);
  assert.equal(sameDealTerms({ give: two, get: ingots(1) }, { give: two, get: ingots(2) }), false);
  assert.equal(sameDealTerms({ give: bread(1), get: ingots(1) }, { give: ingots(1), get: bread(1) }), false, "the sides are not exchangeable");
});

test("F9: an accept of a partner outside the brain, 3 s after the same trade was done, makes no trade and gives nothing", async () => {
  const h = harness();
  await runToDone(h);
  const handoffsBefore = h.handoffs.length;
  h.state.now += 3_000;
  assert.equal(await h.c.onDecision(decision({ first: "them" }), "Theo", snapshot()), null);
  assert.equal(tradesWithTheo(h), 1);
  assert.equal(h.handoffs.length, handoffsBefore, "no give taken");
  assert.ok(h.logs.some((l) => /a accept of Theo ignored, it repeats Ayla-Theo-\d+, done 3 s ago/u.test(l)), h.logs.join("\n"));
});

test("F9: a propose with the same terms just after done is ignored too", async () => {
  const h = harness();
  await runToDone(h);
  h.state.now += 1_000;
  assert.equal(await h.c.onDecision(decision({ action: "propose" }), "Theo", snapshot()), null);
  assert.equal(tradesWithTheo(h), 1);
  assert.ok(h.logs.some((l) => /a propose of Theo ignored, it repeats/u.test(l)));
});

test("F9: the same terms 2 min 1 s after done are a new trade", async () => {
  const h = harness();
  await runToDone(h);
  h.state.now += 2 * MIN + 1_000;
  assert.notEqual(await h.c.onDecision(decision({ first: "them" }), "Theo", snapshot()), null);
  assert.equal(tradesWithTheo(h), 2);
});

test("F9: the same terms 2 min after done are still a repeat", async () => {
  const h = harness();
  await runToDone(h);
  h.state.now += 2 * MIN;
  assert.equal(await h.c.onDecision(decision({ first: "them" }), "Theo", snapshot()), null);
});

test("F9: other terms just after done are a new deal said in words: agreed as before", async () => {
  const h = harness();
  await runToDone(h);
  h.state.now += 1_000;
  assert.notEqual(await h.c.onDecision(decision({ give: bread(3), first: "them" }), "Theo", snapshot()), null);
  assert.equal(tradesWithTheo(h), 2);
});

test("F9: a trade cancelled or broken with the same terms just before is no repeat", async () => {
  const h = harness();
  await h.c.onDecision(decision({ action: "propose" }), "Theo", snapshot());
  await h.c.onDecision(decision({ action: "decline", give: [], get: [] }), "Theo", snapshot());
  assert.equal(theirTrade(h).state, "cancelled");
  h.state.now += 1_000;
  assert.notEqual(await h.c.onDecision(decision({ first: "them" }), "Theo", snapshot()), null);
  assert.equal(tradesWithTheo(h), 2);
});

test("F9: a proposal while a trade is still open answers the old 'still open' line, not the repeat line", async () => {
  const h = harness();
  await runToDone(h);
  h.state.now += 1_000;
  await h.c.onDecision(decision({ give: bread(2), first: "them" }), "Theo", snapshot());
  h.logs.length = 0;
  await h.c.onDecision(decision({ action: "propose" }), "Theo", snapshot());
  assert.ok(h.logs.some((l) => /still open/u.test(l)));
  assert.ok(!h.logs.some((l) => /it repeats/u.test(l)));
});

test("F9 agreedSince: the newest trade with anyone created at or after the time and agreed or further; proposed, cancelled, broken and older ones do not count", async () => {
  const h = harness();
  assert.equal(h.c.agreedSince(t0), null, "no trade");
  await h.c.onDecision(decision({ action: "propose" }), "Theo", snapshot());
  assert.equal(h.c.agreedSince(t0), null, "proposed only");
  await h.c.onDecision(decision({ action: "decline", give: [], get: [] }), "Theo", snapshot());
  assert.equal(h.c.agreedSince(t0), null, "cancelled");
  h.state.now += 1_000;
  await h.c.onDecision(decision({ first: "them", give: bread(2) }), "Bruno", snapshot());
  assert.equal(h.c.agreedSince(t0)?.partner, "Bruno", "agreed with a partner the plan would not pick");
  assert.equal(h.c.agreedSince(h.state.now + 1), null, "agreed before the objective started: does not count");
  const agreed = h.book.get("Bruno")!.trades.at(-1)!;
  await h.book.update("Bruno", (r) => withTrade(r, { ...agreed, state: "broken", brokenBy: "them", endedAt: h.state.now }));
  assert.equal(h.c.agreedSince(t0), null, "agreed, then broken before the resume");
  await h.book.update("Bruno", (r) => withTrade(r, { ...agreed, state: "done", endedAt: h.state.now }));
  assert.equal(h.c.agreedSince(t0)?.state, "done");
});

test("F10: an accept from a partner who walked out of reach is refused; my proposal stays proposed and is cancelled 'no answer' by the timer", async () => {
  const h = harness();
  await h.c.onDecision(decision({ action: "propose" }), "Theo", snapshot());
  const away = snapshot({ theo: { x: 100, y: 64, z: 0 } });
  assert.match(h.c.checkDecision(decision({ action: "accept" }), "Theo", away) ?? "", /Theo is too far away to trade with \(100 blocks away\)/u);
  assert.equal(theirTrade(h).state, "proposed");
  h.state.now += 3 * MIN;
  await h.c.tick(away, new Set(), signal);
  assert.equal(theirTrade(h).state, "cancelled");
  assert.match(theirTrade(h).note, /no answer/u);
});

test("F10: the reach comes from the settings: a partner 50 blocks away passes with tradeReach 64, a decline passes at any distance", () => {
  const h = harness({ settings: { tradeReach: 64 } });
  const far = snapshot({ theo: { x: 50, y: 64, z: 0 } });
  assert.equal(h.c.checkDecision(decision({ action: "propose" }), "Theo", far), null);
  assert.match(harness().c.checkDecision(decision({ action: "propose" }), "Theo", far) ?? "", /too far away/u);
  assert.equal(harness().c.checkDecision(decision({ action: "decline", give: [], get: [] }), "Theo", far), null);
});

test("D1: a give the partner does not take twice ends broken by me, naming the items; the retake waits 30 s and the partner near", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "me" }), "Theo", s);
  const id = theirTrade(h).id;
  await h.c.handoffEnded(id, "not_taken", "Theo did not take 5 bread");
  assert.equal(theirTrade(h).state, "agreed", "one try is not the end");
  h.state.now += 31_000;
  await h.c.tick(snapshot({ theo: { x: 100, y: 64, z: 0 } }), new Set(), signal);
  assert.equal(h.handoffs.length, 1, "30 s passed but the partner is far");
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.handoffs.length, 2, "30 s passed and the partner is near");
  await h.c.handoffEnded(id, "not_taken", "Theo did not take 5 bread");
  assert.equal(theirTrade(h).state, "broken");
  assert.equal(theirTrade(h).brokenBy, "me");
  assert.equal(theirTrade(h).note, "Theo did not take 5 bread (2 tries); I kept them");
  assert.equal(h.book.get("Theo")!.facts.iFailedToPay, 1);
  h.state.now += 10 * MIN;
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.handoffs.length, 2, "an ended trade is never retaken");
});

test("D1: after the first not_taken the retake waits 30 s even with the partner near", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "me" }), "Theo", s);
  await h.c.handoffEnded(theirTrade(h).id, "not_taken", "Theo did not take 5 bread");
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.handoffs.length, 1, "not at once");
});

test("D1: a dropped give (a stop) does not count toward the attempts", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "me" }), "Theo", s);
  for (let i = 0; i < 3; i += 1) {
    h.c.handoffDropped(theirTrade(h).id);
    h.state.now += 31_000;
    await h.c.tick(s, new Set(), signal);
  }
  assert.equal(theirTrade(h).state, "agreed");
  assert.equal(h.handoffs.length, 4);
});

test("a payment tossed before the agreement is received at agreement and my give comes due (stage 3e)", async () => {
  const h = harness();
  h.c.heardLine("Theo", h.state.now, 2);
  await h.c.tick(snapshot(), new Set(), signal);
  h.state.now += 5_000;
  await h.c.tick(withIron(snapshot(), 5), new Set(), signal);
  await h.c.onDecision(decision({ first: "them" }), "Theo", withIron(snapshot(), 5));
  assert.deepEqual(h.events.filter((e) => e.kind === "trade").map((e) => e.event), ["agreed", "received"]);
  assert.equal(theirTrade(h).state, "they_gave");
  h.state.now += 1_000;
  await h.c.tick(withIron(snapshot(), 5), new Set(), signal);
  assert.deepEqual(kinds(h), ["give"], "the give is handed over from the new end state");
});

test("stage 3e: a payment carried 80 s before the agreement with the partner 3 blocks away is received at agreement", async () => {
  const h = harness();
  const near = { theo: { x: 3, y: 64, z: 0 } } as const;
  h.c.heardLine("Theo", h.state.now, 3);
  await h.c.tick(snapshot(near), new Set(), signal);
  h.state.now += 1_000;
  await h.c.tick(withIron(snapshot(near), 5), new Set(), signal);
  for (let i = 0; i < 16; i += 1) {
    h.state.now += 5_000;
    await h.c.tick(withIron(snapshot(near), 5), new Set(), signal);
  }
  await h.c.onDecision(decision({ first: "them" }), "Theo", withIron(snapshot(near), 5));
  assert.equal(theirTrade(h).state, "they_gave");
  assert.deepEqual(theirTrade(h).received, ingots(5));
  await h.c.tick(withIron(snapshot(near), 5), new Set(), signal);
  assert.deepEqual(kinds(h), ["give"], "my give comes due and the payment is not credited twice");
});

const away = (inventory: BotSnapshot["inventory"] = snapshot().inventory) => snapshot({ theo: "absent", inventory });
const bagWith = (iron: number) => withIron(snapshot(), iron).inventory;

/** An agreed trade where Theo pays first, a collect started for it (he spoke, stands near, 5 s passed), and the ticks around it. */
async function collecting(h: Harness, get: ItemCount[] = ingots(5)): Promise<void> {
  await h.c.onDecision(decision({ first: "them", get }), "Theo", away());
  await h.c.tick(away(), new Set(), signal);
  h.c.heardLine("Theo", h.state.now, 2);
  h.state.now += 6_000;
  await h.c.tick(snapshot(), new Set(), signal);
  assert.deepEqual(kinds(h), ["collect"]);
}

/** The partner has walked off, the collect ends, and the next tick finds `iron` ingots in the bag. */
async function collectEndsWithBag(h: Harness, iron: number, yields: ReadonlySet<string> = new Set()): Promise<void> {
  h.state.now += 31_000; // the partner is no longer near, nor lately near
  await h.c.tick(away(), new Set(), signal);
  await h.c.handoffEnded(theirTrade(h).id, "failed", "[NO_ITEMS] nothing to pick up");
  h.state.now += 1_000;
  await h.c.tick(away(bagWith(iron)), yields, signal);
}

test("items walked over after the agreement are received when the collect finds nothing; my give is queued", async () => {
  const h = harness();
  await collecting(h);
  await collectEndsWithBag(h, 5);
  assert.deepEqual(theirTrade(h).received, ingots(5));
  assert.deepEqual(kinds(h), ["collect", "give"], "the give runs from the new end state");
});

test("a tick credited part, then the collect ends with nothing more in the bag: no second credit", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "them", get: ingots(16) }), "Theo", snapshot());
  await h.c.tick(snapshot(), new Set(), signal);
  h.state.now += 1_000;
  await h.c.tick(withIron(snapshot(), 8), new Set(), signal);
  assert.deepEqual(theirTrade(h).received, ingots(8));
  h.c.heardLine("Theo", h.state.now, 2);
  h.state.now += 6_000;
  await h.c.tick(withIron(snapshot(), 8), new Set(), signal);
  assert.deepEqual(kinds(h).filter((k) => k === "collect"), ["collect"]);
  await collectEndsWithBag(h, 8);
  assert.deepEqual(theirTrade(h).received, ingots(8), "the 8 in the bag were credited by the tick");
});

test("a tick credited 8 of 16, then 8 more walked over before the collect ended: paid once, 16 in all", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "them", get: ingots(16) }), "Theo", snapshot());
  await h.c.tick(snapshot(), new Set(), signal);
  h.state.now += 1_000;
  await h.c.tick(withIron(snapshot(), 8), new Set(), signal);
  h.c.heardLine("Theo", h.state.now, 2);
  h.state.now += 6_000;
  await h.c.tick(withIron(snapshot(), 8), new Set(), signal);
  await collectEndsWithBag(h, 16);
  assert.deepEqual(theirTrade(h).received, ingots(16));
});

test("a partner who tossed and walked off, no collect started: credited before the 'nobody gave' cancel", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "them" }), "Theo", away());
  await h.c.tick(away(), new Set(), signal);
  h.state.now += 10 * MIN;
  await h.c.tick(away(bagWith(5)), new Set(), signal);
  assert.equal(theirTrade(h).state, "they_gave");
  assert.deepEqual(theirTrade(h).received, ingots(5));
});

test("nothing arrived: the 'nobody gave' cancel still happens", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "them" }), "Theo", away());
  await h.c.tick(away(), new Set(), signal);
  h.state.now += 10 * MIN;
  await h.c.tick(away(), new Set(), signal);
  assert.equal(theirTrade(h).state, "cancelled");
});

test("a collect before which the items already arrived is not started", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "them" }), "Theo", away());
  await h.c.tick(away(), new Set(), signal);
  h.c.heardLine("Theo", h.state.now, 2);
  h.state.now += 30_000;
  await h.c.tick(away(), new Set(), signal);
  h.state.now += 30_000; // the partner is no longer near, nor lately near
  await h.c.tick(away(bagWith(5)), new Set(), signal);
  h.state.now += 6_000;
  await h.c.tick(withIron(snapshot(), 5), new Set(), signal);
  assert.deepEqual(theirTrade(h).received, ingots(5));
  assert.equal(kinds(h).includes("collect"), false);
});

test("the same item from my own step is not credited by the collect's end", async () => {
  const h = harness();
  await collecting(h);
  await collectEndsWithBag(h, 5, new Set(["iron_ingot"]));
  assert.deepEqual(theirTrade(h).received, []);
});

test("two trades owing the same item: the older is credited first, each only up to its own count", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "them" }), "Theo", away());
  h.state.now += 1_000;
  await h.c.onDecision(decision({ first: "them" }), "Bruno", away());
  await h.c.tick(away(), new Set(), signal);
  h.state.now += 10 * MIN;
  await h.c.tick(away(bagWith(7)), new Set(), signal);
  assert.deepEqual(theirTrade(h).received, ingots(5));
  const bruno = h.book.get("Bruno")!.trades.at(-1)!;
  assert.deepEqual(bruno.received, ingots(2));
});

test("first me: my give ran, their side arrives by walking over: received and done", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "me" }), "Theo", away());
  await h.c.tick(away(), new Set(), signal);
  await h.c.handoffEnded(theirTrade(h).id, "done", "gave");
  h.c.heardLine("Theo", h.state.now, 2);
  h.state.now += 6_000;
  await h.c.tick(snapshot(), new Set(), signal);
  await collectEndsWithBag(h, 5);
  assert.equal(theirTrade(h).state, "done");
});

test("a restart loses the baseline: a collect that ends credits nothing from an absent baseline", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "them" }), "Theo", away(bagWith(5)));
  const trade = theirTrade(h);
  // A fresh controller over the same book: the baseline map is memory only.
  const fresh = new TradeController({ self: "Ayla", persona: testPersona(), book: h.book, settings: { ...settings }, now: () => h.state.now, takeHandoff: () => {}, journal: () => {}, log: () => {} });
  await fresh.tick(away(), new Set(), signal);
  await fresh.handoffEnded(trade.id, "failed", "nothing");
  await fresh.tick(away(bagWith(5)), new Set(), signal);
  assert.deepEqual(theirTrade(h).received, []);
});

/** Only Bruno stands near, so a payment is his alone (the other players of `snapshot` stand at one distance, which keeps it for nobody). */
const onlyBruno = (inventory: BotSnapshot["inventory"] = snapshot().inventory): BotSnapshot => ({ ...snapshot({ inventory }), players: [{ username: "Bruno", position: { x: 2, y: 64, z: 0 } }] });
const receivedIron = (h: Harness, who: string): number => h.book.get(who)!.trades.at(-1)!.received.reduce((n, r) => n + r.count, 0);

test("a payment kept for another player is not also credited to my open trade", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "them" }), "Theo", onlyBruno());
  await h.c.tick(onlyBruno(), new Set(), signal);
  h.c.heardLine("Bruno", h.state.now, 2);
  h.state.now += 1_000;
  await h.c.tick(onlyBruno(bagWith(5)), new Set(), signal);
  assert.ok(h.logs.some((l) => /kept for bruno/u.test(l)));
  h.state.now += 10 * MIN - 1_000;
  await h.c.tick(onlyBruno(bagWith(5)), new Set(), signal);
  await h.c.onDecision(decision({ first: "them" }), "Bruno", onlyBruno(bagWith(5)));
  assert.equal(receivedIron(h, "Theo") + receivedIron(h, "Bruno"), 5, "5 iron in the bag are paid once");
});

test("a payment kept for another player and claimed after my baseline does not hide my own unseen payment", async () => {
  const h = harness();
  h.c.heardLine("Bruno", h.state.now, 2);
  await h.c.tick(onlyBruno(), new Set(), signal);
  h.state.now += 1_000;
  await h.c.tick(onlyBruno(bagWith(5)), new Set(), signal);
  await h.c.onDecision(decision({ first: "them" }), "Theo", onlyBruno(bagWith(5)));
  await h.c.onDecision(decision({ first: "them" }), "Bruno", onlyBruno(bagWith(5)));
  assert.equal(receivedIron(h, "Bruno"), 5);
  for (const iron of [5, 10]) {
    h.state.now += 31_000; // Bruno is no longer lately near
    await h.c.tick(away(bagWith(iron)), new Set(), signal);
  }
  h.state.now += 10 * MIN;
  await h.c.tick(away(bagWith(10)), new Set(), signal);
  assert.equal(receivedIron(h, "Theo"), 5);
});

test("part of the payment found in the bag: the collect still starts for what is left", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "them" }), "Theo", away());
  await h.c.tick(away(), new Set(), signal);
  h.c.heardLine("Theo", h.state.now, 2);
  h.state.now += 3_000;
  await h.c.tick(away(), new Set(), signal);
  h.state.now += 1_000;
  await h.c.tick(away(bagWith(3)), new Set(), signal);
  h.state.now += 6_000;
  await h.c.tick(snapshot({ inventory: bagWith(3) }), new Set(), signal);
  assert.equal(receivedIron(h, "Theo"), 3);
  assert.deepEqual(kinds(h), ["collect"], "the 2 still owed are collected");
});

test("gains of a tick that had no baseline (after forgetSeen) are not a payment", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "them" }), "Theo", away());
  await h.c.tick(away(), new Set(), signal);
  h.c.forgetSeen();
  h.state.now += 1_000;
  await h.c.tick(away(bagWith(5)), new Set(), signal);
  h.state.now += 10 * MIN;
  await h.c.tick(away(bagWith(5)), new Set(), signal);
  assert.equal(theirTrade(h).state, "cancelled");
});

test("with no player talking the tick does not run", async () => {
  const h = harness();
  assert.equal(h.c.busy(), false);
  h.c.heardLine("Theo", h.state.now, 2);
  assert.equal(h.c.busy(), true);
  h.state.now += 10 * MIN + 1;
  assert.equal(h.c.busy(), false);
});

test("an open trade owed the item is credited first, the ledger gets only the rest", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "them" }), "Theo", snapshot());
  h.c.heardLine("Theo", h.state.now, 2);
  await h.c.tick(snapshot(), new Set(), signal);
  h.state.now += 1_000;
  await h.c.tick(withIron(snapshot(), 8), new Set(), signal);
  assert.deepEqual(theirTrade(h).received, ingots(5));
  await h.c.handoffEnded(theirTrade(h).id, "done", "gave");
  assert.equal(theirTrade(h).state, "done");
  await h.c.onDecision(decision({ first: "them", get: ingots(4) }), "Theo", withIron(snapshot(), 8));
  assert.deepEqual(theirTrade(h).received, ingots(3), "only the 3 left over are credited to the next trade");
});

test("S2: a payment tossed 8 min after the player's line is still claimed by a proposal accepted at 11 min", async () => {
  const h = harness();
  h.c.heardLine("Theo", h.state.now, 2);
  await h.c.tick(snapshot(), new Set(), signal);
  h.state.now += 8 * MIN;
  await h.c.tick(withIron(snapshot(), 5), new Set(), signal);
  h.state.now += 2 * MIN + 30_000;
  await h.c.tick(withIron(snapshot(), 5), new Set(), signal);
  h.state.now += 30_000;
  const proposal = proposeTrade({ self: "Ayla", partner: "Theo", give: bread(5), get: ingots(5), first: "them", now: h.state.now });
  await h.book.update("Theo", (r) => withTrade(r, proposal));
  await h.c.offerAccepted(proposal.id, "Theo");
  assert.deepEqual(theirTrade(h).received, ingots(5));
  assert.ok(h.events.some((e) => e.kind === "trade" && e.event === "received"));
});

test("a gain my own step yields is not recorded for a talking player", async () => {
  const h = harness();
  h.c.heardLine("Theo", h.state.now, 2);
  await h.c.tick(snapshot(), new Set(), signal);
  h.state.now += 1_000;
  await h.c.tick(withIron(snapshot(), 5), new Set(["iron_ingot"]), signal);
  await h.c.onDecision(decision({ first: "them" }), "Theo", withIron(snapshot(), 5));
  assert.equal(theirTrade(h).state, "agreed");
  assert.deepEqual(theirTrade(h).received, []);
});

test("a line from a speaker beyond opening distance, or at no known distance, opens no window", () => {
  const h = harness();
  h.c.heardLine("Theo", h.state.now, 17);
  assert.equal(h.c.busy(), false);
  h.c.heardLine("Theo", h.state.now, null);
  assert.equal(h.c.busy(), false);
  h.c.heardLine("Theo", h.state.now, 16);
  assert.equal(h.c.busy(), true);
});

test("onlyWatching: a window alone is true; an open trade makes it false", async () => {
  const h = harness();
  assert.equal(h.c.onlyWatching(), false);
  h.c.heardLine("Theo", h.state.now, 2);
  assert.equal(h.c.onlyWatching(), true);
  await h.c.onDecision(decision({ first: "them" }), "Theo", snapshot());
  assert.equal(h.c.busy(), true);
  assert.equal(h.c.onlyWatching(), false);
});

test("journal order: a full trade is proposed, agreed, gave, received, done", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ action: "propose", first: "me" }), "Theo", s);
  await h.c.onDecision(decision({ action: "accept", first: "me" }), "Theo", s);
  await h.c.handoffEnded(theirTrade(h).id, "done", "gave 5 bread");
  h.state.now += 1_000;
  await h.c.tick(s, new Set(), signal);
  h.state.now += 1_000;
  await h.c.tick(snapshot({ inventory: [...s.inventory, { name: "iron_ingot", count: 5 }] }), new Set(), signal);
  assert.deepEqual(h.events.filter((e) => e.kind === "trade").map((e) => e.event), ["proposed", "agreed", "gave", "received", "done"]);
});

test("agreedSince: on equal creation times the later trade in the book wins", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ action: "accept", give: bread(2), first: "them" }), "Theo", s);
  await h.c.onDecision(decision({ action: "accept", give: bread(3), first: "them" }), "Bruno", s);
  const [first, second] = h.book.trades();
  assert.equal(first!.createdAt, second!.createdAt, "created in the same millisecond");
  assert.deepEqual(h.c.agreedSince(0)?.give, bread(3));
});

test("a give handed over keeps the note the trade already holds", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "me" }), "Theo", snapshot());
  const agreed = theirTrade(h);
  await h.book.update("Theo", (r) => withTrade(r, { ...agreed, note: "x" }));
  await h.c.handoffEnded(agreed.id, "done", "d");
  assert.equal(theirTrade(h).note, "x");
});

const withFinn = (position: Position): BotSnapshot => ({ ...snapshot(), players: [{ username: "Finn", position }] });

test("a partner named in another case than the world lists them: the retry give still comes due when they are near", async () => {
  const h = harness();
  const s = withFinn({ x: 2, y: 64, z: 0 });
  await h.c.onDecision(decision({ first: "me" }), "finn", s);
  await h.c.handoffEnded(h.book.get("finn")!.trades.at(-1)!.id, "failed", "cannot reach finn");
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.handoffs.length, 2, "the retake with the partner near");
});

test("a partner named in another case than the world lists them: the collect fallback still starts when they are near", async () => {
  const h = harness();
  const s = withFinn({ x: 2, y: 64, z: 0 });
  await h.c.onDecision(decision({ first: "them" }), "finn", s);
  await h.c.tick(s, new Set(), signal);
  h.c.heardLine("finn", h.state.now, 2);
  h.state.now += 5_000;
  await h.c.tick(s, new Set(), signal);
  assert.deepEqual(kinds(h), ["collect"]);
});

// W7 (rel-r2): a partner who pays my whole proposal has accepted it.
const propose = (h: Harness, over: Partial<TradeDecision> = {}, s: BotSnapshot = snapshot()) => h.c.onDecision(decision({ action: "propose", first: "them", ...over }), "Theo", s);
const baseline = async (h: Harness): Promise<void> => { h.c.heardLine("Theo", h.state.now, 2); await h.c.tick(snapshot(), new Set(), signal); h.state.now += 5_000; };

test("a partner who drops my whole get side agrees my proposal and I give (rel-r2)", async () => {
  const h = harness();
  await propose(h);
  await baseline(h);
  await h.c.tick(withIron(snapshot(), 5), new Set(), signal);
  assert.equal(theirTrade(h).state, "they_gave");
  assert.deepEqual(theirTrade(h).received, ingots(5));
  assert.deepEqual(h.events.filter((e) => e.kind === "trade").map((e) => e.event), ["proposed", "agreed", "received"]);
  assert.match(h.logs.join("\n"), /Theo paid my proposal .*: agreed/u);
  h.state.now += 1_000;
  await h.c.tick(withIron(snapshot(), 5), new Set(), signal);
  assert.deepEqual(kinds(h), ["give"], "my give is handed over from the new end state");
  await h.c.handoffEnded(theirTrade(h).id, "done", "gave");
  assert.equal(theirTrade(h).state, "done");
});

test("a partial payment keeps the proposal open; the rest completes it", async () => {
  const h = harness();
  await propose(h);
  await baseline(h);
  await h.c.tick(withIron(snapshot(), 2), new Set(), signal);
  assert.equal(theirTrade(h).state, "proposed");
  h.state.now += 5_000;
  await h.c.tick(withIron(snapshot(), 5), new Set(), signal);
  assert.equal(theirTrade(h).state, "they_gave");
  assert.deepEqual(theirTrade(h).received, ingots(5));
});

test("a payment after the proposal was cancelled agrees nothing", async () => {
  const h = harness();
  await propose(h);
  await h.c.onDecision(decision({ action: "cancel", give: [], get: [] }), "Theo", snapshot());
  await baseline(h);
  await h.c.tick(withIron(snapshot(), 5), new Set(), signal);
  assert.equal(theirTrade(h).state, "cancelled");
  assert.deepEqual(kinds(h), []);
});

test("gains from someone else do not agree the proposal", async () => {
  const h = harness();
  await propose(h);
  const bruno = (s: BotSnapshot): BotSnapshot => ({ ...s, players: [{ username: "Theo", position: { x: 40, y: 64, z: 0 } }, { username: "Bruno", position: { x: 2, y: 64, z: 0 } }] });
  h.c.heardLine("Bruno", h.state.now, 2);
  await h.c.tick(bruno(snapshot()), new Set(), signal);
  h.state.now += 5_000;
  await h.c.tick(bruno(withIron(snapshot(), 5)), new Set(), signal);
  assert.equal(theirTrade(h).state, "proposed");
  assert.match(h.logs.join("\n"), /kept for bruno/u, "the kept line names the player");
});

test("my own step's yield does not agree the proposal", async () => {
  const h = harness();
  await propose(h);
  await baseline(h);
  await h.c.tick(withIron(snapshot(), 5), new Set(["iron_ingot"]), signal);
  assert.equal(theirTrade(h).state, "proposed");
});

test("a gift proposal (nothing asked back) is never paid", async () => {
  const h = harness();
  await propose(h, { get: [] });
  await baseline(h);
  await h.c.tick(withIron(snapshot(), 5), new Set(), signal);
  assert.equal(theirTrade(h).state, "proposed");
});

test("paid before my proposal was recorded: the proposal is agreed as it is posted", async () => {
  const h = harness();
  await baseline(h);
  await h.c.tick(withIron(snapshot(), 5), new Set(), signal);
  h.state.now += 20_000;
  await propose(h, {}, snapshot()); // the chat snapshot was taken before the drop; the last tick saw it
  assert.equal(theirTrade(h).state, "they_gave");
  assert.deepEqual(theirTrade(h).received, ingots(5));
});

test("the payment is credited once however many ticks run after it (4 of 4, not 8)", async () => {
  const h = harness();
  await propose(h, { give: bread(5), get: [{ item: "iron_ingot", count: 4 }] });
  await baseline(h);
  for (let i = 0; i < 3; i += 1) {
    await h.c.tick(withIron(snapshot(), 4), new Set(), signal);
    h.state.now += 1_000;
  }
  assert.deepEqual(theirTrade(h).received, [{ item: "iron_ingot", count: 4 }]);
  assert.equal(h.events.filter((e) => e.kind === "trade" && e.event === "received").length, 1);
  assert.equal(h.book.get("Theo")!.trades.length, 1);
});

test("a proposal nobody paid is still cancelled as no answer", async () => {
  const h = harness();
  await propose(h);
  await baseline(h);
  h.state.now += 4 * MIN;
  await h.c.tick(snapshot(), new Set(), signal);
  assert.equal(theirTrade(h).state, "cancelled");
});

/** The payment kept in the earlier ledger: the partner talked, a tick saw nothing, the next saw 5 iron (kept for Theo), 15 s pass while the model decides. */
const keptPaymentThenSlowDecision = async (h: Harness): Promise<BotSnapshot> => {
  const chatSnapshot = snapshot(); // taken when the line was read, before the drop
  await baseline(h);
  await h.c.tick(withIron(snapshot(), 5), new Set(), signal);
  h.state.now += 15_000;
  return chatSnapshot;
};

test("a spoken accept after a payment dropped while the model thought credits the kept payment (review 2026-10-29 S1)", async () => {
  const h = harness();
  const chatSnapshot = await keptPaymentThenSlowDecision(h);
  await h.c.onDecision(decision({ first: "them" }), "Theo", chatSnapshot);
  assert.deepEqual(theirTrade(h).received, ingots(5), "the 5 iron I carry now are claimed, not the 0 of the stale chat snapshot");
  assert.equal(theirTrade(h).state, "they_gave");
  for (let i = 0; i < 3; i += 1) { h.state.now += 2_000; await h.c.tick(withIron(snapshot(), 5), new Set(), signal); }
  assert.deepEqual(theirTrade(h).received, ingots(5), "credited once, not again by the ticks after");
  assert.deepEqual(kinds(h), ["give"], "my give is handed over from the new end state");
});

test("with no tick watching, a spoken accept claims against the chat snapshot", async () => {
  const h = harness();
  await keptPaymentThenSlowDecision(h);
  h.c.forgetSeen();
  await h.c.onDecision(decision({ first: "them" }), "Theo", withIron(snapshot(), 5));
  assert.deepEqual(theirTrade(h).received, ingots(5));
});

test("a payment spent before the accept is not credited beyond what I carry now", async () => {
  const h = harness();
  const chatSnapshot = await keptPaymentThenSlowDecision(h);
  await h.c.tick(withIron(snapshot(), 2), new Set(), signal); // 3 of the 5 iron were spent since
  await h.c.onDecision(decision({ first: "them" }), "Theo", chatSnapshot);
  assert.deepEqual(theirTrade(h).received, ingots(2));
});

test("a board accept claims against the latest tick's inventory, not nothing", async () => {
  const h = harness();
  await keptPaymentThenSlowDecision(h);
  const proposal = proposeTrade({ self: "Ayla", partner: "Theo", give: bread(5), get: ingots(5), first: "them", now: h.state.now });
  await h.book.update("Theo", (r) => withTrade(r, proposal));
  await h.c.offerAccepted(proposal.id, "Theo");
  assert.deepEqual(theirTrade(h).received, ingots(5));
});

test("a tick that failed before it started, then a spoken accept: the payment is credited once and the ledger keeps nothing for Theo", async () => {
  const h = harness();
  const chatSnapshot = await keptPaymentThenSlowDecision(h);
  h.c.forgetSeen(); // the tick failed before it started: no baseline
  await h.c.onDecision(decision({ first: "them" }), "Theo", chatSnapshot);
  assert.deepEqual(theirTrade(h).received, [], "the stale chat snapshot had no iron to claim");
  h.state.now += 2_000;
  await h.c.tick(withIron(snapshot(), 5), new Set(), signal);
  assert.deepEqual(theirTrade(h).received, ingots(5), "the next tick credits the payment as a gain");
  await h.c.tick(withIron(snapshot(), 5), new Set(), signal);
  assert.deepEqual(theirTrade(h).received, ingots(5));
  await h.c.handoffEnded(theirTrade(h).id, "done", "gave");
  assert.equal(theirTrade(h).state, "done");
  h.state.now += 3 * MIN;
  await propose(h, { give: bread(4) }, withIron(snapshot(), 5));
  await h.c.tick(withIron(snapshot(), 5), new Set(), signal);
  assert.equal(theirTrade(h).state, "proposed", "the payment already credited to the first trade does not pay the next proposal");
});

const scoredRows = (h: Harness) => h.events.filter((e) => e.kind === "relation" && e.event === "scored");
const nudgeOf = (value: number, why: string) => [{ name: "Theo", nudge: { value, why }, has: [], needs: [] }];

test("a gist journals one score row per nudge that scored, and none for has/needs only or a nudge that scores nothing, though the record holds an older row", async () => {
  const h = harness();
  await h.c.onConversationEnded(nudgeOf(-6, "he was rude"));
  assert.deepEqual(scoredRows(h).map((e) => e.kind === "relation" && e.event === "scored" ? [e.scoreKind, e.delta, e.why] : null), [["nudge", -6, "he was rude"]]);
  await h.c.onConversationEnded([{ name: "Theo", nudge: null, has: ["iron_ingot"], needs: ["bread"] }]);
  assert.equal(scoredRows(h).length, 1, "has/needs only: no new row");
  assert.deepEqual(h.book.get("Theo")!.saidHas.map((x) => x.item), ["iron_ingot"]);
  const before = h.book.get("Theo")!.ledger;
  await h.c.onConversationEnded(nudgeOf(Number.NaN, "not a number"));
  assert.equal(scoredRows(h).length, 1, "a nudge that scores nothing: the older row is not journaled again");
  assert.deepEqual(h.book.get("Theo")!.ledger, before);
  await h.c.onConversationEnded(nudgeOf(4, "he helped"));
  assert.equal(scoredRows(h).length, 2, "the next nudge adds exactly one");
});

test("a proposal whose spoken line gives another number than the terms logs the difference, and is posted as proposed", async () => {
  const h = harness();
  const id = await h.c.onDecision(decision({ action: "propose", give: bread(1), get: ingots(18) }), "Theo", snapshot(), { heardAt: t0, say: "Theo, 16 bread for 18 iron ingots?" });
  assert.notEqual(id, null);
  assert.ok(h.logs.includes("trade: terms differ from the words: bread 1 in terms, 16 in the line"), h.logs.join("\n"));
  h.logs.length = 0;
  await h.c.onDecision(decision({ action: "propose", give: bread(2), get: ingots(18) }), "Theo", snapshot(), { heardAt: t0, say: "Theo, 2 bread for 18 iron ingots?" });
  assert.ok(!h.logs.some((line) => line.includes("differ from the words")));
});

test("owed lists my side not yet given of agreed trades only, and what a partial give left", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ action: "propose" }), "Theo", s);
  assert.deepEqual(h.c.owed(), [], "a proposal holds nothing back");
  await h.c.onDecision(decision({ action: "accept" }), "Theo", s);
  const id = theirTrade(h).id;
  assert.deepEqual(h.c.owed(), [{ item: "bread", count: 5, partner: "Theo", tradeId: id }]);
  await h.c.tookInHandoff(id, [{ item: "bread", count: 2 }]);
  assert.deepEqual(h.c.owed(), [{ item: "bread", count: 3, partner: "Theo", tradeId: id }]);
  await h.c.handoffEnded(id, "items_gone", "I no longer carry 3 bread; getting it back failed: nothing found");
  assert.deepEqual(h.c.owed(), [], "a broken trade owes nothing");
});

test("payBackLeftMs counts down the trade's pay-back clock, never below zero, and is zero for a trade that is not open", async () => {
  const h = harness();
  await h.c.onDecision(decision({ first: "me" }), "Theo", snapshot());
  const id = theirTrade(h).id;
  assert.equal(h.c.payBackLeftMs(id), 10 * MIN);
  h.state.now += 4 * MIN;
  assert.equal(h.c.payBackLeftMs(id), 6 * MIN);
  h.state.now += 20 * MIN;
  assert.equal(h.c.payBackLeftMs(id), 0);
  assert.equal(h.c.payBackLeftMs("nope"), 0);
});

test("payBackLeftMs of a trade they paid counts from when my give was taken, a retake included", async () => {
  const h = harness();
  const s = snapshot();
  await h.c.onDecision(decision({ first: "them" }), "Theo", s);
  const id = theirTrade(h).id;
  h.state.now += 4 * MIN;
  await h.c.tick(snapshot({ inventory: [{ name: "bread", count: 10 }, { name: "iron_ingot", count: 5 }] }), new Set(), signal);
  assert.equal(theirTrade(h).state, "they_gave");
  assert.deepEqual(kinds(h), ["give"], "their payment came: my give is taken");
  h.state.now += 3 * MIN;
  assert.equal(h.c.payBackLeftMs(id), 7 * MIN, "from the give's take, not from the agreement");
});

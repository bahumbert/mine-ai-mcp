import assert from "node:assert/strict";
import test from "node:test";
import type { Memory } from "../memory.ts";
import type { TradeDecision } from "../mind.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";
import { FakeRuntime, scriptedMind, testPersona } from "../testing.ts";
import { RelationBook } from "./book.ts";
import { TradeController } from "./controller.ts";
import type { Handoff } from "./handoff.ts";
import { newRelation } from "./record.ts";
import type { ItemCount, RelationEvent, TradeEvent, TradeSettings } from "./types.ts";

const MIN = 60_000;
const t0 = 1_000_000;
const settings: TradeSettings = { payBackMinutes: 10, startMinutes: 3, handoffDistance: 4, offersForgetMinutes: 60, maxOpenTrades: 3 };
const signal = new AbortController().signal;
const bread = (count: number): ItemCount[] => [{ item: "bread", count }];
const ingots = (count: number): ItemCount[] => [{ item: "iron_ingot", count }];

interface Harness {
  readonly c: TradeController;
  readonly book: RelationBook;
  readonly handoffs: Handoff[];
  readonly events: (TradeEvent | RelationEvent)[];
  readonly logs: string[];
  readonly chat: ReturnType<typeof scriptedMind>["chat"];
  readonly state: { now: number; slotFree: boolean; talking: Set<string> };
}

function harness(over: { settings?: Partial<TradeSettings> } = {}): Harness {
  const state = { now: t0, slotFree: true, talking: new Set<string>() };
  const handoffs: Handoff[] = [];
  const events: (TradeEvent | RelationEvent)[] = [];
  const logs: string[] = [];
  const saved: Memory[] = [];
  const book = new RelationBook({ save: async (m) => { saved.push(m); }, remove: async () => {}, now: () => state.now, log: (l) => logs.push(l) });
  const { chat, mind } = scriptedMind();
  const c = new TradeController({
    self: "Ayla", persona: testPersona(), book, mind, settings: { ...settings, ...over.settings }, now: () => state.now,
    takeHandoff: (h) => handoffs.push(h), modelSlotFree: () => state.slotFree, inConversationWith: (name) => state.talking.has(name),
    journal: (e) => events.push(e), log: (l) => logs.push(l),
  });
  return { c, book, handoffs, events, logs, chat, state };
}

const snapshot = (over: { inventory?: BotSnapshot["inventory"]; theo?: Position | null | "absent"; position?: Position } = {}): BotSnapshot => ({
  ...new FakeRuntime().snapshot,
  position: over.position ?? { x: 0, y: 64, z: 0 },
  inventory: over.inventory ?? [{ name: "bread", count: 10 }, { name: "oak_log", count: 10 }],
  players: over.theo === "absent" ? [] : [{ username: "Theo", position: over.theo === undefined ? { x: 2, y: 64, z: 0 } : over.theo }],
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
  assert.match(h.c.checkDecision(decision({ action: "propose" }), "Theo", s) ?? "", /already .*Theo/u);
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
  h.c.heardLine("Theo", h.state.now);
  h.state.now += 4_000;
  await h.c.tick(s, new Set(), signal);
  assert.deepEqual(h.handoffs, []);
  h.state.now += 1_000;
  await h.c.tick(s, new Set(), signal);
  assert.deepEqual(kinds(h), ["collect"]);
  assert.deepEqual(h.handoffs[0], { kind: "collect", tradeId: theirTrade(h).id, items: ingots(5) });
  await h.c.handoffEnded(theirTrade(h).id, "done", "picked up");
  h.c.heardLine("Theo", h.state.now);
  h.state.now += 6_000;
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.handoffs.length, 1, "no second collect");
});

test("collect fallback waits for the partner to be near", async () => {
  const h = harness();
  const far = snapshot({ theo: { x: 40, y: 64, z: 0 } });
  await h.c.onDecision(decision({ first: "them" }), "Theo", far);
  await h.c.tick(far, new Set(), signal);
  h.c.heardLine("Theo", h.state.now);
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

test("a trade ended outside a conversation is judged once and the feeling stored", async () => {
  const h = harness();
  const s = snapshot();
  h.chat.reply({ feeling: -2, word: "wary", why: "short payment" });
  await h.c.onDecision(decision({ first: "me" }), "Theo", s);
  await h.c.handoffEnded(theirTrade(h).id, "done", "gave");
  await h.c.tick(s, new Set(), signal);
  h.state.now += 11 * MIN;
  await h.c.tick(s, new Set(), signal);
  await h.c.settled();
  assert.equal(h.chat.requests.length, 1);
  const r = h.book.get("Theo")!;
  assert.deepEqual([r.feeling, r.word], [-2, "wary"]);
  const judged = h.events.find((e): e is RelationEvent => e.kind === "relation");
  assert.deepEqual([judged?.from, judged?.to, judged?.by], [0, -2, "judge"]);
  h.state.now += MIN;
  await h.c.tick(s, new Set(), signal);
  await h.c.settled();
  assert.equal(h.chat.requests.length, 1, "judged once");
});

test("no judge call while in a conversation with the partner: the gist sets the feeling", async () => {
  const h = harness();
  const s = snapshot();
  h.state.talking.add("Theo");
  await h.c.onDecision(decision({ first: "me" }), "Theo", s);
  await h.c.handoffEnded(theirTrade(h).id, "done", "gave");
  await h.c.tick(s, new Set(), signal);
  h.state.now += 11 * MIN;
  await h.c.tick(s, new Set(), signal);
  await h.c.settled();
  assert.equal(h.chat.requests.length, 0);
  await h.c.onConversationEnded([{ name: "Theo", judged: { feeling: -1, word: "careless", why: "late" }, has: ["iron_ingot"], needs: ["bread"] }]);
  const r = h.book.get("Theo")!;
  assert.deepEqual([r.feeling, r.word], [-1, "careless"]);
  assert.deepEqual(r.saidHas.map((x) => x.item), ["iron_ingot"]);
  assert.equal(h.events.find((e) => e.kind === "relation" && e.by === "gist") !== undefined, true);
});

test("the judge falls back when no model slot comes free in 2 minutes", async () => {
  const h = harness();
  const s = snapshot();
  h.state.slotFree = false;
  await h.c.onDecision(decision({ first: "me" }), "Theo", s);
  await h.c.handoffEnded(theirTrade(h).id, "done", "gave");
  await h.c.tick(s, new Set(), signal);
  h.state.now += 11 * MIN;
  await h.c.tick(s, new Set(), signal);
  h.state.now += 119_000;
  await h.c.tick(s, new Set(), signal);
  h.state.now += 2_000;
  await h.c.tick(s, new Set(), signal);
  await h.c.settled();
  assert.equal(h.chat.requests.length, 0);
  assert.equal(h.book.get("Theo")!.feeling, 0);
  assert.match(h.logs.join("\n"), /no model slot/u);
  h.state.slotFree = true;
  await h.c.tick(s, new Set(), signal);
  await h.c.settled();
  assert.equal(h.chat.requests.length, 0, "the skipped judgment is not asked later");
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
  h.book.load([newRelation("Theo", t0)]);
  await h.c.onDecision(decision({ first: "them" }), "Theo", s);
  h.state.now += 3 * MIN;
  await h.c.tick(s, new Set(), signal);
  const block = h.c.block(["Theo", "Zed"], ["iron_ingot x3"]);
  assert.match(block, /You and Theo/u);
  assert.match(block, /not dealt with Zed/u);
  assert.match(block, /Nobody has given yet.*Theo/u);
  assert.match(block, /lacks: iron_ingot x3/u);
});

test("the judge keeps waiting for a model slot for 2 minutes and then asks", async () => {
  const h = harness();
  const s = snapshot();
  h.chat.reply({ feeling: 1, word: "fair", why: "paid late" });
  h.state.slotFree = false;
  await h.c.onDecision(decision({ first: "me" }), "Theo", s);
  await h.c.handoffEnded(theirTrade(h).id, "done", "gave");
  await h.c.tick(s, new Set(), signal);
  h.state.now += 11 * MIN;
  await h.c.tick(s, new Set(), signal);
  h.state.now += 119_000;
  await h.c.tick(s, new Set(), signal);
  assert.equal(h.chat.requests.length, 0);
  h.state.slotFree = true;
  await h.c.tick(s, new Set(), signal);
  await h.c.settled();
  assert.equal(h.chat.requests.length, 1);
  assert.equal(h.book.get("Theo")!.word, "fair");
});

test("onDecision answers the trade id it recorded, and null when it recorded none", async () => {
  const h = harness();
  const s = snapshot();
  const proposed = await h.c.onDecision(decision({ action: "propose" }), "Theo", s);
  assert.equal(proposed, theirTrade(h).id);
  assert.equal(await h.c.onDecision(decision({ action: "propose" }), "Theo", s), null, "a proposal while one is open is ignored");
  const agreed = await h.c.onDecision(decision({ action: "accept" }), "Theo", s);
  assert.equal(agreed, proposed, "the accepted proposal keeps its id");
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

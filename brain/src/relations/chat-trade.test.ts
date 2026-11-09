import assert from "node:assert/strict";
import test from "node:test";
import type { ChatDecision, ChatInput, TradeDecision } from "../mind.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import { FakeRuntime, testPersona, testScoring } from "../testing.ts";
import { RelationBook } from "./book.ts";
import { describeLacks, itemsYieldedBy, resendRefusedTrade } from "./chat-trade.ts";
import { TradeController } from "./controller.ts";
import { withTrade } from "./record.ts";
import { agreeTrade, proposeTrade } from "./trade.ts";
import type { Trade } from "./types.ts";

test("lacks are the wanted items none of which is carried", () => {
  assert.deepEqual(describeLacks(new Set(["iron_ingot", "oak_log"]), [{ name: "oak_log", count: 3 }]), ["iron_ingot"]);
  assert.deepEqual(describeLacks([], [{ name: "oak_log", count: 3 }]), []);
});

test("a running step yields the items it is out to get, and the block it mines", () => {
  assert.deepEqual([...itemsYieldedBy({ skill: "collect_block", block: "oak_log", count: 3 })], ["oak_log"]);
  assert.deepEqual([...itemsYieldedBy({ skill: "get_items", items: [{ item: "stick", count: 2 }] })], ["stick"]);
  assert.deepEqual([...itemsYieldedBy({ skill: "go_to_player", player: "Theo" })], []);
});

// A1: the checks read the world as it is when the reply comes.
const ok = (inventory: BotSnapshot["inventory"], theo: { x: number; y: number; z: number } | null = { x: 2, y: 64, z: 0 }): BotSnapshot => ({
  ...new FakeRuntime().snapshot, position: { x: 0, y: 64, z: 0 }, inventory, players: theo === null ? [] : [{ username: "Theo", position: theo }],
});
const give = (n: number): ChatDecision => ({ say: "ok", route: "talk", request: "", trade: { action: "propose", give: [{ item: "bread", count: n }], get: [{ item: "iron_ingot", count: 1 }], first: "me" } });
const plain: ChatDecision = { say: "fine", route: "talk", request: "" };

/** `trades`: kept in the book before the run; `speaker`: whose line the reply answers (Theo by default). */
function refusal(first: ChatDecision, o: { chat: BotSnapshot; fresh: () => Promise<BotSnapshot>; second?: ChatDecision; signal?: AbortSignal; trades?: readonly Trade[]; speaker?: string; heardAt?: number }) {
  const logs: string[] = [];
  const asked: ChatInput[] = [];
  const book = new RelationBook({ save: async () => {}, remove: async () => {}, now: () => 0, log: () => {}, scoring: testScoring() });
  const trades = new TradeController({ self: "Ayla", persona: testPersona(), book, settings: testPersona().settings.relations, now: () => 0, wallNow: () => 0, takeHandoff: () => {}, journal: () => {}, log: () => {} });
  const mind = { chat: async (input: ChatInput) => { asked.push(input); return o.second ?? plain; } };
  const input = { relations: { block: "b", tradeOn: true } } as unknown as ChatInput;
  const run = async () => {
    for (const trade of o.trades ?? []) await book.update(trade.partner, (r) => withTrade(r, trade));
    return resendRefusedTrade({ mind, input, first, trades, speaker: o.speaker ?? "Theo", ...(o.heardAt !== undefined && { heardAt: o.heardAt }), snapshot: o.chat, fresh: o.fresh, signal: o.signal ?? new AbortController().signal, log: (line) => logs.push(line) });
  };
  return { run, logs, asked };
}

test("A1: the first reply's trade is checked on a snapshot read after the reply, not the one read before the model call", async () => {
  const r = refusal(give(5), { chat: ok([{ name: "bread", count: 0 }]), fresh: async () => ok([{ name: "bread", count: 10 }]) });
  const { decision } = await r.run();
  assert.equal(decision.trade?.action, "propose", "the bread arrived during the call: accepted where the chat snapshot refuses");
  assert.equal(r.asked.length, 0);
});

test("A1: the item given away during the call is refused on what is carried now", async () => {
  const r = refusal(give(5), { chat: ok([{ name: "bread", count: 10 }]), fresh: async () => ok([{ name: "bread", count: 0 }]), second: plain });
  const { decision } = await r.run();
  assert.equal(decision.trade, undefined);
  assert.match(r.logs.join("\n"), /you carry 0 bread/u);
  assert.equal(r.asked.length, 1, "sent back once");
});

test("A1: a refused-then-fixed reply reads two fresh snapshots and returns the last one; a reply with no trade reads none", async () => {
  let reads = 0;
  const fresh = async (): Promise<BotSnapshot> => { reads += 1; return ok([{ name: "bread", count: reads === 1 ? 0 : 10 }]); };
  const fixed = refusal(give(5), { chat: ok([{ name: "bread", count: 10 }]), fresh, second: give(5) });
  const out = await fixed.run();
  assert.equal(reads, 2);
  assert.equal(out.decision.trade?.action, "propose");
  assert.equal(out.snapshot.inventory[0]?.count, 10, "the snapshot of the last check");
  reads = 0;
  await refusal(plain, { chat: ok([]), fresh }).run();
  assert.equal(reads, 0);
});

test("A1: a fresh read that fails leaves the chat snapshot to decide with one line logged, unless the run is aborted", async () => {
  const failing = async (): Promise<BotSnapshot> => { throw new Error("status down"); };
  const r = refusal(give(5), { chat: ok([{ name: "bread", count: 10 }]), fresh: failing });
  const { decision, snapshot } = await r.run();
  assert.equal(decision.trade?.action, "propose");
  assert.equal(snapshot.inventory[0]?.count, 10);
  assert.deepEqual(r.logs, ["  trade check on the chat snapshot: Error: status down"]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(refusal(give(5), { chat: ok([]), fresh: failing, signal: controller.signal }).run(), /status down/u);
});

// Spec 2026-11-08-trading-p2-fixes D7b (plan Task 4.1): a reply that restates a trade of the book is neither sent back nor dropped.
const COBBLESTONE_FOR_BREAD = { give: [{ item: "cobblestone", count: 8 }], get: [{ item: "bread", count: 4 }], first: "them" as const };
const agreedWith = (partner: string): Trade => agreeTrade(null, { self: "Ayla", partner, ...COBBLESTONE_FOR_BREAD, now: 1 });
const accepting = (over: Partial<TradeDecision> = {}): ChatDecision => ({ say: "Deal.", route: "act", request: "build a shelter", work: "building", trade: { action: "accept", ...COBBLESTONE_FOR_BREAD, ...over } });
/** Ayla near Theo and Lena, carrying `cobblestone`. */
const nearBoth = (cobblestone: number): BotSnapshot => ({
  ...ok([{ name: "cobblestone", count: cobblestone }]), players: [{ username: "Theo", position: { x: 2, y: 64, z: 0 } }, { username: "Lena", position: { x: 3, y: 64, z: 0 } }],
});

test("a reply re-stating the agreed trade is not sent back and drops no trade (s3s seq 31)", async () => {
  const agreed = agreedWith("Theo");
  const world = nearBoth(8);
  const r = refusal(accepting(), { chat: world, fresh: async () => world, trades: [agreed] });
  const { decision } = await r.run();
  assert.equal(r.asked.length, 0, "no second model call");
  assert.equal(decision.trade, undefined);
  assert.equal(decision.tradeDropped, undefined, "a restatement is no refused trade: the order stays a plain line");
  assert.equal(decision.route, "act");
  assert.equal(decision.request, "build a shelter");
  assert.equal(decision.work, "building");
  assert.ok(r.logs.some((line) => line.includes(`restates ${agreed.id} (agreed) with Theo`)), r.logs.join("\n"));
});

test("a reply re-stating another partner's trade is not sent back when nothing is open with the speaker (s3s seq 17)", async () => {
  const world = nearBoth(8);
  const r = refusal(accepting(), { chat: world, fresh: async () => world, trades: [agreedWith("Tester")], speaker: "Lena" });
  const { decision } = await r.run();
  assert.equal(r.asked.length, 0);
  assert.equal(decision.trade, undefined);
  assert.equal(decision.tradeDropped, undefined);
});

test("another partner's terms the checks accept are a new trade", async () => {
  const world = nearBoth(16);
  const r = refusal(accepting(), { chat: world, fresh: async () => world, trades: [agreedWith("Tester")], speaker: "Lena" });
  const { decision } = await r.run();
  assert.equal(r.asked.length, 0);
  assert.equal(decision.trade?.action, "accept");
});

test("another partner's terms with an offer or trade open with the speaker are resent as today", async () => {
  const world = nearBoth(8);
  const proposedToLena = proposeTrade({ self: "Ayla", partner: "Lena", ...COBBLESTONE_FOR_BREAD, give: [{ item: "cobblestone", count: 1 }], now: 2 });
  const r = refusal(accepting(), { chat: world, fresh: async () => world, trades: [agreedWith("Tester"), proposedToLena], speaker: "Lena" });
  await r.run();
  assert.equal(r.asked.length, 1);
});

test("a different count is resent and dropped as today", async () => {
  const world = nearBoth(8);
  const different = accepting({ get: [{ item: "bread", count: 5 }] });
  const r = refusal(different, { chat: world, fresh: async () => world, trades: [agreedWith("Theo")], second: different });
  const { decision } = await r.run();
  assert.equal(r.asked.length, 1);
  assert.equal(decision.trade, undefined);
  assert.equal(decision.tradeDropped, true);
});

test("a real refused trade whose re-answer re-states keeps the mark", async () => {
  const world = nearBoth(8);
  const unaffordable: ChatDecision = { ...accepting(), trade: { action: "propose", give: [{ item: "cobblestone", count: 50 }], get: [{ item: "bread", count: 4 }], first: "me" } };
  const r = refusal(unaffordable, { chat: world, fresh: async () => world, trades: [agreedWith("Theo")], second: accepting() });
  const { decision } = await r.run();
  assert.equal(r.asked.length, 1, "the first reply was a real refused trade: sent back once");
  assert.equal(decision.trade, undefined);
  assert.equal(decision.tradeDropped, true, "the first reply's trade came to nothing");
  assert.ok(r.logs.some((line) => line.includes("restates")), r.logs.join("\n"));
});

// Spec D7a/D7b (plan Task 4.2): a repeat of a trade done just before is a restatement after a refusal too: the giver no longer holds the items, so the checks refuse it.
const doneAt = (partner: string, endedAt: number): Trade => ({ ...agreedWith(partner), state: "done", endedAt });

test("a reply repeating a trade done while the model answered is not sent back, though its items are gone", async () => {
  const world = nearBoth(0);
  const done = doneAt("Theo", 0);
  const r = refusal(accepting(), { chat: world, fresh: async () => world, trades: [done], heardAt: -1_000 });
  const { decision } = await r.run();
  assert.equal(r.asked.length, 0, "no second model call");
  assert.equal(decision.trade, undefined);
  assert.equal(decision.tradeDropped, undefined, "the order stays a plain one");
  assert.ok(r.logs.some((line) => line.includes(`restates ${done.id} (done) with Theo`)), r.logs.join("\n"));
});

test("a done trade is no restatement of an accept answering my own open proposal with the same terms", async () => {
  const world = nearBoth(0);
  const mine = proposeTrade({ self: "Ayla", partner: "Theo", ...COBBLESTONE_FOR_BREAD, now: 2 });
  const r = refusal(accepting(), { chat: world, fresh: async () => world, trades: [doneAt("Theo", 0), mine], second: accepting(), heardAt: -1_000 });
  const { decision } = await r.run();
  assert.equal(r.asked.length, 1, "the spoken yes to my proposal is refused for its items and resent, as `onDecision` ignores a repeat only with nothing open");
  assert.equal(decision.tradeDropped, true);
});

test("a done trade is no restatement for other terms or for a line heard after it ended: refused and resent as today", async () => {
  const world = nearBoth(0);
  const other = accepting({ get: [{ item: "bread", count: 5 }] });
  const differentTerms = refusal(other, { chat: world, fresh: async () => world, trades: [doneAt("Theo", 0)], second: other, heardAt: -1_000 });
  assert.equal((await differentTerms.run()).decision.tradeDropped, true);
  assert.equal(differentTerms.asked.length, 1);
  const heardLater = refusal(accepting(), { chat: world, fresh: async () => world, trades: [doneAt("Theo", 0)], second: accepting(), heardAt: 1_000 });
  assert.equal((await heardLater.run()).decision.tradeDropped, true, "a new ask (spec 2026-11-07-gift-asked-for D5)");
  assert.equal(heardLater.asked.length, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { ChatDecision, ChatInput } from "../mind.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import { FakeRuntime, testPersona, testScoring } from "../testing.ts";
import { RelationBook } from "./book.ts";
import { describeLacks, itemsYieldedBy, resendRefusedTrade } from "./chat-trade.ts";
import { TradeController } from "./controller.ts";

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

function refusal(first: ChatDecision, o: { chat: BotSnapshot; fresh: () => Promise<BotSnapshot>; second?: ChatDecision; signal?: AbortSignal }) {
  const logs: string[] = [];
  const asked: ChatInput[] = [];
  const book = new RelationBook({ save: async () => {}, remove: async () => {}, now: () => 0, log: () => {}, scoring: testScoring() });
  const trades = new TradeController({ self: "Ayla", persona: testPersona(), book, settings: testPersona().settings.relations, now: () => 0, takeHandoff: () => {}, journal: () => {}, log: () => {} });
  const mind = { chat: async (input: ChatInput) => { asked.push(input); return o.second ?? plain; } };
  const input = { relations: { block: "b", tradeOn: true } } as unknown as ChatInput;
  const run = () => resendRefusedTrade({ mind, input, first, trades, speaker: "Theo", snapshot: o.chat, fresh: o.fresh, signal: o.signal ?? new AbortController().signal, log: (line) => logs.push(line) });
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

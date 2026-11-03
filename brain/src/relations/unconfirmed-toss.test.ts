// The end states of an unconfirmed toss, run through the agent's hand-off with a partner of this brain on the board (plan 2026-11-03 handover-ledge-and-unconfirmed-toss, Task F2).
import assert from "node:assert/strict";
import test from "node:test";
import { Body } from "../body.ts";
import { FakeRuntime, scriptedMind, testPersona, testScoring } from "../testing.ts";
import { AgentRelations } from "./agent-relations.ts";
import { TradeBoard } from "./board.ts";
import { RelationBook } from "./book.ts";
import { TradeController } from "./controller.ts";
import type { Handoff } from "./handoff.ts";
import type { TradeSettings } from "./types.ts";

const settings: TradeSettings = { payBackMinutes: 10, startMinutes: 3, handoffDistance: 4, offersForgetMinutes: 60, maxOpenTrades: 3, tradeReach: 32 };
const table = [{ item: "crafting_table", count: 1 }];
const iron = [{ item: "iron_ingot", count: 1 }];
const lost = (runtime: FakeRuntime, planks = 8) => ({ status: "succeeded", error: null, dropped: [{ item: "crafting_table", dropped: 1 }], recipient: { collected: false, collectedCount: 0, settled: true },
  effect: () => { runtime.snapshot = { ...runtime.snapshot, inventory: planks > 0 ? [{ name: "oak_planks", count: planks }] : [] }; } }) as const;
const taken = { status: "succeeded", error: null, dropped: [{ item: "crafting_table", dropped: 1 }], recipient: { collected: true, collectedCount: 1, settled: true } } as const;

/** Ayla owes Theo a crafting_table (she gives first); Theo is a character of the same brain. The wait for his record runs on a clock that jumps. */
async function aylaOwesTheo() {
  const board = new TradeBoard();
  const runtime = new FakeRuntime();
  runtime.recipes = { crafting_table: { makes: 1, needs: [{ item: "oak_planks", count: 4 }] } };
  runtime.simulateInventory = true;
  runtime.walkOnNavigate = true;
  runtime.failures.pick_up_items = "[NO_MATCHING_ITEMS] No matching loaded dropped items were observed in the area.";
  runtime.failureResults.pick_up_items = { pickup: { observed: 0, sightings: [] } };
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0, y: 64, z: 0 }, inventory: [{ name: "crafting_table", count: 1 }, { name: "oak_planks", count: 8 }], players: [{ username: "Theo", position: { x: 2, y: 64, z: 0 } }] };
  const skew = { ms: 0 };
  const clock = { now: () => Date.now() + skew.ms, sleep: async (ms: number) => { skew.ms += ms; } };
  const theoLines: string[] = [];
  const theoBook = new RelationBook({ save: async () => {}, remove: async () => {}, now: () => Date.now(), log: (l) => theoLines.push(l), scoring: testScoring() });
  const theoHandoffs: Handoff[] = [];
  const theo = new TradeController({ self: "Theo", persona: testPersona({ username: "Theo" }), book: theoBook, settings, now: () => Date.now(), takeHandoff: (h) => theoHandoffs.push(h), journal: () => undefined, log: (l) => theoLines.push(l), board });
  const relations = new AgentRelations({
    persona: testPersona(), mind: scriptedMind().mind, runtime, body: new Body(runtime, () => undefined), takeHandoff: () => undefined, isAgent: () => true, lacks: () => [],
    journal: () => undefined, log: () => undefined, clock, board, hearingRange: 32, isOnline: () => true, waitingFrom: () => false, obeyRandom: () => 0,
  });
  const theoSnapshot = { ...runtime.snapshot, inventory: [{ name: "iron_ingot", count: 1 }], players: [{ username: "Ayla", position: { x: 2, y: 64, z: 0 } }] };
  await theo.onDecision({ action: "propose", give: iron, get: table, first: "them" }, "Ayla", theoSnapshot);
  await relations.trades.onDecision({ action: "accept", give: table, get: iron, first: "me" }, "Theo", runtime.snapshot);
  const id = relations.trades.openWith("Theo")!.id;
  const give: Handoff = { kind: "give", tradeId: id, partner: "Theo", items: table };
  const context = { runtime, body: new Body(runtime, () => undefined), signal: new AbortController().signal };
  const drops = () => runtime.submitted.filter((call) => call.tool === "drop_item").length;
  return { runtime, relations, theo, give, context, drops, id, theoBook };
}

test("unconfirmed toss then retry re-gives after a fetch", async () => {
  const h = await aylaOwesTheo();
  h.runtime.dropOutcomes.push(lost(h.runtime), taken);
  const first = await h.relations.runHandoff(h.give, h.context);
  assert.equal(first.outcome, "not_taken");
  assert.equal(h.relations.trades.openWith("Theo")!.state, "agreed", "one failed try: the trade stays open");
  const second = await h.relations.runHandoff(h.give, h.context);
  assert.equal(second.outcome, "done", second.detail);
  assert.equal(h.drops(), 2);
  assert.equal(h.runtime.submitted.filter((call) => call.tool === "craft_item").length, 1, "the table the first toss lost was fetched");
});

test("unconfirmed toss then retry breaks and tells the partner", async () => {
  const h = await aylaOwesTheo();
  h.runtime.dropOutcomes.push(lost(h.runtime, 0));
  h.runtime.failures.collect_block = "[NOT_FOUND] no crafting_table block within reach";
  const first = await h.relations.runHandoff(h.give, h.context);
  assert.equal(first.outcome, "not_taken");
  const second = await h.relations.runHandoff(h.give, h.context);
  assert.equal(second.outcome, "items_gone", second.detail);
  await h.theo.settled();
  const theirs = h.theoBook.get("Ayla")!.trades.at(-1)!;
  assert.deepEqual([theirs.state, /Ayla broke it/u.test(theirs.note)], ["cancelled", true], "Theo was told that Ayla broke it");
});

test("a toss Theo's record shows after the give ended not_taken is not given again by the retry", async () => {
  const h = await aylaOwesTheo();
  h.runtime.dropOutcomes.push(lost(h.runtime), taken);
  assert.equal((await h.relations.runHandoff(h.give, h.context)).outcome, "not_taken");
  // Theo's tick sees the table arrive after the wait ran out.
  const before = { ...h.runtime.snapshot, inventory: [{ name: "iron_ingot", count: 1 }], players: [{ username: "Ayla", position: { x: 2, y: 64, z: 0 } }] };
  await h.theo.tick(before, new Set(), new AbortController().signal);
  await h.theo.tick({ ...before, inventory: [{ name: "iron_ingot", count: 1 }, { name: "crafting_table", count: 1 }] }, new Set(), new AbortController().signal);
  const second = await h.relations.runHandoff(h.give, h.context);
  assert.equal(second.outcome, "done");
  assert.equal(h.drops(), 1, "the retry found the record and tossed nothing");
});

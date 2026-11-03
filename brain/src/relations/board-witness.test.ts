// A giver asks a partner of this brain what its own record shows received, and tells it when it cannot reach it (plan 2026-11-03 handover-ledge-and-unconfirmed-toss, Task F2).
import assert from "node:assert/strict";
import test from "node:test";
import type { TradeDecision } from "../mind.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import { FakeRuntime, testPersona, testScoring } from "../testing.ts";
import { TradeBoard } from "./board.ts";
import { RelationBook } from "./book.ts";
import { TradeController } from "./controller.ts";
import type { Handoff } from "./handoff.ts";
import type { ItemCount, TradeSettings } from "./types.ts";

const t0 = 1_000_000;
const settings: TradeSettings = { payBackMinutes: 10, startMinutes: 3, handoffDistance: 4, offersForgetMinutes: 60, maxOpenTrades: 3, tradeReach: 32 };
const bread = (count: number): ItemCount[] => [{ item: "bread", count }];
const logs = (count: number): ItemCount[] => [{ item: "oak_log", count }];
const state = { now: t0 };
const signal = new AbortController().signal;

function bot(self: string, board: TradeBoard | undefined) {
  const handoffs: Handoff[] = [];
  const lines: string[] = [];
  const book = new RelationBook({ save: async () => {}, remove: async () => {}, now: () => state.now, log: (l) => lines.push(l), scoring: testScoring() });
  const c = new TradeController({
    self, persona: testPersona(), book, settings, now: () => state.now, takeHandoff: (h) => { handoffs.push(h); },
    journal: () => undefined, log: (l) => lines.push(l), ...(board !== undefined && { board }),
  });
  const bag = (bread = 10, oak = 10): BotSnapshot["inventory"] => [{ name: "bread", count: bread }, { name: "oak_log", count: oak }];
  const snapshot = (inventory = bag()): BotSnapshot => ({ ...new FakeRuntime().snapshot, inventory, players: ["Finn", "Ayla"].map((username) => ({ username, position: { x: 2, y: 64, z: 0 } })) });
  const latest = (partner: string) => book.get(partner)?.trades.at(-1);
  return { c, book, handoffs, lines, snapshot, bag, latest };
}
type Bot = ReturnType<typeof bot>;

const propose = (give: ItemCount[], get: ItemCount[], first: "me" | "them" = "me"): TradeDecision => ({ action: "propose", give, get, first });
const accept = (give: ItemCount[], get: ItemCount[], first: "me" | "them" = "me"): TradeDecision => ({ action: "accept", give, get, first });

/** Finn gives 8 bread first for 8 oak_log; Ayla accepted and ticked once, so her baseline is her bag. */
async function agreedFinnFirst() {
  state.now = t0;
  const board = new TradeBoard();
  const finn = bot("Finn", board);
  const ayla = bot("Ayla", board);
  const id = (await finn.c.onDecision(propose(bread(8), logs(8)), "Ayla", finn.snapshot()))!;
  await ayla.c.onDecision(accept(logs(8), bread(8), "them"), "Finn", ayla.snapshot());
  await finn.c.settled();
  await ayla.c.tick(ayla.snapshot(), new Set(), signal);
  return { board, finn, ayla, id };
}

/** Ayla's bag grows by 8 bread between two ticks: her record credits the payment. */
async function aylaSeesBread(ayla: Bot): Promise<void> {
  state.now += 1_000;
  await ayla.c.tick(ayla.snapshot(ayla.bag(18, 10)), new Set(), signal);
}

test("the partner's record of a trade is asked through the board: what it received beyond my credit", async () => {
  const { finn, ayla, id } = await agreedFinnFirst();
  assert.deepEqual(finn.c.unclaimedByPartner(id), [], "nothing received yet");
  await aylaSeesBread(ayla);
  assert.deepEqual(finn.c.unclaimedByPartner(id), bread(8));
  await finn.c.tookInHandoff(id, bread(3));
  assert.deepEqual(finn.c.unclaimedByPartner(id), bread(5), "what I credited is not claimed twice");
});

test("a partner outside the board has no record to ask: null", async () => {
  const lone = bot("Finn", undefined);
  const id = (await lone.c.onDecision(propose(bread(8), logs(8)), "Ayla", lone.snapshot()))!;
  assert.equal(lone.c.unclaimedByPartner(id), null);
});

test("a restart that emptied the board leaves nothing to ask: null", async () => {
  const { finn, id } = await agreedFinnFirst();
  const fresh = new TradeBoard();
  const restarted = bot("Finn", fresh);
  void finn;
  assert.equal(restarted.c.unclaimedByPartner(id), null);
});

test("a partner told it cannot be reached walks to the giver once, from its wait for that trade", async () => {
  const { board, finn, ayla, id } = await agreedFinnFirst();
  await ayla.c.tick(ayla.snapshot(), new Set(), signal);
  assert.ok(ayla.handoffs.some((h) => h.kind === "await" && h.tradeId === id), "Ayla waits for Finn");
  board.cannotReach(id, "Finn", "Ayla");
  await ayla.c.settled();
  assert.equal(ayla.c.askedToCome(id), true);
  assert.equal(ayla.c.askedToCome(id), false, "asked once");
  void finn;
});

test("a partner told it cannot be reached while not waiting for that trade does nothing and logs it", async () => {
  const { board, ayla, id } = await agreedFinnFirst();
  await ayla.c.tick(ayla.snapshot(), new Set(), signal);
  ayla.c.awaitEnded(id, "failed");
  board.cannotReach(id, "Finn", "Ayla");
  await ayla.c.settled();
  assert.equal(ayla.c.askedToCome(id), false);
  assert.ok(ayla.lines.some((l) => /cannot reach/u.test(l) && /not waiting/u.test(l)), ayla.lines.join("\n"));
});

test("a partner told about a trade that is no trade of its own does nothing and logs it", async () => {
  const { board, ayla } = await agreedFinnFirst();
  board.cannotReach("Finn-Ayla-nothing", "Finn", "Ayla");
  await ayla.c.settled();
  assert.ok(ayla.lines.some((l) => /Finn-Ayla-nothing/u.test(l)));
});

test("a toss the partner's record shows after the give ended not_taken is credited on the next tick: my side is given", async () => {
  const { finn, ayla, id } = await agreedFinnFirst();
  await finn.c.tick(finn.snapshot(), new Set(), signal);
  await finn.c.handoffEnded(id, "not_taken", "Ayla has not got 8 bread: the toss was not seen taken");
  assert.equal(finn.latest("Ayla")!.state, "agreed");
  await aylaSeesBread(ayla);
  await finn.c.tick(finn.snapshot(), new Set(), signal);
  assert.equal(finn.latest("Ayla")!.gaveAt === null, false, "my side counts as given");
  assert.deepEqual(finn.c.leftToGive(id), null);
});

test("a record that shows the toss while my give is still running is left to the give: no credit twice", async () => {
  const { finn, ayla, id } = await agreedFinnFirst();
  await finn.c.tick(finn.snapshot(), new Set(), signal);
  assert.ok(finn.handoffs.some((h) => h.kind === "give"), "Finn's give is on the agent's stack");
  await aylaSeesBread(ayla);
  await finn.c.tick(finn.snapshot(), new Set(), signal);
  assert.deepEqual(finn.c.leftToGive(id), bread(8), "credited by the give itself when it ends");
});

test("the give ending not_taken counts the toss the record already shows (a take after the wait)", async () => {
  const { finn, ayla, id } = await agreedFinnFirst();
  await finn.c.tick(finn.snapshot(), new Set(), signal);
  await aylaSeesBread(ayla);
  await finn.c.handoffEnded(id, "not_taken", "Ayla has not got 8 bread: the toss was not seen taken");
  assert.notEqual(finn.latest("Ayla")!.gaveAt, null);
});

test("a toss the partner's record shows when the trade has ended (it cancelled after taking it) is counted given late", async () => {
  const { finn, ayla, id } = await agreedFinnFirst();
  await finn.c.tick(finn.snapshot(), new Set(), signal);
  await aylaSeesBread(ayla);
  await ayla.c.onDecision({ action: "cancel", give: [], get: [], first: "me" }, "Finn", ayla.snapshot());
  await finn.c.settled();
  assert.equal(finn.latest("Ayla")!.state, "cancelled");
  await finn.c.handoffEnded(id, "not_taken", "Ayla has not got 8 bread: the toss was not seen taken");
  assert.ok(finn.lines.some((l) => /given late to Ayla/u.test(l)), finn.lines.join("\n"));
});

test("a give running on the agent is not claimed by the tick even after a stop cleared its pending mark (no double credit)", async () => {
  const { finn, ayla, id } = await agreedFinnFirst();
  await finn.c.tick(finn.snapshot(), new Set(), signal);
  finn.c.giveRunning(id, true);
  finn.c.reconcileHandoffs(new Set());
  await aylaSeesBread(ayla);
  await finn.c.tick(finn.snapshot(), new Set(), signal);
  await finn.c.tookInHandoff(id, bread(8));
  assert.deepEqual(finn.c.leftToGive(id), [], "credited once, by the give");
  finn.c.giveRunning(id, false);
});

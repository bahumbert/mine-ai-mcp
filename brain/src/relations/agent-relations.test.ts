import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Body } from "../body.ts";
import { FakeRuntime, scriptedMind, testPersona, until } from "../testing.ts";
import { AgentRelations } from "./agent-relations.ts";

function relationsWithClock() {
  const runtime = new FakeRuntime();
  let statusCalls = 0;
  const status = runtime.status.bind(runtime);
  runtime.status = async () => { statusCalls += 1; return status(); };
  const clock = { now: () => time.at, sleep: async () => {} };
  const time = { at: 1_000_000 };
  const relations = new AgentRelations({
    persona: testPersona(), mind: scriptedMind().mind, runtime, body: {} as Body, takeHandoff: () => {}, modelSlotFree: () => true,
    inConversationWith: () => false, isAgent: () => false, lacks: () => [], journal: () => {}, log: () => {}, clock,
  });
  const look = async () => { relations.look(new Set(), new Set(), new AbortController().signal); await new Promise((r) => setTimeout(r, 5)); };
  return { relations, time, look, calls: () => statusCalls };
}

const MIN = 60_000;
const IRON_TRADE = { action: "accept" as const, give: [{ item: "bread", count: 5 }], get: [{ item: "iron_ingot", count: 5 }], first: "them" as const };

/** Relations over a runtime whose clock (the controller's and the look's) is moved by hand through `Date.now`. */
function relationsOverTime(t: TestContext) {
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  const time = { offset: 0 };
  /** Armed, the journal throws on the next `received` event: a tick that fails after it credited a payment. */
  const journal = { failOnReceived: false };
  const real = Date.now.bind(Date);
  t.mock.method(Date, "now", () => real() + time.offset);
  const relations = new AgentRelations({
    persona: testPersona(), mind: scriptedMind().mind, runtime, body: {} as Body, takeHandoff: () => {}, modelSlotFree: () => true,
    inConversationWith: () => false, isAgent: () => false, lacks: () => [], log: (line) => logs.push(line),
    journal: (event) => {
      if (journal.failOnReceived && event.kind === "trade" && event.event === "received") {
        journal.failOnReceived = false;
        throw new Error("journal down");
      }
    },
  });
  const carry = (iron: number) => { runtime.snapshot = { ...runtime.snapshot, position: { x: 0, y: 64, z: 0 }, inventory: [{ name: "bread", count: 10 }, ...(iron > 0 ? [{ name: "iron_ingot", count: iron }] : [])], players: [{ username: "Theo", position: { x: 2, y: 64, z: 0 } }] }; };
  carry(0);
  /** One look; when it starts a tick, waits for the tick to end. */
  const look = async (yields: string[] = []) => {
    const answer = relations.look(new Set(yields), new Set(), new AbortController().signal);
    await until(() => !(relations as unknown as { looking: boolean }).looking);
    return answer;
  };
  const trade = () => relations.book.get("Theo")?.trades.at(-1);
  const keptLines = () => logs.filter((line) => line.includes("picked up while a player talked"));
  return { relations, runtime, logs, time, journal, carry, look, trade, keptLines };
}

test("B2: hours of own work after a window closed by time are not kept as a talking player's earlier gain", async (t) => {
  const h = relationsOverTime(t);
  h.relations.trades.heardLine("Theo", Date.now(), 2);
  assert.equal(await h.look(), "ticked");
  h.time.offset += 11 * MIN;
  assert.equal(await h.look(), "idle", "the window closed by time");
  h.time.offset += 60 * MIN;
  h.carry(20);
  h.relations.trades.heardLine("Theo", Date.now(), 2);
  assert.equal(await h.look(), "ticked");
  assert.deepEqual(h.keptLines(), []);
  await h.relations.trades.onDecision(IRON_TRADE, "Theo", h.runtime.snapshot);
  assert.equal(h.trade()?.state, "agreed");
  assert.deepEqual(h.trade()?.received, []);
});

test("B2: the same when the window was kept open by a fresh gain that then lapsed", async (t) => {
  const h = relationsOverTime(t);
  h.relations.trades.heardLine("Theo", Date.now(), 2);
  await h.look();
  h.time.offset += 1 * MIN;
  h.carry(5);
  await h.look();
  assert.equal(h.keptLines().length, 1, "the 5 iron picked up while Theo talked");
  h.time.offset += 12 * MIN;
  assert.equal(await h.look(), "idle", "the gain's 10 min are over");
  h.time.offset += 60 * MIN;
  h.carry(25);
  h.relations.trades.heardLine("Theo", Date.now(), 2);
  await h.look();
  assert.ok(!h.logs.some((line) => line.includes("20 iron_ingot")), h.logs.join("\n"));
});

test("B3: a tick whose status failed restarts the baseline: the next one counts no gain", async (t) => {
  const h = relationsOverTime(t);
  await h.relations.trades.onDecision(IRON_TRADE, "Theo", h.runtime.snapshot);
  await h.look();
  h.carry(3);
  const status = h.runtime.status.bind(h.runtime);
  h.runtime.status = async () => { throw new Error("status down"); };
  assert.equal(await h.look(["iron_ingot"]), "ticked");
  assert.ok(h.logs.some((line) => line.includes("trade check failed")));
  h.runtime.status = status;
  h.time.offset += 3_000;
  assert.equal(await h.look(), "ticked");
  assert.deepEqual(h.keptLines(), []);
  assert.deepEqual(h.trade()?.received, [], "the step's iron is not Theo's payment");
});

test("R1: a tick that fails after it read the status keeps its baseline: the payment tossed next is still credited", async (t) => {
  const h = relationsOverTime(t);
  const owing = { ...IRON_TRADE, get: [{ item: "iron_ingot", count: 5 }, { item: "oak_log", count: 2 }] };
  await h.relations.trades.onDecision(owing, "Theo", h.runtime.snapshot);
  await h.look();
  h.time.offset += 1_000;
  h.carry(5);
  h.journal.failOnReceived = true;
  await h.look();
  assert.ok(h.logs.some((line) => line.includes("trade check failed")), h.logs.join("\n"));
  assert.deepEqual(h.trade()?.received, [{ item: "iron_ingot", count: 5 }], "the iron was credited before the journal failed");
  h.runtime.snapshot = { ...h.runtime.snapshot, inventory: [...h.runtime.snapshot.inventory, { name: "oak_log", count: 2 }] };
  h.time.offset += 1_000;
  await h.look();
  assert.deepEqual(h.trade()?.received, [{ item: "iron_ingot", count: 5 }, { item: "oak_log", count: 2 }]);
  assert.equal(h.trade()?.state, "they_gave");
});

test("R1: a hand-off check that throws before the tick forgets the baseline like a failed status", async (t) => {
  const h = relationsOverTime(t);
  await h.relations.trades.onDecision(IRON_TRADE, "Theo", h.runtime.snapshot);
  await h.look();
  h.carry(3);
  const reconcile = h.relations.trades.reconcileHandoffs.bind(h.relations.trades);
  h.relations.trades.reconcileHandoffs = () => { throw new Error("stack unreadable"); };
  await h.look(["iron_ingot"]);
  assert.ok(h.logs.some((line) => line.includes("stack unreadable")));
  h.relations.trades.reconcileHandoffs = reconcile;
  h.time.offset += 3_000;
  await h.look();
  assert.deepEqual(h.keptLines(), []);
  assert.deepEqual(h.trade()?.received, [], "the step's iron is not Theo's payment");
});

test("an open trade keeps its baseline between ticks: a payment tossed in between is credited", async (t) => {
  const h = relationsOverTime(t);
  await h.relations.trades.onDecision(IRON_TRADE, "Theo", h.runtime.snapshot);
  await h.look();
  h.time.offset += 1_000;
  h.carry(5);
  assert.equal(await h.look(), "ticked");
  assert.deepEqual(h.trade()?.received, [{ item: "iron_ingot", count: 5 }]);
});

test("look() answers idle with nothing busy, busy_wait inside the throttle or while a tick runs, ticked otherwise", async () => {
  const { relations, time, look } = relationsWithClock();
  const signal = new AbortController().signal;
  assert.equal(relations.look(new Set(), new Set(), signal), "idle");
  relations.trades.heardLine("Theo", Date.now(), 2);
  assert.equal(relations.look(new Set(), new Set(), signal), "ticked");
  assert.equal(relations.look(new Set(), new Set(), signal), "busy_wait", "a tick is running");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(relations.look(new Set(), new Set(), signal), "busy_wait", "inside the watch throttle");
  time.at += 2_000;
  assert.equal(relations.look(new Set(), new Set(), signal), "ticked");
  await look();
  assert.equal(relations.look(new Set(), new Set(), AbortSignal.abort()), "idle", "aborted");
});

test("with only a window open look() polls status at most every 2 s", async () => {
  const { relations, time, look, calls } = relationsWithClock();
  relations.trades.heardLine("Theo", Date.now(), 2);
  await look();
  await look();
  assert.equal(calls(), 1, "a second look in the same instant does not poll");
  time.at += 1_999;
  await look();
  assert.equal(calls(), 1);
  time.at += 1;
  await look();
  assert.equal(calls(), 2);
});

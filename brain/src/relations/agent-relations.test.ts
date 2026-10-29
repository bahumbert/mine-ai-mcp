import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Body, INSTANT_TYPING } from "../body.ts";
import { FakeRuntime, scriptedMind, testPersona, until } from "../testing.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import { AgentRelations, type AgentRelationsDeps } from "./agent-relations.ts";
import { newRelation } from "./record.ts";
import type { RelationEvent } from "./types.ts";

function relationsWithClock(over: Partial<AgentRelationsDeps> = {}) {
  const rows: RelationEvent[] = [];
  const runtime = new FakeRuntime();
  let statusCalls = 0;
  const status = runtime.status.bind(runtime);
  runtime.status = async () => { statusCalls += 1; return status(); };
  const clock = { now: () => time.at, sleep: async () => {} };
  const time = { at: 1_000_000 };
  const relations = new AgentRelations({
    persona: testPersona(), mind: scriptedMind().mind, runtime, body: {} as Body, takeHandoff: () => {},
    isAgent: () => false, lacks: () => [], journal: (event) => { if (event.kind === "relation") rows.push(event); }, log: () => {}, clock,
    hearingRange: 32, isOnline: () => true, waitingFrom: () => false, ...over,
  });
  const look = async () => { relations.look(new Set(), new Set(), new AbortController().signal); await new Promise((r) => setTimeout(r, 5)); };
  return { relations, time, look, rows, calls: () => statusCalls };
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
    persona: testPersona(), mind: scriptedMind().mind, runtime, body: {} as Body, takeHandoff: () => {},
    isAgent: () => false, lacks: () => [], log: (line) => logs.push(line), hearingRange: 32, isOnline: () => true, waitingFrom: () => false,
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

/** A snapshot with the bot at the origin and the named players at the given x (null: online but not loaded). */
const around = (players: Record<string, number | null>): BotSnapshot => ({
  ...new FakeRuntime().snapshot, position: { x: 0, y: 64, z: 0 },
  players: Object.entries(players).map(([username, x]) => ({ username, position: x === null ? null : { x, y: 64, z: 0 } })),
});
const refusal = (n = 1) => ({ say: "", route: "talk" as const, request: "", myRequest: { n, answer: "refused" as const } });

test("a refusal heard scores the speaker", async () => {
  const { relations, rows } = relationsWithClock();
  relations.asked(["Theo"], "5 oak_log", null, around({ Theo: 3 }));
  await until(() => relations.book.get("Theo")?.requests.length === 1);
  await relations.answered(refusal(), "Theo");
  const theo = relations.book.get("Theo")!;
  assert.deepEqual([theo.score, theo.requests, theo.ledger.map((e) => e.kind)], [-3, [], ["request_refused"]]);
  assert.deepEqual(rows.map((r) => [r.scoreKind, r.delta, r.score]), [["request_refused", -3, -3]]);
});

test("an answer that names no open request moves nothing", async () => {
  const { relations, rows } = relationsWithClock();
  await relations.answered(refusal(), "Theo");
  assert.equal(relations.book.get("Theo"), null, "no record is made for it");
  relations.asked(["Theo"], "bread", null, around({ Theo: 3 }));
  await until(() => relations.book.get("Theo")?.requests.length === 1);
  await relations.answered(refusal(2), "Theo");
  assert.deepEqual([relations.book.get("Theo")?.requests.length, rows.length], [1, 0]);
});

test("an ignored request scores after 2 min with no brain tick in between", async () => {
  const { relations, time, look, rows } = relationsWithClock();
  relations.asked(["Theo"], "5 oak_log", null, around({ Theo: 3 }));
  await until(() => relations.book.get("Theo")?.requests.length === 1);
  await look();
  time.at += 110_000;
  await look();
  assert.equal(relations.book.get("Theo")!.ledger.length, 0, "not yet");
  time.at += 10_000;
  await look();
  await until(() => relations.book.get("Theo")!.ledger.length === 1);
  const theo = relations.book.get("Theo")!;
  assert.deepEqual([theo.requests, theo.ledger[0]?.kind, theo.ledger[0]?.why], [[], "request_ignored", "did not answer when you asked for 5 oak_log"]);
  assert.deepEqual(rows.map((r) => r.scoreKind), ["request_ignored"]);
  time.at += 10 * MIN;
  await look();
  assert.equal(relations.book.get("Theo")!.ledger.length, 1, "scored once");
});

test("out of range is never ignored", async () => {
  const { relations, time, look } = relationsWithClock({ hearingRange: 32 });
  relations.asked(["Theo"], "bread", null, around({ Theo: 80 }));
  await until(() => relations.book.get("Theo")?.requests.length === 1);
  assert.equal(relations.book.get("Theo")?.requests[0]?.inRange, false);
  await look();
  time.at += 10 * MIN;
  await look();
  await until(() => relations.book.get("Theo")!.requests.length === 0);
  assert.equal(relations.book.get("Theo")!.ledger.length, 0);
});

test("whisper to an offline player is never ignored", async () => {
  const online = new Set<string>();
  const { relations, time, look } = relationsWithClock({ isOnline: (name) => online.has(name) });
  relations.book.load([newRelation("Zed", time.at, 0)]);
  relations.asked(["Zed"], "bread", "Zed", around({}));
  await until(() => relations.book.get("Zed")?.requests.length === 1);
  assert.equal(relations.book.get("Zed")?.requests[0]?.inRange, false, "offline: nobody heard the whisper");
  relations.asked(["Theo"], "wool", "Theo", around({ Theo: null }));
  await until(() => relations.book.get("Theo")?.requests.length === 1);
  assert.equal(relations.book.get("Theo")?.requests[0]?.inRange, true, "online but not loaded: a whisper reaches them");
  online.add("Zed");
  await look();
  time.at += 10 * MIN;
  await look();
  await until(() => relations.book.get("Zed")!.requests.length === 0);
  assert.equal(relations.book.get("Zed")!.ledger.length, 0);
});

test("a name that is neither in the book nor online asks nothing", async () => {
  const { relations } = relationsWithClock();
  relations.asked(["Nobody", "Ayla"], "bread", null, around({}));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual([relations.book.get("Nobody"), relations.book.get("Ayla")], [null, null]);
});

test("opening's asks_of opens a request", async () => {
  const { relations } = relationsWithClock();
  relations.forConversations().asked(["theo"], "iron_ingot", around({ Theo: 5 }));
  await until(() => relations.book.get("Theo")?.requests.length === 1);
  assert.deepEqual(relations.book.get("Theo")?.requests.map((q) => [q.what, q.inRange, q.agreed]), [["iron_ingot", true, false]]);
});

test("a reply stuck in the model queue is not ignored", async () => {
  let waiting = true;
  const { relations, time, look, rows } = relationsWithClock({ waitingFrom: () => waiting });
  relations.asked(["Theo"], "5 oak_log", null, around({ Theo: 3 }));
  await until(() => relations.book.get("Theo")?.requests.length === 1);
  await look();
  time.at += 5 * MIN;
  await look();
  assert.deepEqual([relations.book.get("Theo")!.requests.length, rows.length], [1, 0], "their line is waiting for a model slot");
  await relations.answered(refusal(), "Theo");
  assert.deepEqual(rows.map((r) => r.scoreKind), ["request_refused"]);
  waiting = false;
  time.at += 10 * MIN;
  await look();
  assert.equal(relations.book.get("Theo")!.ledger.length, 1);
});

test("restart drops stale requests", () => {
  const { relations, time } = relationsWithClock();
  const stale = { ...newRelation("Theo", time.at - 10 * MIN, 0), requests: [{ what: "bread", at: time.at - 5 * MIN, inRange: true, agreed: false, heard: false }, { what: "wool", at: time.at - 1_000, inRange: true, agreed: false, heard: false }] };
  relations.load({ relations: [stale], skipped: 0 });
  assert.deepEqual(relations.book.get("Theo")?.requests.map((q) => q.what), ["wool"]);
  assert.equal(relations.book.get("Theo")?.ledger.length, 0);
});

test("the chat block shows the speaker's open requests, numbered", async () => {
  const { relations, time } = relationsWithClock();
  relations.asked(["Theo"], "5 oak_log", null, around({ Theo: 3 }));
  await until(() => relations.book.get("Theo")?.requests.length === 1);
  time.at += 90_000;
  const block = relations.chatBlock("Theo", [], around({ Theo: 3 }));
  assert.deepEqual(block.requests, ["1. You asked Theo for 5 oak_log 1 min ago."]);
  assert.deepEqual(relations.chatBlock("Bruno", [], around({})).requests, []);
});

test("a whisper makes only the one whispered to hear: the others it asks are out of range", async () => {
  const { relations } = relationsWithClock();
  relations.asked(["Ayla2", "Bob"], "bread", "Ayla2", around({ Ayla2: 2, Bob: 200 }));
  await until(() => relations.book.get("Bob")?.requests.length === 1 && relations.book.get("Ayla2")?.requests.length === 1);
  assert.deepEqual([relations.book.get("Ayla2")?.requests[0]?.inRange, relations.book.get("Bob")?.requests[0]?.inRange], [true, false]);
});

test("an answer journals only its own scored row, not one another writer queued before it", async () => {
  const { relations, rows } = relationsWithClock();
  relations.asked(["Theo"], "bread", null, around({ Theo: 3 }));
  await until(() => relations.book.get("Theo")?.requests.length === 1);
  rows.length = 0;
  void relations.book.score("Theo", { kind: "trade_done", why: "paid" });
  await relations.answered(refusal(), "Theo");
  assert.deepEqual(rows.map((r) => r.scoreKind), ["request_refused"]);
});

const hit = (attacker: string, direct: string | null = null, at = 0) => ({ attacker, direct, at });

test("hits debounced per attacker", async () => {
  const { relations, time, rows } = relationsWithClock();
  for (let i = 0; i < 10; i++) {
    relations.hurt(hit("Theo"));
    time.at += 400;
  }
  relations.hurt(hit("Ayla"));
  await until(() => rows.length === 2);
  assert.deepEqual(rows.map((r) => [r.partner, r.scoreKind, r.delta]), [["Theo", "hurt", -25], ["Ayla", "hurt", -25]]);
  time.at += 61_000;
  relations.hurt(hit("Theo"));
  await until(() => rows.length === 3);
  assert.deepEqual(rows.map((r) => r.partner), ["Theo", "Ayla", "Theo"]);
});

test("a hit inside the window writes nothing", async () => {
  const runtime = new FakeRuntime();
  let queries = 0;
  const query = runtime.queryBotData.bind(runtime);
  runtime.queryBotData = async (sql) => { queries += 1; return query(sql); };
  const { relations, time, rows } = relationsWithClock({ runtime });
  for (let i = 0; i < 10; i++) {
    relations.hurt(hit("Theo"));
    time.at += 400;
  }
  await until(() => rows.length === 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(queries, 0, "the first hit saves a new note; a rewrite would first look up and delete the old one");
});

test("a stranger hit is created at the first impression; the why names the weapon", async () => {
  const { relations, rows } = relationsWithClock();
  assert.equal(relations.book.get("Theo"), null);
  relations.hurt(hit("Theo"));
  relations.hurt(hit("Ayla", "arrow"));
  await until(() => rows.length === 2);
  assert.deepEqual([relations.book.get("Theo")?.score, ...rows.map((r) => r.why)], [-25, "hit you", "shot you"]);
});

/** Relations whose notes really go through a body over a fake runtime, so the notes written can be counted. */
function relationsWithNotes() {
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  const made = relationsWithClock({ runtime, body: new Body(runtime, () => undefined, INSTANT_TYPING), log: (line) => logs.push(line) });
  return { ...made, notes: runtime.notes, logs };
}
const askTheo = async (c: ReturnType<typeof relationsWithClock>) => {
  c.relations.asked(["Theo"], "4 coal", null, around({ Theo: 3 }));
  await until(() => c.relations.book.get("Theo")?.requests.length === 1);
};

test("a line from the asked partner stops the ignored score", async () => {
  const c = relationsWithClock();
  await askTheo(c);
  c.time.at += 10_000;
  c.relations.heardFrom("Theo");
  c.time.at += 3 * MIN;
  await c.look();
  await until(() => c.relations.book.get("Theo")!.requests.length === 0);
  assert.deepEqual([c.rows.length, c.relations.book.get("Theo")!.ledger.length], [0, 0]);
});

test("a line from someone else does not stop it", async () => {
  const c = relationsWithClock();
  await askTheo(c);
  c.time.at += 10_000;
  c.relations.heardFrom("Ayla");
  c.time.at += 3 * MIN;
  await c.look();
  await until(() => c.rows.length === 1);
  assert.equal(c.rows[0]?.scoreKind, "request_ignored");
});

test("a line read before the ask does not count", async () => {
  const c = relationsWithClock();
  c.relations.book.load([newRelation("Theo", c.time.at, 0)]);
  c.relations.heardFrom("Theo");
  c.time.at += 1_000;
  await askTheo(c);
  c.time.at += 3 * MIN;
  await c.look();
  await until(() => c.rows.length === 1);
  assert.equal(c.rows[0]?.scoreKind, "request_ignored");
});

test("a heard line writes no note when nothing changes", async () => {
  const c = relationsWithNotes();
  await askTheo(c);
  c.time.at += 1_000;
  c.relations.heardFrom("Theo");
  await until(() => c.relations.book.get("Theo")!.requests[0]?.heard === true);
  await new Promise((r) => setTimeout(r, 10));
  const saved = c.notes.length;
  c.relations.heardFrom("Theo");
  c.relations.heardFrom("Nobody");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(c.notes.length, saved);
  assert.equal(c.relations.book.get("Nobody"), null, "a stranger gets no record");
});

test("heardFrom while the ask's update is still queued marks it", async () => {
  const c = relationsWithClock();
  c.relations.book.load([newRelation("Theo", c.time.at, 0)]);
  c.time.at += 1_000;
  c.relations.asked(["Theo"], "4 coal", null, around({ Theo: 3 }));
  c.time.at += 1_000;
  c.relations.heardFrom("Theo");
  await until(() => c.relations.book.get("Theo")?.requests[0]?.heard === true);
});

test("a dropped heard request is logged and scores nothing", async () => {
  const c = relationsWithNotes();
  await askTheo(c);
  c.time.at += 1_000;
  c.relations.heardFrom("Theo");
  c.time.at += 3 * MIN;
  await c.look();
  await until(() => c.relations.book.get("Theo")!.requests.length === 0);
  assert.deepEqual(c.logs.filter((l) => l.includes("dropped")), ["request to Theo for 4 coal dropped: they spoke since"]);
  assert.equal(c.rows.length, 0);
});

test("heardFrom stamps the line at the time it was read, not when it is noted", async () => {
  const c = relationsWithClock();
  c.relations.book.load([newRelation("Theo", c.time.at, 0)]);
  const readAt = c.time.at + 500;
  c.time.at += 1_000;
  await askTheo(c);
  c.time.at += 1_000;
  c.relations.heardFrom("Theo", readAt);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(c.relations.book.get("Theo")!.requests[0]?.heard, false, "read before the ask");
});

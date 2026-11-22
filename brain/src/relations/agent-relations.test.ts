import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Body, INSTANT_TYPING } from "../body.ts";
import { BodyDown } from "../body-down.ts";
import { FakeRuntime, movedClocks, scriptedMind, testPersona, until } from "../testing.ts";
import { clockUntil } from "../agent/agent-fixtures.test.ts";
import { createFakeClock, type FakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import { AgentRelations, type AgentRelationsDeps } from "./agent-relations.ts";
import { EARLIER_GAIN_MS, EARLIER_GIVE_MS } from "./earlier.ts";
import { obeyChance } from "./obey.ts";
import { TradeBoard } from "./board.ts";
import { GIVE_OUTSIDE_TRADE } from "./order-refusal.ts";
import { newRelation, withTrade } from "./record.ts";
import type { RelationEvent } from "./types.ts";

/** A test on its own mocked clock: installed for the body (`using`) and gone when it returns; its waits and yields move that clock. */
function mockedTest(name: string, body: (timers: FakeClock) => void | Promise<void>): void {
  test(name, async () => {
    const timers = createFakeClock({ mode: "mocked" });
    using _timers = timers.install();
    await body(timers);
  });
}

function relationsWithClock(timers: FakeClock, over: Partial<AgentRelationsDeps> = {}) {
  const rows: RelationEvent[] = [];
  const runtime = new FakeRuntime();
  let statusCalls = 0;
  const status = runtime.status.bind(runtime);
  runtime.status = async () => { statusCalls += 1; return status(); };
  const clock = { now: () => time.at, sleep: async () => {} };
  const time = { at: 1_000_000 };
  const relations = new AgentRelations({
    persona: testPersona(), mind: scriptedMind().mind, runtime, body: {} as Body, takeHandoff: () => {},
    isAgent: () => false, lacks: () => [], journal: (event) => { if (event.kind === "relation") rows.push(event); }, log: () => {}, clock, monotonic: () => time.at,
    hearingRange: 32, isOnline: () => true, waitingFrom: () => false, obeyRandom: () => 0, ...over,
  });
  const look = async () => { relations.look(new Set(), new Set(), new AbortController().signal); await timers.advance(5); };
  return { relations, time, look, rows, calls: () => statusCalls, timers };
}

const MIN = 60_000;
const IRON_TRADE = { action: "accept" as const, give: [{ item: "bread", count: 5 }], get: [{ item: "iron_ingot", count: 5 }], first: "them" as const };

/** Relations over a runtime whose two clocks (the wall `Date.now` and the monotonic `performance.now`) are moved by hand: `time.offset` moves both, `clocks` each alone. */
function relationsOverTime(t: TestContext) {
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  const clocks = movedClocks(t);
  const time = clocks;
  /** Armed, the journal throws on the next `received` event: a tick that fails after it credited a payment. */
  const journal = { failOnReceived: false };
  const relations = new AgentRelations({
    persona: testPersona(), mind: scriptedMind().mind, runtime, body: {} as Body, takeHandoff: () => {},
    isAgent: () => false, lacks: () => [], log: (line) => logs.push(line), hearingRange: 32, isOnline: () => true, waitingFrom: () => false, obeyRandom: () => 0,
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
  return { relations, runtime, logs, time, clocks, journal, carry, look, trade, keptLines };
}

test("the earlier give window runs on the monotonic clock: a wall clock stepped back 2 s does not keep a give of 10 min ago", async (t) => {
  const h = relationsOverTime(t);
  await h.relations.trades.gaveOutside("Theo", "bread", 5);
  h.clocks.monotonic(EARLIER_GIVE_MS + 1_000);
  h.clocks.wall(-2_000);
  await h.relations.trades.onDecision({ ...IRON_TRADE, first: "me" }, "Theo", h.runtime.snapshot);
  assert.equal(h.trade()?.state, "agreed", "the give of 10 min ago is no credit of the new trade");
  assert.deepEqual(h.relations.trades.leftToGive(h.trade()!.id), [{ item: "bread", count: 5 }]);
});

test("a window closed by monotonic time stays closed when the wall clock is stepped back", async (t) => {
  const h = relationsOverTime(t);
  h.relations.trades.heardLine("Theo", Date.now(), 2);
  assert.equal(await h.look(), "ticked");
  h.clocks.monotonic(EARLIER_GAIN_MS + 1_000);
  h.clocks.wall(-2_000);
  assert.equal(await h.look(), "idle", "10 min of monotonic time are over");
});

test("the trade's times are wall times: an agreement written through the relations is a date of today, not a monotonic reading", async (t) => {
  const h = relationsOverTime(t);
  await h.relations.trades.onDecision(IRON_TRADE, "Theo", h.runtime.snapshot);
  assert.ok((h.trade()?.agreedAt ?? 0) > 1_700_000_000_000, `agreed at ${h.trade()?.agreedAt}`);
});

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

mockedTest("look() answers idle with nothing busy, busy_wait inside the throttle or while a tick runs, ticked otherwise", async (timers) => {
  const { relations, time, look } = relationsWithClock(timers);
  const signal = new AbortController().signal;
  assert.equal(relations.look(new Set(), new Set(), signal), "idle");
  relations.trades.heardLine("Theo", Date.now(), 2);
  assert.equal(relations.look(new Set(), new Set(), signal), "ticked");
  assert.equal(relations.look(new Set(), new Set(), signal), "busy_wait", "a tick is running");
  await timers.advance(5);
  assert.equal(relations.look(new Set(), new Set(), signal), "busy_wait", "inside the watch throttle");
  time.at += 2_000;
  assert.equal(relations.look(new Set(), new Set(), signal), "ticked");
  await look();
  assert.equal(relations.look(new Set(), new Set(), AbortSignal.abort()), "idle", "aborted");
});

mockedTest("with only a window open look() polls status at most every 2 s", async (timers) => {
  const { relations, time, look, calls } = relationsWithClock(timers);
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

mockedTest("a refusal heard scores the speaker", async (timers) => {
  const { relations, rows } = relationsWithClock(timers);
  relations.asked(["Theo"], "5 oak_log", null, around({ Theo: 3 }));
  await clockUntil(timers,() => relations.book.get("Theo")?.requests.length === 1);
  await relations.answered(refusal(), "Theo");
  const theo = relations.book.get("Theo")!;
  assert.deepEqual([theo.score, theo.requests, theo.ledger.map((e) => e.kind)], [-3, [], ["request_refused"]]);
  assert.deepEqual(rows.map((r) => [r.scoreKind, r.delta, r.score]), [["request_refused", -3, -3]]);
});

mockedTest("an answer that names no open request moves nothing", async (timers) => {
  const { relations, rows } = relationsWithClock(timers);
  await relations.answered(refusal(), "Theo");
  assert.equal(relations.book.get("Theo"), null, "no record is made for it");
  relations.asked(["Theo"], "bread", null, around({ Theo: 3 }));
  await clockUntil(timers,() => relations.book.get("Theo")?.requests.length === 1);
  await relations.answered(refusal(2), "Theo");
  assert.deepEqual([relations.book.get("Theo")?.requests.length, rows.length], [1, 0]);
});

mockedTest("an ignored request scores after 2 min with no brain tick in between", async (timers) => {
  const { relations, time, look, rows } = relationsWithClock(timers);
  relations.asked(["Theo"], "5 oak_log", null, around({ Theo: 3 }));
  await clockUntil(timers,() => relations.book.get("Theo")?.requests.length === 1);
  await look();
  time.at += 110_000;
  await look();
  assert.equal(relations.book.get("Theo")!.ledger.length, 0, "not yet");
  time.at += 10_000;
  await look();
  await clockUntil(timers,() => relations.book.get("Theo")!.ledger.length === 1);
  const theo = relations.book.get("Theo")!;
  assert.deepEqual([theo.requests, theo.ledger[0]?.kind, theo.ledger[0]?.why], [[], "request_ignored", "did not answer when you asked for 5 oak_log"]);
  assert.deepEqual(rows.map((r) => r.scoreKind), ["request_ignored"]);
  time.at += 10 * MIN;
  await look();
  assert.equal(relations.book.get("Theo")!.ledger.length, 1, "scored once");
});

mockedTest("the request check is throttled on the monotonic clock: the wall clock moving does not run it, 5 s of monotonic time does", async (timers) => {
  const mono = { at: 1_000 };
  const { relations, time, look, rows } = relationsWithClock(timers, { monotonic: () => mono.at });
  relations.asked(["Theo"], "5 oak_log", null, around({ Theo: 3 }));
  await clockUntil(timers,() => relations.book.get("Theo")?.requests.length === 1);
  await look();
  time.at += 3 * MIN;
  await look();
  assert.equal(rows.length, 0, "the check ran 0 s of monotonic time ago");
  mono.at += 4_000;
  await look();
  assert.equal(rows.length, 0, "the check ran 4 s of monotonic time ago, under its 5 s bound");
  mono.at += 5_000;
  await look();
  await clockUntil(timers,() => relations.book.get("Theo")!.ledger.length === 1);
  assert.deepEqual(rows.map((r) => r.scoreKind), ["request_ignored"]);
});

mockedTest("the first request check runs at once in a process whose monotonic reading is small", async (timers) => {
  const { relations, time, look, rows } = relationsWithClock(timers, { monotonic: () => 1_000 });
  relations.asked(["Theo"], "5 oak_log", null, around({ Theo: 3 }));
  await clockUntil(timers,() => relations.book.get("Theo")?.requests.length === 1);
  time.at += 3 * MIN;
  await look();
  await clockUntil(timers,() => relations.book.get("Theo")!.ledger.length === 1);
  assert.deepEqual(rows.map((r) => r.scoreKind), ["request_ignored"]);
});

mockedTest("the look of a watching bot is throttled on the monotonic clock: the wall clock moving does not poll the status", async (timers) => {
  const mono = { at: 1_000 };
  const { relations, time, look, calls } = relationsWithClock(timers, { monotonic: () => mono.at });
  relations.trades.heardLine("Theo", Date.now(), 2);
  await look();
  time.at += 5_000;
  await look();
  assert.equal(calls(), 1, "the wall clock moved 5 s, the monotonic one 0");
  mono.at += 2_000;
  await look();
  assert.equal(calls(), 2);
});

mockedTest("out of range is never ignored", async (timers) => {
  const { relations, time, look } = relationsWithClock(timers, { hearingRange: 32 });
  relations.asked(["Theo"], "bread", null, around({ Theo: 80 }));
  await clockUntil(timers,() => relations.book.get("Theo")?.requests.length === 1);
  assert.equal(relations.book.get("Theo")?.requests[0]?.inRange, false);
  await look();
  time.at += 10 * MIN;
  await look();
  await clockUntil(timers,() => relations.book.get("Theo")!.requests.length === 0);
  assert.equal(relations.book.get("Theo")!.ledger.length, 0);
});

mockedTest("whisper to an offline player is never ignored", async (timers) => {
  const online = new Set<string>();
  const { relations, time, look } = relationsWithClock(timers, { isOnline: (name) => online.has(name) });
  relations.book.load([newRelation("Zed", time.at, 0)]);
  relations.asked(["Zed"], "bread", "Zed", around({}));
  await clockUntil(timers,() => relations.book.get("Zed")?.requests.length === 1);
  assert.equal(relations.book.get("Zed")?.requests[0]?.inRange, false, "offline: nobody heard the whisper");
  relations.asked(["Theo"], "wool", "Theo", around({ Theo: null }));
  await clockUntil(timers,() => relations.book.get("Theo")?.requests.length === 1);
  assert.equal(relations.book.get("Theo")?.requests[0]?.inRange, true, "online but not loaded: a whisper reaches them");
  online.add("Zed");
  await look();
  time.at += 10 * MIN;
  await look();
  await clockUntil(timers,() => relations.book.get("Zed")!.requests.length === 0);
  assert.equal(relations.book.get("Zed")!.ledger.length, 0);
});

mockedTest("a name that is neither in the book nor online asks nothing", async (timers) => {
  const { relations } = relationsWithClock(timers);
  relations.asked(["Nobody", "Ayla"], "bread", null, around({}));
  await timers.advance(5);
  assert.deepEqual([relations.book.get("Nobody"), relations.book.get("Ayla")], [null, null]);
});

mockedTest("opening's asks_of opens a request", async (timers) => {
  const { relations } = relationsWithClock(timers);
  relations.forConversations().asked(["theo"], "iron_ingot", around({ Theo: 5 }));
  await clockUntil(timers,() => relations.book.get("Theo")?.requests.length === 1);
  assert.deepEqual(relations.book.get("Theo")?.requests.map((q) => [q.what, q.inRange, q.agreed]), [["iron_ingot", true, false]]);
});

mockedTest("a reply stuck in the model queue is not ignored", async (timers) => {
  let waiting = true;
  const { relations, time, look, rows } = relationsWithClock(timers, { waitingFrom: () => waiting });
  relations.asked(["Theo"], "5 oak_log", null, around({ Theo: 3 }));
  await clockUntil(timers,() => relations.book.get("Theo")?.requests.length === 1);
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

mockedTest("restart drops stale requests", (timers) => {
  const { relations, time } = relationsWithClock(timers);
  const stale = { ...newRelation("Theo", time.at - 10 * MIN, 0), requests: [{ what: "bread", at: time.at - 5 * MIN, inRange: true, agreed: false, heard: false }, { what: "wool", at: time.at - 1_000, inRange: true, agreed: false, heard: false }] };
  relations.load({ relations: [stale], skipped: 0 });
  assert.deepEqual(relations.book.get("Theo")?.requests.map((q) => q.what), ["wool"]);
  assert.equal(relations.book.get("Theo")?.ledger.length, 0);
});

mockedTest("the chat block shows the speaker's open requests, numbered", async (timers) => {
  const { relations, time } = relationsWithClock(timers);
  relations.asked(["Theo"], "5 oak_log", null, around({ Theo: 3 }));
  await clockUntil(timers,() => relations.book.get("Theo")?.requests.length === 1);
  time.at += 90_000;
  const block = relations.chatBlock("Theo", [], around({ Theo: 3 }));
  assert.deepEqual(block.requests, ["1. You asked Theo for 5 oak_log 1 min ago."]);
  assert.deepEqual(relations.chatBlock("Bruno", [], around({})).requests, []);
});

mockedTest("the relations block names the speaker once when the conversation lists them", (timers) => {
  const { relations } = relationsWithClock(timers);
  const summaries = (others: readonly string[]) => relations.chatBlock("Theo", others, around({ Theo: 3 })).block.split("\n").filter((line) => /^You (and|have not dealt with) Theo/u.test(line));
  assert.equal(summaries(["Theo", "Steve"]).length, 1, "the same name");
  assert.equal(summaries(["theo"]).length, 1, "another case");
  assert.equal(summaries(["Steve"]).length, 1);
});

mockedTest("a whisper makes only the one whispered to hear: the others it asks are out of range", async (timers) => {
  const { relations } = relationsWithClock(timers);
  relations.asked(["Ayla2", "Bob"], "bread", "Ayla2", around({ Ayla2: 2, Bob: 200 }));
  await clockUntil(timers,() => relations.book.get("Bob")?.requests.length === 1 && relations.book.get("Ayla2")?.requests.length === 1);
  assert.deepEqual([relations.book.get("Ayla2")?.requests[0]?.inRange, relations.book.get("Bob")?.requests[0]?.inRange], [true, false]);
});

mockedTest("an answer journals only its own scored row, not one another writer queued before it", async (timers) => {
  const { relations, rows } = relationsWithClock(timers);
  relations.asked(["Theo"], "bread", null, around({ Theo: 3 }));
  await clockUntil(timers,() => relations.book.get("Theo")?.requests.length === 1);
  rows.length = 0;
  void relations.book.score("Theo", { kind: "trade_done", why: "paid" });
  await relations.answered(refusal(), "Theo");
  assert.deepEqual(rows.map((r) => r.scoreKind), ["request_refused"]);
});

const hit = (attacker: string, direct: string | null = null, at = 0) => ({ attacker, direct, at });

mockedTest("hits debounced per attacker", async (timers) => {
  const { relations, time, rows } = relationsWithClock(timers);
  for (let i = 0; i < 10; i++) {
    relations.hurt(hit("Theo"));
    time.at += 400;
  }
  relations.hurt(hit("Ayla"));
  await clockUntil(timers,() => rows.length === 2);
  assert.deepEqual(rows.map((r) => [r.partner, r.scoreKind, r.delta]), [["Theo", "hurt", -25], ["Ayla", "hurt", -25]]);
  time.at += 61_000;
  relations.hurt(hit("Theo"));
  await clockUntil(timers,() => rows.length === 3);
  assert.deepEqual(rows.map((r) => r.partner), ["Theo", "Ayla", "Theo"]);
});

mockedTest("a hit inside the window writes nothing", async (timers) => {
  const runtime = new FakeRuntime();
  let queries = 0;
  const query = runtime.queryBotData.bind(runtime);
  runtime.queryBotData = async (sql) => { queries += 1; return query(sql); };
  const { relations, time, rows } = relationsWithClock(timers, { runtime });
  for (let i = 0; i < 10; i++) {
    relations.hurt(hit("Theo"));
    time.at += 400;
  }
  await clockUntil(timers,() => rows.length === 1);
  await timers.advance(20);
  assert.equal(queries, 0, "the first hit saves a new note; a rewrite would first look up and delete the old one");
});

mockedTest("a stranger hit is created at the first impression; the why names the weapon", async (timers) => {
  const { relations, rows } = relationsWithClock(timers);
  assert.equal(relations.book.get("Theo"), null);
  relations.hurt(hit("Theo"));
  relations.hurt(hit("Ayla", "arrow"));
  await clockUntil(timers,() => rows.length === 2);
  assert.deepEqual([relations.book.get("Theo")?.score, ...rows.map((r) => r.why)], [-25, "hit you", "shot you"]);
});

/** Relations whose notes really go through a body over a fake runtime, so the notes written can be counted. */
function relationsWithNotes(timers: FakeClock) {
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  const made = relationsWithClock(timers, { runtime, body: new Body(runtime, () => undefined, INSTANT_TYPING), log: (line) => logs.push(line) });
  return { ...made, notes: runtime.notes, logs };
}
const askTheo = async (c: ReturnType<typeof relationsWithClock>) => {
  c.relations.asked(["Theo"], "4 coal", null, around({ Theo: 3 }));
  await clockUntil(c.timers, () => c.relations.book.get("Theo")?.requests.length === 1);
};

mockedTest("a line from the asked partner stops the ignored score", async (timers) => {
  const c = relationsWithClock(timers);
  await askTheo(c);
  c.time.at += 10_000;
  c.relations.heardFrom("Theo");
  c.time.at += 3 * MIN;
  await c.look();
  await clockUntil(timers,() => c.relations.book.get("Theo")!.requests.length === 0);
  assert.deepEqual([c.rows.length, c.relations.book.get("Theo")!.ledger.length], [0, 0]);
});

mockedTest("a line from someone else does not stop it", async (timers) => {
  const c = relationsWithClock(timers);
  await askTheo(c);
  c.time.at += 10_000;
  c.relations.heardFrom("Ayla");
  c.time.at += 3 * MIN;
  await c.look();
  await clockUntil(timers,() => c.rows.length === 1);
  assert.equal(c.rows[0]?.scoreKind, "request_ignored");
});

mockedTest("a line read before the ask does not count", async (timers) => {
  const c = relationsWithClock(timers);
  c.relations.book.load([newRelation("Theo", c.time.at, 0)]);
  c.relations.heardFrom("Theo");
  c.time.at += 1_000;
  await askTheo(c);
  c.time.at += 3 * MIN;
  await c.look();
  await clockUntil(timers,() => c.rows.length === 1);
  assert.equal(c.rows[0]?.scoreKind, "request_ignored");
});

mockedTest("a heard line writes no note when nothing changes", async (timers) => {
  const c = relationsWithNotes(timers);
  await askTheo(c);
  c.time.at += 1_000;
  c.relations.heardFrom("Theo");
  await clockUntil(timers,() => c.relations.book.get("Theo")!.requests[0]?.heard === true);
  await timers.advance(10);
  const saved = c.notes.length;
  c.relations.heardFrom("Theo");
  c.relations.heardFrom("Nobody");
  await timers.advance(10);
  assert.equal(c.notes.length, saved);
  assert.equal(c.relations.book.get("Nobody"), null, "a stranger gets no record");
});

mockedTest("heardFrom while the ask's update is still queued marks it", async (timers) => {
  const c = relationsWithClock(timers);
  c.relations.book.load([newRelation("Theo", c.time.at, 0)]);
  c.time.at += 1_000;
  c.relations.asked(["Theo"], "4 coal", null, around({ Theo: 3 }));
  c.time.at += 1_000;
  c.relations.heardFrom("Theo");
  await clockUntil(timers,() => c.relations.book.get("Theo")?.requests[0]?.heard === true);
});

mockedTest("a dropped heard request is logged and scores nothing", async (timers) => {
  const c = relationsWithNotes(timers);
  await askTheo(c);
  c.time.at += 1_000;
  c.relations.heardFrom("Theo");
  c.time.at += 3 * MIN;
  await c.look();
  await clockUntil(timers,() => c.relations.book.get("Theo")!.requests.length === 0);
  assert.deepEqual(c.logs.filter((l) => l.includes("dropped")), ["request to Theo for 4 coal dropped: they spoke since"]);
  assert.equal(c.rows.length, 0);
});

mockedTest("heardFrom stamps the line at the time it was read, not when it is noted", async (timers) => {
  const c = relationsWithClock(timers);
  c.relations.book.load([newRelation("Theo", c.time.at, 0)]);
  const readAt = c.time.at + 500;
  c.time.at += 1_000;
  await askTheo(c);
  c.time.at += 1_000;
  c.relations.heardFrom("Theo", readAt);
  await timers.advance(10);
  assert.equal(c.relations.book.get("Theo")!.requests[0]?.heard, false, "read before the ask");
});

const MOOD_LINE = /You don't feel like doing what Bruno asks right now \(you rate them -15\)\./u;

/** Relations that rate Bruno at `score`, rolling with the given sequence of random numbers. */
function relationsRating(timers: FakeClock, score: number, rolls: number[], over: Partial<AgentRelationsDeps> = {}) {
  const h = relationsWithClock(timers, { obeyRandom: () => rolls.shift() ?? 0, ...over });
  h.relations.load({ relations: [newRelation("Bruno", h.time.at, score)], skipped: 0 });
  return { ...h, rolls };
}

mockedTest("the chat block tells the model it does not feel like obeying when the roll says no, and not when it says yes", (timers) => {
  const no = relationsRating(timers,-15, [0.99]);
  assert.match(no.relations.chatBlock("Bruno", [], around({ Bruno: 2 })).block, MOOD_LINE);
  assert.deepEqual(no.relations.obeys("Bruno"), { obeys: false, chance: obeyChance(-15, -4, 4), score: -15 });
  const yes = relationsRating(timers,-15, [0]);
  assert.doesNotMatch(yes.relations.chatBlock("Bruno", [], around({ Bruno: 2 })).block, /don't feel like/u);
  assert.equal(yes.relations.obeys("Bruno")?.obeys, true);
});

mockedTest("a retry of the chat call inside the mood window reuses the roll, and the line shows the score as it is now", async (timers) => {
  const h = relationsRating(timers,-15, [0.99, 0]);
  h.relations.chatBlock("Bruno", [], around({ Bruno: 2 }));
  await h.relations.book.update("Bruno", (r) => ({ ...r, score: -7 }));
  const again = h.relations.chatBlock("Bruno", [], around({ Bruno: 2 })).block;
  assert.match(again, /you rate them -7\)/u);
  assert.deepEqual(h.rolls, [0], "the second roll was never drawn");
});

mockedTest("obeys reads the stored roll after the window ran out, and answers null before any", (timers) => {
  const h = relationsRating(timers,-15, [0.99]);
  assert.equal(h.relations.obeys("Bruno"), null);
  h.relations.chatBlock("Bruno", [], around({ Bruno: 2 }));
  h.time.at += 30 * MIN;
  assert.equal(h.relations.obeys("Bruno")?.obeys, false);
});

mockedTest("the score that is rolled has drifted back with forgiveness", (timers) => {
  const h = relationsRating(timers,-30, [0.5]);
  h.time.at += 3_600_000 * 5;
  h.relations.chatBlock("Bruno", [], around({ Bruno: 2 }));
  assert.equal(h.relations.obeys("Bruno")?.score, -5);
});

mockedTest("a speaker with no record is rolled at the first impression, a player and a bot alike", (timers) => {
  for (const isAgent of [false, true]) {
    const h = relationsWithClock(timers, { obeyRandom: () => 0.99, isAgent: () => isAgent });
    h.relations.chatBlock("Steve", [], around({ Steve: 1 }));
    assert.deepEqual([h.relations.obeys("Steve")?.score, h.relations.obeys("Steve")?.obeys], [0, false]);
  }
});

mockedTest("the chat block keeps the id of the offer the speaker made me", (timers) => {
  const board = new TradeBoard();
  const h = relationsRating(timers,0, [], { board });
  assert.equal(h.relations.chatBlock("Bruno", [], around({ Bruno: 2 })).seenOfferId, undefined);
  board.post({ id: "Bruno-Ayla-1", proposer: "Bruno", partner: "Ayla", give: [{ item: "bread", count: 1 }], get: [], first: "me", postedAt: 1 });
  assert.equal(h.relations.chatBlock("Bruno", [], around({ Bruno: 2 })).seenOfferId, "Bruno-Ayla-1");
});

mockedTest("tradeOpenWith names my open trade, else a board offer either way, else null", async (timers) => {
  const board = new TradeBoard();
  const h = relationsRating(timers,0, [], { board });
  assert.equal(h.relations.tradeOpenWith("Bruno"), null);
  board.post({ id: "Bruno-Ayla-1", proposer: "Bruno", partner: "Ayla", give: [], get: [], first: "me", postedAt: 1 });
  assert.equal(h.relations.tradeOpenWith("bruno"), "Bruno-Ayla-1");
  board.withdraw("Bruno-Ayla-1");
  board.post({ id: "Ayla-Bruno-2", proposer: "Ayla", partner: "Bruno", give: [], get: [], first: "me", postedAt: 2 });
  assert.equal(h.relations.tradeOpenWith("Bruno"), "Ayla-Bruno-2");
  board.withdraw("Ayla-Bruno-2");
  await h.relations.trades.onDecision({ action: "propose", give: [{ item: "bread", count: 1 }], get: [], first: "me" }, "Bruno", around({ Bruno: 2 }));
  assert.equal(h.relations.tradeOpenWith("Bruno"), h.relations.book.get("Bruno")?.trades.at(-1)?.id);
});

mockedTest("decided closes only the offer the line read: an accept of a replaced offer is refused, of the same one agreed", async (timers) => {
  const board = new TradeBoard();
  const h = relationsRating(timers,0, [], { board });
  const offer = { id: "Bruno-Ayla-1", proposer: "Bruno", partner: "Ayla", give: [{ item: "iron_ingot", count: 1 }], get: [{ item: "bread", count: 1 }], first: "me" as const, postedAt: 1 };
  const accept = { say: "ok", route: "talk" as const, request: "", trade: { action: "accept" as const, give: [], get: [], first: "them" as const } };
  board.post(offer);
  assert.equal(await h.relations.decided(accept, "Bruno", around({ Bruno: 2 }), { heardAt: 5, seenOfferId: "Bruno-Ayla-2" }), null, "the line read another offer");
  assert.equal(h.relations.book.get("Bruno")?.trades.length ?? 0, 0);
  assert.equal(await h.relations.decided(accept, "Bruno", around({ Bruno: 2 }), { heardAt: 5, seenOfferId: "Bruno-Ayla-1" }), "Bruno-Ayla-1");
  assert.equal(h.relations.book.get("Bruno")?.trades.at(-1)?.state, "agreed");
});

mockedTest("decided passes the spoken line on: a proposal whose words give another number than the terms logs it", async (timers) => {
  const logs: string[] = [];
  const h = relationsRating(timers,0, [], { log: (line) => logs.push(line) });
  const propose = { say: "Bruno, 16 bread for 3 iron ingots?", route: "talk" as const, request: "", trade: { action: "propose" as const, give: [{ item: "bread", count: 1 }], get: [{ item: "iron_ingot", count: 3 }], first: "me" as const } };
  assert.notEqual(await h.relations.decided(propose, "Bruno", around({ Bruno: 2 }), { heardAt: 5 }), null);
  assert.ok(logs.includes("trade: terms differ from the words: bread 1 in terms, 16 in the line"), logs.join("\n"));
});

mockedTest("offerStillStands: only the offer that was read, and only when one was read", (timers) => {
  const board = new TradeBoard();
  const h = relationsRating(timers,0, [], { board });
  board.post({ id: "Bruno-Ayla-1", proposer: "Bruno", partner: "Ayla", give: [], get: [], first: "me", postedAt: 1 });
  assert.deepEqual([h.relations.offerStillStands("Bruno", "Bruno-Ayla-1"), h.relations.offerStillStands("Bruno", "Bruno-Ayla-2"), h.relations.offerStillStands("Bruno", undefined)], [true, false, false]);
  board.withdraw("Bruno-Ayla-1");
  assert.equal(h.relations.offerStillStands("Bruno", "Bruno-Ayla-1"), false);
});

mockedTest("the rating is the drifted score, the first impression for a stranger", (timers) => {
  const h = relationsRating(timers,-30, [0.5]);
  assert.equal(h.relations.rating("Bruno"), -30);
  assert.equal(h.relations.rating("Nobody"), 0);
});

mockedTest("a trade the checks refuse is dropped and the decision says so, whether the re-answer keeps it or leaves it out", async (timers) => {
  const first = { say: "Here.", route: "act" as const, request: "give bread", trade: { action: "propose" as const, give: [{ item: "bread", count: 5 }], get: [], first: "me" as const } };
  const snapshot = { ...new FakeRuntime().snapshot, inventory: [] };
  const input = { persona: testPersona(), message: { username: "Bruno", channel: "chat" as const, message: "give me bread", addressed: true }, history: [], snapshot, activity: "idle", places: [], areas: [], relations: { block: "", tradeOn: true } };
  for (const second of [first, { say: "No.", route: "act" as const, request: "give bread" }]) {
    const { chat, mind } = scriptedMind();
    chat.reply(second);
    const h = relationsWithClock(timers, { mind });
    const { decision: out } = await h.relations.checkedTrade(first, input, { speaker: "Bruno", heardAt: Date.now(), snapshot, signal: new AbortController().signal });
    assert.deepEqual([out.trade, out.tradeDropped, out.route], [undefined, true, "act"]);
  }
});

const TABLE_TRADE = { action: "accept" as const, give: [{ item: "crafting_table", count: 1 }], get: [{ item: "iron_ingot", count: 1 }], first: "me" as const };

/** An agreed give of a crafting_table that is no longer carried (s3i), the planks to make it again, and a real body to run the hand-off with. */
async function tableOwedAndGone(t: TestContext) {
  const h = relationsOverTime(t);
  h.runtime.recipes = { crafting_table: { makes: 1, needs: [{ item: "oak_planks", count: 4 }] } };
  h.runtime.simulateInventory = true;
  h.runtime.walkOnNavigate = true;
  h.runtime.snapshot = { ...h.runtime.snapshot, inventory: [{ name: "crafting_table", count: 1 }], players: [{ username: "Theo", position: { x: 2, y: 64, z: 0 } }] };
  await h.relations.trades.onDecision(TABLE_TRADE, "Theo", h.runtime.snapshot);
  h.runtime.snapshot = { ...h.runtime.snapshot, inventory: [{ name: "oak_planks", count: 8 }] };
  const give = { kind: "give" as const, tradeId: h.trade()!.id, partner: "Theo", items: TABLE_TRADE.give };
  const context = { runtime: h.runtime, body: new Body(h.runtime, () => undefined), signal: new AbortController().signal };
  return { ...h, give, context, crafted: () => h.runtime.submitted.filter((call) => call.tool === "craft_item") };
}

test("a give whose owed item is gone gets it back through the agent's hand-off, and the context lists what the trades owe", async (t) => {
  const h = await tableOwedAndGone(t);
  assert.deepEqual(h.relations.trades.owed().map((o) => [o.item, o.count, o.partner]), [["crafting_table", 1, "Theo"]]);
  const end = await h.relations.runHandoff(h.give, h.context);
  assert.equal(end.outcome, "done");
  assert.equal(h.crafted().length, 1);
});

test("a get-back keeps a minute of the trade's clock for the give: with less left it is not tried at all", async (t) => {
  const h = await tableOwedAndGone(t);
  h.runtime.durations.craft_item = 10_000;
  h.time.offset += 9.5 * MIN;
  const end = await h.relations.runHandoff(h.give, h.context);
  assert.equal(end.outcome, "items_gone");
  assert.match(end.detail, /clock ran out/u);
  assert.equal(h.runtime.submitted.some((call) => call.tool === "drop_item"), false);
});

test("a give met by a body the supervisor keeps down is not a failed give: the hand-off throws and the trade stays open", async (t) => {
  const h = await tableOwedAndGone(t);
  const submit = h.runtime.submit.bind(h.runtime);
  let asked = false;
  h.runtime.submit = async (tool, input) => {
    if (tool !== "craft_item") return submit(tool, input);
    asked = true;
    throw new BodyDown(null, new Error("[RUNTIME_UNRESPONSIVE] Runtime event-loop heartbeat absent"));
  };
  await assert.rejects(h.relations.runHandoff(h.give, h.context), BodyDown);
  assert.ok(asked, "the body was asked to get the item back");
  assert.equal(h.relations.trades.closedAs(h.give.tradeId), null, "no failed give is counted against the trade");
});

test("a wait for the partner's side whose walk to them meets a body the supervisor keeps down throws it, and the wait is not ended", async (t) => {
  const h = relationsOverTime(t);
  const theirs = { action: "accept" as const, give: [{ item: "bread", count: 5 }], get: [{ item: "iron_ingot", count: 5 }], first: "them" as const };
  await h.relations.trades.onDecision(theirs, "Theo", h.runtime.snapshot);
  const id = h.trade()!.id;
  h.runtime.snapshot = { ...h.runtime.snapshot, players: [{ username: "Theo", position: { x: 60, y: 64, z: 0 } }] };
  h.runtime.submit = async () => {
    throw new BodyDown(null, new Error("[RUNTIME_UNRESPONSIVE] Runtime event-loop heartbeat absent"));
  };
  const context = { runtime: h.runtime, body: new Body(h.runtime, () => undefined), signal: new AbortController().signal };
  await assert.rejects(h.relations.runHandoff({ kind: "await", tradeId: id, partner: "Theo" }, context), BodyDown);
  assert.equal(h.relations.trades.awaits(id), true, "the trade still waits for their side");
});

test("B3: a wait for the partner's side whose trade I cancelled ends failed and says how it ended", async (t) => {
  const h = relationsOverTime(t);
  const theirs = { action: "accept" as const, give: [{ item: "bread", count: 5 }], get: [{ item: "iron_ingot", count: 5 }], first: "them" as const };
  await h.relations.trades.onDecision(theirs, "Theo", h.runtime.snapshot);
  const id = h.trade()!.id;
  await h.relations.trades.onDecision({ ...theirs, action: "cancel" }, "Theo", h.runtime.snapshot);
  const context = { runtime: h.runtime, body: new Body(h.runtime, () => undefined), signal: new AbortController().signal };
  const end = await h.relations.runHandoff({ kind: "await", tradeId: id, partner: "Theo" }, context);
  assert.equal(end.outcome, "failed");
  assert.match(end.detail, /the trade ended \(cancelled: I cancelled\) before Theo gave/u);
});

/** An agreed trade with Theo in which I give 5 bread (and get 5 iron ingots), and the refusal text `giveOutsideTrade` gives for it. */
async function agreedBreadTrade(t: TestContext) {
  const h = relationsOverTime(t);
  await h.relations.trades.onDecision({ ...IRON_TRADE, first: "me" }, "Theo", h.runtime.snapshot);
  const open = (extra = "") => `${GIVE_OUTSIDE_TRADE} not given: Theo and I have trade ${h.trade()!.id} open; its hand-off is how items move between us${extra}`;
  return { ...h, open };
}

const CAME_TO_NOTHING = `${GIVE_OUTSIDE_TRADE} not given: the trade Theo spoke of with this order came to nothing; a give outside a trade is no part of it`;

test("giveOutsideTrade lets a give the agreed trade still owes run", async (t) => {
  const h = await agreedBreadTrade(t);
  assert.equal(h.relations.giveOutsideTrade("Theo", "bread", 5, false), null);
  assert.equal(h.relations.giveOutsideTrade("theo", "bread", 3, true), null, "another case of the name, and the came-to-nothing mark: the agreed trade counts the give");
});

test("giveOutsideTrade refuses more than the agreed trade owes", async (t) => {
  const h = await agreedBreadTrade(t);
  assert.equal(h.relations.giveOutsideTrade("Theo", "bread", 20, false), h.open(", which owes 5 bread more"));
});

test("giveOutsideTrade refuses once the side was credited", async (t) => {
  const h = await agreedBreadTrade(t);
  await h.relations.trades.gaveOutside("Theo", "bread", 5);
  assert.equal(h.relations.giveOutsideTrade("Theo", "bread", 1, false), h.open());
});

test("giveOutsideTrade refuses an item the trade does not owe", async (t) => {
  const h = await agreedBreadTrade(t);
  assert.equal(h.relations.giveOutsideTrade("Theo", "oak_log", 1, false), h.open());
});

test("giveOutsideTrade refuses a give before a proposal is agreed", async (t) => {
  const h = relationsOverTime(t);
  await h.relations.trades.onDecision({ action: "propose", give: [{ item: "bread", count: 5 }], get: [], first: "me" }, "Theo", h.runtime.snapshot);
  assert.equal(h.trade()?.state, "proposed");
  assert.equal(h.relations.giveOutsideTrade("Theo", "bread", 5, false), `${GIVE_OUTSIDE_TRADE} not given: Theo and I have trade ${h.trade()!.id} open; its hand-off is how items move between us`);
});

mockedTest("giveOutsideTrade refuses while only the speaker's board offer stands", (timers) => {
  const board = new TradeBoard();
  const h = relationsWithClock(timers, { board });
  board.post({ id: "Theo-Ayla-1", proposer: "Theo", partner: "Ayla", give: [{ item: "bread", count: 5 }], get: [], first: "me", postedAt: 1 });
  assert.equal(h.relations.giveOutsideTrade("Theo", "bread", 5, false), `${GIVE_OUTSIDE_TRADE} not given: Theo and I have trade Theo-Ayla-1 open; its hand-off is how items move between us`);
});

test("giveOutsideTrade lets a held trade's awaited item go", async (t) => {
  const h = relationsOverTime(t);
  await h.relations.trades.onDecision({ ...IRON_TRADE, first: "me" }, "Theo", h.runtime.snapshot);
  const agreed = h.trade()!;
  // Their iron was credited, then my give failed: the trade ended with my side not given and their payment held.
  await h.relations.book.update("Theo", (r) => withTrade(r, { ...agreed, state: "broken", brokenBy: "me", received: [{ item: "iron_ingot", count: 5 }], endedAt: Date.now() }));
  assert.equal(h.relations.tradeOpenWith("Theo"), null);
  assert.equal(h.relations.giveOutsideTrade("Theo", "bread", 5, false), null, "my own side, paid late");
  assert.equal(h.relations.giveOutsideTrade("Theo", "iron_ingot", 5, false), null, "their payment, given back");
  assert.equal(h.relations.giveOutsideTrade("Theo", "oak_log", 1, true), CAME_TO_NOTHING, "an item no held trade awaits is no part of it");
});

mockedTest("giveOutsideTrade marks a give after a line's trade came to nothing", (timers) => {
  const h = relationsWithClock(timers);
  assert.equal(h.relations.giveOutsideTrade("Theo", "bread", 1, false), null);
  assert.equal(h.relations.giveOutsideTrade("Theo", "bread", 1, true), CAME_TO_NOTHING);
});

test("giveOutsideTrade lets a give run once the trade is done", async (t) => {
  const h = await agreedBreadTrade(t);
  await h.relations.book.update("Theo", (r) => withTrade(r, { ...h.trade()!, state: "done", endedAt: Date.now() }));
  assert.equal(h.relations.giveOutsideTrade("Theo", "bread", 5, false), null);
  assert.equal(h.relations.giveOutsideTrade("Theo", "bread", 5, true), CAME_TO_NOTHING, "the mark alone keeps a give refused once nothing counts it");
});

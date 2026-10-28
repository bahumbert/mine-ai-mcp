import assert from "node:assert/strict";
import test from "node:test";
import type { Memory } from "../memory.ts";
import { testScoring } from "../testing.ts";
import { RelationBook } from "./book.ts";
import { newRelation } from "./record.ts";

const t0 = 1_000_000;

function makeBook() {
  const calls: string[] = [];
  const saved: Memory[] = [];
  let gate: Promise<void> = Promise.resolve();
  const book = new RelationBook({
    save: async (memory) => { await gate; calls.push("save"); saved.push(memory); },
    remove: async (context) => { await gate; calls.push(`remove ${context}`); },
    now: () => t0,
    log: () => {},
    scoring: testScoring(),
  });
  return { book, calls, saved, hold: (g: Promise<void>) => { gate = g; } };
}

test("update saves once and replaces the old note", async () => {
  const { book, calls, saved } = makeBook();
  book.load([{ ...newRelation("Theo", t0, 0), score: 10 }]);
  const next = await book.update("Theo", (r) => ({ ...r, score: 20 }));
  assert.equal(next.score, 20);
  assert.deepEqual(calls, ["remove relation:Theo", "save"]);
  assert.equal(saved.length, 1);
  assert.equal(book.get("Theo")?.score, 20);
});

test("a first update of a stranger saves without removing", async () => {
  const { book, calls } = makeBook();
  await book.update("Theo", (r) => r);
  assert.deepEqual(calls, ["save"]);
});

test("two updates of one partner at once are applied in order", async () => {
  const { book, saved, hold } = makeBook();
  let release = () => {};
  hold(new Promise<void>((resolve) => { release = resolve; }));
  const a = book.update("Theo", (r) => ({ ...r, score: 1 }));
  const b = book.update("Theo", (r) => ({ ...r, score: r.score * 10 }));
  release();
  await Promise.all([a, b]);
  assert.equal(saved.length, 2);
  assert.equal(book.get("Theo")?.score, 10);
});

test("get ignores case", () => {
  const { book } = makeBook();
  book.load([newRelation("Theo", t0, 0)]);
  assert.equal(book.get("tHEO")?.partner, "Theo");
  assert.equal(book.get("Bruno"), null);
});

test("a failed save is logged, keeps the record in memory and the next update saves again", async () => {
  const lines: string[] = [];
  let fail = true;
  const book = new RelationBook({ save: async () => { if (fail) throw new Error("down"); }, remove: async () => {}, now: () => t0, log: (l) => lines.push(l), scoring: testScoring() });
  book.load([newRelation("Theo", t0, 0)]);
  const r = await book.update("Theo", (x) => ({ ...x, score: 7 }));
  assert.equal(r.score, 7);
  assert.equal(book.get("Theo")?.score, 7);
  assert.match(lines.join("\n"), /could not save/u);
  fail = false;
  await book.update("Theo", (x) => x);
});

test("openTrades and summaries read the records", async () => {
  const { book } = makeBook();
  assert.deepEqual(book.openTrades(), []);
  assert.deepEqual(book.summaries(["Theo"]), ["You have not dealt with Theo before; your first impression is that you have no strong feeling about Theo."]);
});

test("score creates a stranger at the first impression then applies the event", async () => {
  const { book, saved } = makeBook();
  const friendly = new RelationBook({ save: async (m) => { saved.push(m); }, remove: async () => {}, now: () => t0, log: () => {}, scoring: { ...book.scoring, temperament: { ...book.scoring.temperament, firstImpression: 10 } } });
  const r = await friendly.score("Theo", { kind: "trade_done", why: "paid" });
  assert.deepEqual([r.score, r.ledger.map((e) => e.delta), r.scoredAt], [18, [8], t0]);
  assert.equal(friendly.get("theo")?.score, 18);
  assert.equal(saved.length, 1);
});

test("two scores on one partner are serialised", async () => {
  const { book, saved, hold } = makeBook();
  let release = () => {};
  hold(new Promise<void>((resolve) => { release = resolve; }));
  const a = book.score("Theo", { kind: "trade_done", why: "a" });
  const b = book.score("Theo", { kind: "hurt", why: "b" });
  release();
  await Promise.all([a, b]);
  assert.equal(saved.length, 2);
  assert.deepEqual(book.get("Theo")?.ledger.map((e) => e.why), ["a", "b"]);
  assert.equal(book.get("Theo")?.score, -17);
});

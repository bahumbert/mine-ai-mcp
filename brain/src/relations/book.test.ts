import assert from "node:assert/strict";
import test from "node:test";
import type { Memory } from "../memory.ts";
import { RelationBook } from "./book.ts";
import { newRelation, withFeeling } from "./record.ts";

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
  });
  return { book, calls, saved, hold: (g: Promise<void>) => { gate = g; } };
}

test("update saves once and replaces the old note", async () => {
  const { book, calls, saved } = makeBook();
  book.load([withFeeling(newRelation("Theo", t0), { feeling: 1, word: "friend", why: "x" })]);
  const next = await book.update("Theo", (r) => withFeeling(r, { feeling: 2, word: "pal", why: "y" }));
  assert.equal(next.feeling, 2);
  assert.deepEqual(calls, ["remove relation:Theo", "save"]);
  assert.equal(saved.length, 1);
  assert.equal(book.get("Theo")?.word, "pal");
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
  const a = book.update("Theo", (r) => ({ ...r, word: "first" }));
  const b = book.update("Theo", (r) => ({ ...r, why: `after ${r.word}` }));
  release();
  await Promise.all([a, b]);
  assert.equal(saved.length, 2);
  assert.deepEqual([book.get("Theo")?.word, book.get("Theo")?.why], ["first", "after first"]);
});

test("get ignores case", () => {
  const { book } = makeBook();
  book.load([newRelation("Theo", t0)]);
  assert.equal(book.get("tHEO")?.partner, "Theo");
  assert.equal(book.get("Bruno"), null);
});

test("a failed save is logged, keeps the record in memory and the next update saves again", async () => {
  const lines: string[] = [];
  let fail = true;
  const book = new RelationBook({ save: async () => { if (fail) throw new Error("down"); }, remove: async () => {}, now: () => t0, log: (l) => lines.push(l) });
  book.load([newRelation("Theo", t0)]);
  const r = await book.update("Theo", (x) => ({ ...x, word: "kept" }));
  assert.equal(r.word, "kept");
  assert.equal(book.get("Theo")?.word, "kept");
  assert.match(lines.join("\n"), /could not save/u);
  fail = false;
  await book.update("Theo", (x) => x);
});

test("openTrades and summaries read the records", async () => {
  const { book } = makeBook();
  assert.deepEqual(book.openTrades(), []);
  assert.deepEqual(book.summaries(["Theo"]), ["You have not dealt with Theo before."]);
});

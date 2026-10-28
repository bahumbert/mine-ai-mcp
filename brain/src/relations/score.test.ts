import assert from "node:assert/strict";
import test from "node:test";
import { testPersona } from "../testing.ts";
import { newRelation } from "./record.ts";
import { band, drifted, scoredRow, withScoreEvent } from "./score.ts";
import type { Relation, Scoring } from "./types.ts";

const H = 3_600_000;
const MIN = 60_000;
const t0 = 10_000_000;

function scoringOf(temperament: Partial<Scoring["temperament"]> = {}, score: Partial<Scoring["score"]> = {}): Scoring {
  const { relations } = testPersona().settings;
  return { score: { ...relations.score, ...score }, temperament: { ...relations.temperament, ...temperament } };
}

const at = (score: number, firstImpression = 0): Relation => ({ ...newRelation("Theo", t0, firstImpression), score });

test("drift with no event", () => {
  const { temperament } = scoringOf();
  assert.equal(drifted(at(-40), t0 + 4 * H, temperament).score, -20);
  assert.equal(drifted(at(-40), t0 + 100 * H, temperament).score, 0);
  assert.equal(drifted(at(30, 10), t0 + 2 * H, scoringOf({ firstImpression: 10 }).temperament).score, 20);
  assert.equal(drifted(at(-40), t0 + 4 * H, temperament).scoredAt, t0 + 4 * H);
});

test("drift with forgiveness 0 keeps the score", () => {
  assert.equal(drifted(at(-40), t0 + 50 * H, scoringOf({ forgiveness: 0 }).temperament).score, -40);
});

test("a clock going back keeps the score and the time", () => {
  const r = drifted(at(-40), t0 - H, scoringOf().temperament);
  assert.equal(r.score, -40);
  assert.equal(r.scoredAt, t0);
});

test("drift survives frequent events", () => {
  const s = scoringOf();
  let r = at(-40);
  for (let i = 1; i <= 24; i += 1) r = withScoreEvent(r, { kind: "nudge", nudge: 0, why: "chat" }, t0 + i * 5 * MIN, s);
  assert.ok(Math.abs(r.score - -30) < 1e-9, `score ${r.score}`);
});

test("event scaled and clamped", () => {
  const touchy = withScoreEvent(at(0), { kind: "promise_broken", why: "x" }, t0, scoringOf({ sensitivity: 1.4 }));
  assert.equal(touchy.ledger.at(-1)?.delta, -28);
  assert.equal(touchy.score, -28);
  const floor = withScoreEvent(at(-90), { kind: "hurt", why: "hit you" }, t0, scoringOf());
  assert.equal(floor.score, -100);
  assert.equal(floor.ledger.at(-1)?.delta, -10);
  const ceiling = withScoreEvent(at(100), { kind: "gift_received", why: "gift" }, t0, scoringOf());
  assert.equal(ceiling.score, 100);
  assert.equal(ceiling.ledger.length, 1);
  assert.equal(ceiling.ledger[0]?.delta, 0);
});

test("rounds to zero without a negative zero", () => {
  const s = scoringOf({ sensitivity: 0.2 });
  const up = withScoreEvent(at(0), { kind: "nudge", nudge: 1, why: "ok" }, t0, s);
  assert.ok(Object.is(up.ledger[0]?.delta, 0));
  const down = withScoreEvent(at(0), { kind: "nudge", nudge: -1, why: "ok" }, t0, s);
  assert.ok(Object.is(down.ledger[0]?.delta, 0));
  assert.ok(Object.is(down.score, 0));
});

test("nudge clamped; a nudge that is not a number moves nothing", () => {
  const s = scoringOf();
  assert.equal(withScoreEvent(at(0), { kind: "nudge", nudge: 40, why: "great" }, t0, s).ledger[0]?.delta, 10);
  const r = at(5);
  const same = withScoreEvent(r, { kind: "nudge", nudge: Number.NaN, why: "?" }, t0 + MIN, s);
  assert.equal(same.score, 5);
  assert.equal(same.ledger.length, 0);
});

test("ledger trimmed to the newest, newest last", () => {
  const s = scoringOf();
  let r = at(0);
  for (let i = 1; i <= 12; i += 1) r = withScoreEvent(r, { kind: "nudge", nudge: 1, why: `n${i}` }, t0 + i, s);
  assert.equal(r.ledger.length, 10);
  assert.deepEqual([r.ledger[0]?.why, r.ledger.at(-1)?.why], ["n3", "n12"]);
});

test("late payment nets keptLate", () => {
  const s = scoringOf();
  const broken = withScoreEvent(at(0), { kind: "promise_broken", why: "did not pay", tradeId: "t1" }, t0, s);
  assert.equal(broken.score, -20);
  const paid = withScoreEvent(broken, { kind: "kept_late", why: "paid late", tradeId: "t1" }, t0, s);
  assert.equal(paid.ledger.at(-1)?.delta, 23);
  assert.equal(paid.score, 3);
  const clamped = withScoreEvent(at(-95), { kind: "promise_broken", why: "x", tradeId: "t2" }, t0, s);
  assert.equal(clamped.ledger.at(-1)?.delta, -5);
  const takenBack = withScoreEvent(clamped, { kind: "kept_late", why: "y", tradeId: "t2" }, t0, s);
  assert.equal(takenBack.ledger.at(-1)?.delta, 8);
});

test("late payment after the penalty faded", () => {
  const s = scoringOf();
  const broken = withScoreEvent(at(0), { kind: "promise_broken", why: "x", tradeId: "t1" }, t0, s);
  const paid = withScoreEvent(broken, { kind: "kept_late", why: "y", tradeId: "t1" }, t0 + 4 * H, s);
  assert.equal(paid.ledger.at(-1)?.delta, 3);
  assert.equal(paid.score, 3);
  const none = withScoreEvent(at(0), { kind: "kept_late", why: "y", tradeId: "gone" }, t0, s);
  assert.equal(none.ledger.at(-1)?.delta, 3);
});

test("bands", () => {
  const { bands } = scoringOf().score;
  const names = [-60, -59, -20, -19, 19, 20, 59, 60].map((n) => band(n, bands));
  assert.deepEqual(names, ["enemy", "dislike", "dislike", "neutral", "neutral", "like", "like", "friend"]);
});

test("scoredRow reports the last ledger event", () => {
  const r = withScoreEvent(at(0), { kind: "hurt", why: "hit you" }, t0, scoringOf());
  assert.deepEqual(scoredRow(r), { kind: "relation", event: "scored", partner: "Theo", scoreKind: "hurt", delta: -25, score: -25, why: "hit you" });
});

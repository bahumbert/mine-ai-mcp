import assert from "node:assert/strict";
import test from "node:test";
import { testScoring } from "../testing.ts";
import { newRelation } from "./record.ts";
import { answerRequest, expireRequests, heardFrom, openRequest, requestLines, withExpiredRequests } from "./requests.ts";
import type { Relation } from "./types.ts";

const MIN = 60_000;
const t0 = 10_000_000;
const scoring = testScoring();
const fresh = (): Relation => newRelation("Theo", t0, 0);
const asked = (r: Relation, what: string, at = t0, inRange = true) => openRequest(r, what, at, inRange);

test("opens up to 3, oldest dropped", () => {
  let r = fresh();
  for (const what of ["a", "b", "c", "d"]) r = asked(r, what);
  assert.deepEqual(r.requests.map((q) => q.what), ["b", "c", "d"]);
  assert.deepEqual(r.requests[0], { what: "b", at: t0, inRange: true, agreed: false, heard: false });
});

test("refused scores request_refused and closes", () => {
  const r = answerRequest(asked(fresh(), "5 oak_log"), 1, "refused", t0 + MIN, scoring);
  assert.deepEqual(r.requests, []);
  assert.deepEqual(r.ledger.map((e) => [e.kind, e.delta, e.why]), [["request_refused", -3, "refused your request for 5 oak_log"]]);
});

test("done scores request_helped and closes", () => {
  const r = answerRequest(asked(fresh(), "5 oak_log"), 1, "done", t0 + MIN, scoring);
  assert.deepEqual(r.requests, []);
  assert.deepEqual(r.ledger.map((e) => [e.kind, e.delta]), [["request_helped", 6]]);
});

test("answers the numbered request, not the oldest", () => {
  const r = answerRequest(asked(asked(fresh(), "first"), "second"), 2, "refused", t0, scoring);
  assert.deepEqual(r.requests.map((q) => q.what), ["first"]);
  assert.match(r.ledger[0]?.why ?? "", /second/u);
});

test("agreed keeps it open with no score and stops its answer clock", () => {
  const r = answerRequest(asked(fresh(), "bread"), 1, "agreed", t0 + MIN, scoring);
  assert.equal(r.requests[0]?.agreed, true);
  assert.deepEqual(r.ledger, []);
  const later = expireRequests(r, t0 + 10 * MIN, 2);
  assert.equal(later.relation.requests.length, 1, "an agreed request is not ignored");
  assert.deepEqual(later.ignored, []);
  assert.deepEqual(answerRequest(r, 1, "done", t0 + 11 * MIN, scoring).ledger.map((e) => e.kind), ["request_helped"]);
});

test("answer to a missing number changes nothing", () => {
  const r = asked(fresh(), "bread");
  assert.equal(answerRequest(r, 2, "refused", t0, scoring), r);
  assert.equal(answerRequest(r, 0, "refused", t0, scoring), r);
  assert.equal(answerRequest(fresh(), 1, "done", t0, scoring).ledger.length, 0);
});

test("in range unanswered after 2 min is ignored, at 1.9 min not", () => {
  const r = asked(fresh(), "bread");
  const early = expireRequests(r, t0 + 1.9 * MIN, 2);
  assert.deepEqual([early.relation.requests.length, early.ignored.length], [1, 0]);
  const due = expireRequests(r, t0 + 2 * MIN, 2);
  assert.deepEqual([due.relation.requests, due.ignored.map((q) => q.what)], [[], ["bread"]]);
});

test("a line waiting from them holds the clock", () => {
  const r = asked(fresh(), "bread");
  const held = expireRequests(r, t0 + 5 * MIN, 2, { waiting: true });
  assert.deepEqual([held.relation, held.ignored], [r, []]);
  assert.deepEqual(expireRequests(r, t0 + 5 * MIN, 2).ignored.map((q) => q.what), ["bread"]);
});

test("agreed unanswered 30 min is dropped with no score", () => {
  const agreed = answerRequest(asked(fresh(), "bread"), 1, "agreed", t0, scoring);
  assert.equal(expireRequests(agreed, t0 + 29 * MIN, 2).relation.requests.length, 1);
  const dropped = withExpiredRequests(agreed, t0 + 31 * MIN, scoring);
  assert.deepEqual([dropped.requests, dropped.ledger], [[], []]);
});

test("a partner gone offline is dropped, not ignored", () => {
  const { relation, ignored } = expireRequests(asked(fresh(), "bread"), t0 + 5 * MIN, 2, { offline: true });
  assert.deepEqual([relation.requests, ignored], [[], []]);
});

test("withExpiredRequests scores each ignored request once, in one change", () => {
  const r = asked(asked(fresh(), "bread"), "wool");
  const next = withExpiredRequests(r, t0 + 3 * MIN, scoring);
  assert.deepEqual(next.requests, []);
  assert.deepEqual(next.ledger.map((e) => [e.kind, e.why]), [
    ["request_ignored", "did not answer when you asked for bread"], ["request_ignored", "did not answer when you asked for wool"],
  ]);
  assert.equal(withExpiredRequests(next, t0 + 4 * MIN, scoring).ledger.length, 2, "nothing is scored twice");
});

test("requestLines numbers the open requests with their age", () => {
  const r = answerRequest(asked(asked(fresh(), "5 oak_log", t0), "help with a house", t0 + MIN), 2, "agreed", t0 + MIN, scoring);
  assert.deepEqual(requestLines(r, "Theo", t0 + 2 * MIN), [
    "1. You asked Theo for 5 oak_log 2 min ago.",
    "2. You asked Theo for help with a house 1 min ago; they agreed.",
  ]);
  assert.deepEqual(requestLines(fresh(), "Theo", t0), []);
});

test("heardFrom marks the requests asked before the line", () => {
  const r = asked(asked(fresh(), "bread", t0), "wool", t0 + 10_000);
  const out = heardFrom(r, t0 + 5_000);
  assert.deepEqual(out.requests.map((q) => [q.what, q.heard]), [["bread", true], ["wool", false]]);
});

test("heardFrom with nothing to mark returns the same record", () => {
  const r = asked(fresh(), "bread", t0);
  const noRequests = fresh();
  assert.equal(heardFrom(noRequests, t0 + MIN), noRequests);
  assert.equal(heardFrom(r, t0), r, "a line at the very instant of the ask is not after it");
  const heard = heardFrom(r, t0 + 1);
  assert.equal(heardFrom(heard, t0 + MIN), heard);
});

test("a heard request runs out with no score", () => {
  const r = heardFrom(asked(fresh(), "bread"), t0 + 1_000);
  const out = expireRequests(r, t0 + 5 * MIN, 2);
  assert.deepEqual([out.relation.requests, out.ignored, out.heardDropped.map((q) => q.what)], [[], [], ["bread"]]);
  assert.deepEqual(withExpiredRequests(r, t0 + 5 * MIN, scoring).ledger, []);
});

test("an unheard request still runs out ignored", () => {
  const out = expireRequests(heardFrom(asked(asked(fresh(), "bread", t0), "wool", t0 + MIN), t0 + 30_000), t0 + 5 * MIN, 2);
  assert.deepEqual([out.ignored.map((q) => q.what), out.heardDropped.map((q) => q.what)], [["wool"], ["bread"]]);
});

test("an agreed and heard request keeps the 30-min path", () => {
  const agreed = heardFrom(answerRequest(asked(fresh(), "bread"), 1, "agreed", t0, scoring), t0 + 1_000);
  assert.equal(expireRequests(agreed, t0 + 5 * MIN, 2).relation.requests.length, 1);
  const dropped = withExpiredRequests(agreed, t0 + 31 * MIN, scoring);
  assert.deepEqual([dropped.requests, dropped.ledger], [[], []]);
});

test("a heard request can still be refused", () => {
  const r = answerRequest(heardFrom(asked(fresh(), "coal"), t0 + 1_000), 1, "refused", t0 + MIN, scoring);
  assert.deepEqual([r.requests, r.ledger.map((e) => e.kind)], [[], ["request_refused"]]);
});

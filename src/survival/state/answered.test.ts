import assert from "node:assert/strict";
import test from "node:test";
import { Answered } from "./answered.js";

test("a failed scope captures its own construction and consumes only relevant permissions", () => {
  const answered = new Answered();
  const terrain = { cell: "0,64,0", wall: "stone" };
  const policy = { place: true, bow: true };
  const read = {
    capability: "hide",
    response: "enclose",
    scope: "cell:0,64,0",
    facts: () => terrain,
    permissions: () => ({ place: policy.place }),
  };
  terrain.wall = "cobblestone";
  const entry = answered.remember(read, { kind: "no_passage", why: "The finished wall obstructed the exit." });
  policy.bow = false;
  assert.equal(answered.find("hide", read.scope)?.id, entry.id);
  policy.place = false;
  assert.equal(answered.find("hide", read.scope), null);
});

test("failed recovery does not erase enclosure or rearm on damage", () => {
  const answered = new Answered();
  let food = 3;
  const read = {
    capability: "recovery",
    response: "recover",
    scope: "protected-cell",
    facts: () => ({ usableFood: food }),
    permissions: () => ({ recover: "when_possible" }),
  };
  answered.remember(read, { kind: "budget_exhausted", why: "Health did not reach the requested bar." });
  assert.equal(answered.find("hide", "protected-cell"), null);
  assert.equal(answered.find("recovery", "protected-cell")?.failure.kind, "budget_exhausted");
  food = 0;
  assert.equal(answered.find("recovery", "protected-cell"), null);
});

test("only a declared temporal premise expires, and one arrangement cannot exclude another", () => {
  let now = 100;
  const answered = new Answered(() => now, () => 5_000_000 + now);
  const scope = { capability: "position", response: "fight", scope: "A", facts: () => null, permissions: () => null };
  answered.remember(scope, { kind: "unproductive", why: "No requested-target damage." });
  answered.remember(
    { ...scope, scope: "B" },
    { kind: "projectile_window", why: "Shot still crossing the opening." },
    { premise: "flight_complete", durationMs: 100, why: "Observed launch and predicted flight duration." },
  );
  now = 200;
  assert.ok(answered.find("position", "A"));
  assert.equal(answered.find("position", "B"), null);
  answered.clear();
  assert.deepEqual(answered.snapshot(), []);
});

test("a temporal premise expires on the monotonic reading while the entry reports epoch times", () => {
  let monotonic = 1_000;
  let wall = 1_700_000_000_000;
  const answered = new Answered(() => monotonic, () => wall);
  const scope = { capability: "fire", response: "escape", scope: "A", facts: () => null, permissions: () => null };
  const entry = answered.remember(scope, { kind: "no_escape", why: "Still burning." }, { premise: "retry_after_failure", durationMs: 2_000, why: "Retry." });
  assert.equal(entry.since, wall);
  assert.equal(entry.temporal?.expiresAt, wall + 2_000);
  wall -= 800; // WSL steps the wall clock back: the deadline is not the wall clock's
  monotonic += 1_999;
  assert.ok(answered.find("fire", "A"), "1 ms left on the monotonic clock");
  monotonic += 2;
  assert.equal(answered.find("fire", "A"), null);
});

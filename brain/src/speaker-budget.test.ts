import assert from "node:assert/strict";
import test from "node:test";
import { SpeakerBudget } from "./speaker-budget.ts";

/** A budget over a clock the test moves. */
function budgetAt(perMinute: number, burst: number) {
  const clock = { now: 5_000 };
  return { clock, budget: new SpeakerBudget({ perMinute, burst }, () => clock.now) };
}

test("a speaker starts with the burst, then gets perMinute tokens a minute", () => {
  const { clock, budget } = budgetAt(6, 15);
  for (let taken = 0; taken < 15; taken += 1) assert.equal(budget.tryTake("Tom"), true, `token ${taken + 1}`);
  assert.equal(budget.tryTake("Tom"), false);
  assert.equal(budget.waitMs("Tom"), 10_000);
  clock.now += 4_000;
  assert.equal(budget.waitMs("Tom"), 6_000);
  clock.now += 6_000;
  assert.equal(budget.waitMs("Tom"), 0);
  assert.equal(budget.tryTake("Tom"), true);
  assert.equal(budget.tryTake("Tom"), false);
});

test("tokens never pile past the burst, refunds included", () => {
  const { clock, budget } = budgetAt(6, 15);
  clock.now += 3_600_000;
  for (let refunds = 0; refunds < 3; refunds += 1) budget.refund("Tom");
  for (let taken = 0; taken < 15; taken += 1) assert.equal(budget.tryTake("Tom"), true, `token ${taken + 1}`);
  assert.equal(budget.tryTake("Tom"), false);
});

test("a refund gives one token back to a spent speaker", () => {
  const { budget } = budgetAt(6, 2);
  assert.equal(budget.tryTake("Tom"), true);
  assert.equal(budget.tryTake("Tom"), true);
  assert.equal(budget.tryTake("Tom"), false);
  budget.refund("Tom");
  assert.equal(budget.tryTake("Tom"), true);
  assert.equal(budget.tryTake("Tom"), false);
});

test("names are one speaker whatever the case, and speakers are apart", () => {
  const { budget } = budgetAt(6, 1);
  assert.equal(budget.tryTake("Tom"), true);
  assert.equal(budget.tryTake("tom"), false);
  assert.equal(budget.waitMs("TOM"), 10_000);
  assert.equal(budget.tryTake("Ann"), true);
  assert.equal(budget.waitMs("Bob"), 0);
});

test("perMinute 0 turns the bound off", () => {
  const { budget } = budgetAt(0, 1);
  for (let taken = 0; taken < 100; taken += 1) assert.equal(budget.tryTake("Tom"), true);
  assert.equal(budget.waitMs("Tom"), 0);
  budget.refund("Tom");
  assert.equal(budget.tryTake("Tom"), true);
});

test("the bucket runs on the injected monotonic clock", (t) => {
  t.mock.method(Date, "now", () => {
    throw new Error("the wall clock was read");
  });
  const budget = new SpeakerBudget({ perMinute: 6, burst: 1 });
  assert.equal(budget.tryTake("Tom"), true);
  assert.equal(budget.tryTake("Tom"), false);
  assert.ok(budget.waitMs("Tom") > 0);
  budget.refund("Tom");
});

// Tick budgets cover the planned work, live dig penalties, landing and falling blocks.
import assert from "node:assert/strict";
import test from "node:test";
import { confirmationTicks, pinReleaseTicks } from "./confirmation-deadline.js";

test("confirmation budgets cover landing, the dig, its answer and each brought block", () => {
  for (const [expectedTicks, digMs, broughtBlocks, ticks] of [
    [12, 600, 0, 112], [30, 1_500, 0, 130], [15, 750, 2, 345], [12, 14_100, 0, 604],
  ]) assert.equal(confirmationTicks({ expectedTicks: expectedTicks!, digMs: digMs!, broughtBlocks: broughtBlocks! }), ticks);
  assert.equal(pinReleaseTicks(10), 300);
  assert.equal(pinReleaseTicks(200), 400);
});

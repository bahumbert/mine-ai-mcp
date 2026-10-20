import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ERROR_WAIT_MS, modelRetryDelay } from "./model-wait.ts";

test("the wait doubles from the poll and stops at a minute", () => {
  const full = () => 0.999999;
  const waits = [1, 2, 3, 4, 10].map((failures) => modelRetryDelay(failures, 500, full));
  assert.deepEqual(waits.map(Math.floor), [499, 999, 1999, 3999, 60_000 - 1]);
  assert.equal(modelRetryDelay(40, 500, full) <= MAX_ERROR_WAIT_MS, true);
});

test("the random factor keeps the wait between half and all of the doubled poll", () => {
  assert.equal(modelRetryDelay(3, 1_000, () => 0), 2_000);
  assert.equal(modelRetryDelay(3, 1_000, () => 0.5), 3_000);
  assert.equal(modelRetryDelay(3, 1_000, () => 0.999999) < 4_000, true);
});

test("a poll longer than the cap still waits at most the cap", () => {
  assert.equal(modelRetryDelay(1, 120_000, () => 0.999999) <= MAX_ERROR_WAIT_MS, true);
});

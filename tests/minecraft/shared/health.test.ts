import test from "node:test";
import assert from "node:assert/strict";
import { parseTickQuery, StallWatch } from "./health.ts";

const REAL_ANSWER = [
  "The game is running normally",
  "Target tick rate: 20.0 per second.",
  "Average time per tick: 0.8ms (Target: 50.0ms)",
  "Percentiles: P50: 0.6ms P95: 1.2ms P99: 2.0ms, sample: 100",
].join("\n");

test("tick query: the mean and the P95 are read in milliseconds", () => {
  assert.deepEqual(parseTickQuery(REAL_ANSWER), { meanMs: 0.8, p95Ms: 1.2 });
});

test("tick query answer with a mean but no P95 reading is null", () => {
  assert.equal(parseTickQuery("The game is running normally\nAverage time per tick: 0.0ms (Target: 50.0ms)"), null);
});

test("an answer that is not a tick query reading is null, not zero", () => {
  assert.equal(parseTickQuery("Unknown or incomplete command"), null);
});

test("a server that answers resets the stall clock; silent for the bound it is stalled", () => {
  const watch = new StallWatch(30_000, 0);
  assert.equal(watch.isStalled(29_999), false);
  assert.equal(watch.isStalled(30_000), true);
  watch.answered(40_000);
  assert.equal(watch.isStalled(69_999), false);
  assert.equal(watch.isStalled(70_000), true);
});

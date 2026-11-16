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

// A server is stalled after the stall bound of questions it did not answer, counted from the first one (spec 2026-11-15 F3): time nobody asked is not its silence.

test("never asked: not stalled however long", () => {
  const watch = new StallWatch(30_000);
  assert.equal(watch.isStalled(100_000), false);
});

test("asked at 10 s, no answer: stalled at 40 s, not at 39.999 s; a second question at 25 s moves nothing (the first counts)", () => {
  for (const laterQuestions of [[], [25_000]]) {
    const watch = new StallWatch(30_000);
    watch.asked(10_000);
    for (const at of laterQuestions) watch.asked(at);
    assert.equal(watch.isStalled(39_999), false, `questions ${laterQuestions.length + 1}`);
    assert.equal(watch.isStalled(40_000), true, `questions ${laterQuestions.length + 1}`);
  }
});

test("answered at 20 s after asking at 10 s, asked again at 50 s: not stalled at 79.999 s, stalled at 80 s", () => {
  const watch = new StallWatch(30_000);
  watch.asked(10_000);
  watch.answered(20_000);
  assert.equal(watch.isStalled(100_000), false, "an answered question leaves nothing pending, however long ago");
  watch.asked(50_000);
  assert.equal(watch.isStalled(79_999), false);
  assert.equal(watch.isStalled(80_000), true);
});

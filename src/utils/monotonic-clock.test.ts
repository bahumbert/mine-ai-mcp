import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock } from "../test-support/fake-bot/index.js";
import { clockStart, elapsedSince, monotonicNow } from "./monotonic-clock.js";

test("monotonicNow reads performance.now at each call, so an installed fake clock drives it", async () => {
  const clock = createFakeClock({ mode: "mocked", startMs: 50_000 });
  using _installed = clock.install();
  assert.equal(monotonicNow(), 50_000);
  await clock.advance(250);
  assert.equal(monotonicNow(), 50_250);
});

test("elapsedSince gives whole milliseconds", async () => {
  const clock = createFakeClock({ mode: "mocked", startMs: 10_000 });
  using _installed = clock.install();
  const startedAt = monotonicNow() - 1234.6;
  assert.equal(elapsedSince(startedAt), 1235);
});

test("a wall-clock step of 0.8 s back or 1.2 s forward changes neither monotonicNow nor elapsedSince", async () => {
  const clock = createFakeClock({ mode: "mocked", startMs: 10_000 });
  using _installed = clock.install();
  const startedAt = monotonicNow();
  await clock.advance(3_000);
  clock.stepWallClock(-800);
  assert.equal(monotonicNow(), 13_000);
  assert.equal(elapsedSince(startedAt), 3_000);
  clock.stepWallClock(2_000);
  assert.equal(elapsedSince(startedAt), 3_000);
});

test("clockStart reads both clocks, so a wall step later moves `at` readings but not `began` ones", async () => {
  const clock = createFakeClock({ mode: "mocked", startMs: 10_000 });
  using _installed = clock.install();
  clock.stepWallClock(5_000);
  const start = clockStart();
  assert.deepEqual(start, { at: 15_000, began: 10_000 });
  await clock.advance(1_000);
  clock.stepWallClock(-800);
  assert.equal(Date.now() - start.at, 200);
  assert.equal(elapsedSince(start.began), 1_000);
});

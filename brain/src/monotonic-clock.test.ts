import assert from "node:assert/strict";
import test from "node:test";
import { elapsedSince, monotonicNow, wallTimeOf } from "./monotonic-clock.ts";
import { createFakeClock } from "../../src/test-support/fake-bot/fake-clock.ts";

test("monotonicNow reads performance.now at each call and ignores a wall clock step of 0.8 s back or 1.2 s ahead", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const started = monotonicNow();
  clock.stepWallClock(-800);
  clock.stepWallClock(2_000);
  assert.equal(elapsedSince(started), 0, "the wall steps changed nothing");
  await clock.advance(5_000);
  assert.equal(monotonicNow() - started, 5_000, "a moved performance.now drives it");
});

test("elapsedSince gives whole milliseconds", (t) => {
  t.mock.method(performance, "now", () => 2_000.4);
  assert.equal(elapsedSince(765.2), 1_235);
});

test("wallTimeOf gives a reading's wall time: now's wall time less the monotonic time since, whatever the wall clock stepped", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const reading = monotonicNow();
  await clock.advance(3_000);
  clock.stepWallClock(-60_000);
  assert.equal(wallTimeOf(reading), Date.now() - 3_000);
});

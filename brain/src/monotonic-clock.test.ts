import assert from "node:assert/strict";
import test from "node:test";
import { elapsedSince, monotonicNow, wallTimeOf } from "./monotonic-clock.ts";
import { steppedClocks } from "./testing.ts";

test("monotonicNow reads performance.now at each call and ignores a wall clock step of 0.8 s back or 1.2 s ahead", (t) => {
  const clocks = steppedClocks(t);
  const started = monotonicNow();
  clocks.wall(-800);
  clocks.wall(2_000);
  assert.ok(elapsedSince(started) < 100, "the wall steps changed nothing");
  clocks.monotonic(5_000);
  assert.ok(monotonicNow() - started >= 5_000, "a moved performance.now drives it");
});

test("elapsedSince gives whole milliseconds", (t) => {
  t.mock.method(performance, "now", () => 2_000.4);
  assert.equal(elapsedSince(765.2), 1_235);
});

test("wallTimeOf gives a reading's wall time: now's wall time less the monotonic time since, whatever the wall clock stepped", (t) => {
  const clocks = steppedClocks(t);
  const reading = monotonicNow();
  clocks.monotonic(3_000);
  clocks.wall(-60_000);
  const at = wallTimeOf(reading);
  assert.ok(Math.abs(Date.now() - 3_000 - at) < 50, `${Date.now() - at} ms before now`);
});

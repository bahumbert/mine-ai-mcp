import assert from "node:assert/strict";
import test from "node:test";
import { GiveBook, RETAKE_AFTER_MS } from "./gives.ts";

// The two clocks (monotonic-clock.ts header): the retake wait is a duration (`now`), the moment a give was taken is
// compared with the trade's stored wall times (`wallNow`).
const WALL = 1_700_000_000_000;
const PAY_BACK_MS = 10 * 60_000;

function book() {
  const clock = { now: 5_000, wallNow: WALL };
  return { clock, gives: new GiveBook(() => clock.now, () => clock.wallNow, PAY_BACK_MS) };
}

test("a dropped give waits RETAKE_AFTER_MS of monotonic time, whatever the wall clock did", () => {
  const { clock, gives } = book();
  assert.equal(gives.waitingToRetake("t1"), false, "a give never dropped does not wait, early in a process whose monotonic reading is small");
  gives.dropped("t1");
  clock.now += RETAKE_AFTER_MS - 1;
  clock.wallNow -= 2_000;
  assert.equal(gives.waitingToRetake("t1"), true);
  clock.now += 1;
  assert.equal(gives.waitingToRetake("t1"), false, "30 s of monotonic time later it is retaken");
});

test("the moment a give was taken is a wall time, the one the trade's own times are compared with", () => {
  const { clock, gives } = book();
  gives.taken("t1");
  assert.equal(gives.takenSince("t1"), WALL);
  clock.now += 60_000;
  clock.wallNow += 60_000;
  assert.equal(gives.running("t1", true), true, "a pending give taken a minute ago runs");
  clock.wallNow += PAY_BACK_MS;
  assert.equal(gives.running("t1", true), false, "a pending give older than the pay-back time is stuck");
});

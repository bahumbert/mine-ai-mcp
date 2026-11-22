import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock, type FakeClock } from "../../test-support/fake-bot/fake-clock.js";
import { NO_TICK_CANCEL_MS, armNoTickCancel } from "./no-tick-cancel.js";

/** The cancel check armed on `clock`, whose time the test moves: its ticks are the test's own `tickNow` calls. */
function clockedCancel(clock: FakeClock, signal: AbortSignal, noTickMs = NO_TICK_CANCEL_MS) {
  let lastTick = 0;
  let settled = 0;
  const arm = armNoTickCancel({
    signal,
    lastTickAt: () => lastTick,
    settle: () => {
      settled += 1;
    },
    now: clock.now,
    noTickMs,
  });
  return {
    arm,
    settled: () => settled,
    tickNow: () => {
      lastTick = clock.now();
    },
    advance: (ms: number) => clock.advance(ms),
  };
}

test("no timer before the abort", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const cancel = clockedCancel(clock, new AbortController().signal);
  await cancel.advance(60_000);
  assert.equal(cancel.settled(), 0);
});

test("an abort with no tick for a second settles once", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const abort = new AbortController();
  const cancel = clockedCancel(clock, abort.signal);
  await cancel.advance(5_000);
  abort.abort();
  await cancel.advance(NO_TICK_CANCEL_MS - 1);
  assert.equal(cancel.settled(), 0, "one ms short of the silent second: not yet");
  await cancel.advance(1);
  assert.equal(cancel.settled(), 1);
  await cancel.advance(10_000);
  assert.equal(cancel.settled(), 1);
});

test("ticks after the abort keep it waiting, the first silent second settles", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const abort = new AbortController();
  const cancel = clockedCancel(clock, abort.signal);
  abort.abort();
  for (let tick = 0; tick < 5; tick += 1) {
    await cancel.advance(400);
    cancel.tickNow();
  }
  assert.equal(cancel.settled(), 0);
  await cancel.advance(NO_TICK_CANCEL_MS - 1);
  assert.equal(cancel.settled(), 0, "one ms short of the silent second: not yet");
  await cancel.advance(1);
  assert.equal(cancel.settled(), 1);
});

test("dispose before the abort leaves nothing armed", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const abort = new AbortController();
  const cancel = clockedCancel(clock, abort.signal);
  cancel.arm[Symbol.dispose]();
  abort.abort();
  await cancel.advance(10_000);
  assert.equal(cancel.settled(), 0);
});

test("dispose after the abort stops the pending check", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const abort = new AbortController();
  const cancel = clockedCancel(clock, abort.signal);
  abort.abort();
  cancel.arm[Symbol.dispose]();
  await cancel.advance(10_000);
  assert.equal(cancel.settled(), 0);
});

test("an already aborted signal arms at once", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const abort = new AbortController();
  abort.abort();
  const cancel = clockedCancel(clock, abort.signal);
  await cancel.advance(NO_TICK_CANCEL_MS);
  assert.equal(cancel.settled(), 1);
});

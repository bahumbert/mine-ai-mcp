import assert from "node:assert/strict";
import test from "node:test";
import { NO_TICK_CANCEL_MS, armNoTickCancel } from "./no-tick-cancel.js";

/** A clock the test moves together with the mocked timers. */
function clockedCancel(context: test.TestContext, signal: AbortSignal, noTickMs = NO_TICK_CANCEL_MS) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  let lastTick = 0;
  let settled = 0;
  const arm = armNoTickCancel({
    signal,
    lastTickAt: () => lastTick,
    settle: () => {
      settled += 1;
    },
    now: () => now,
    noTickMs,
  });
  return {
    arm,
    settled: () => settled,
    tickNow: () => {
      lastTick = now;
    },
    advance: (ms: number) => {
      now += ms;
      context.mock.timers.tick(ms);
    },
  };
}

test("no timer before the abort", (context) => {
  const cancel = clockedCancel(context, new AbortController().signal);
  cancel.advance(60_000);
  assert.equal(cancel.settled(), 0);
});

test("an abort with no tick for a second settles once", (context) => {
  const abort = new AbortController();
  const cancel = clockedCancel(context, abort.signal);
  cancel.advance(5_000);
  abort.abort();
  cancel.advance(NO_TICK_CANCEL_MS);
  assert.equal(cancel.settled(), 1);
  cancel.advance(10_000);
  assert.equal(cancel.settled(), 1);
});

test("ticks after the abort keep it waiting, the first silent second settles", (context) => {
  const abort = new AbortController();
  const cancel = clockedCancel(context, abort.signal);
  abort.abort();
  for (let tick = 0; tick < 5; tick += 1) {
    cancel.advance(400);
    cancel.tickNow();
  }
  assert.equal(cancel.settled(), 0);
  cancel.advance(NO_TICK_CANCEL_MS);
  assert.equal(cancel.settled(), 1);
});

test("dispose before the abort leaves nothing armed", (context) => {
  const abort = new AbortController();
  const cancel = clockedCancel(context, abort.signal);
  cancel.arm[Symbol.dispose]();
  abort.abort();
  cancel.advance(10_000);
  assert.equal(cancel.settled(), 0);
});

test("dispose after the abort stops the pending check", (context) => {
  const abort = new AbortController();
  const cancel = clockedCancel(context, abort.signal);
  abort.abort();
  cancel.arm[Symbol.dispose]();
  cancel.advance(10_000);
  assert.equal(cancel.settled(), 0);
});

test("an already aborted signal arms at once", (context) => {
  const abort = new AbortController();
  abort.abort();
  const cancel = clockedCancel(context, abort.signal);
  cancel.advance(NO_TICK_CANCEL_MS);
  assert.equal(cancel.settled(), 1);
});

/** The brain's waits must follow mocked time and release aborted sleeps. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { sleepMs, timeoutSignal } from "./wall-timers.ts";
import { createFakeClock } from "../../src/test-support/fake-bot/fake-clock.js";

test("sleepMs wakes at its mocked deadline and removes its abort listener", async (t) => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const controller = new AbortController();
  const remove = t.mock.method(controller.signal, "removeEventListener");
  let woke = false;
  const sleeping = sleepMs(1_000, controller.signal).then(() => { woke = true; });
  await clock.advance(999);
  assert.equal(woke, false);
  await clock.advance(1);
  assert.equal(woke, true);
  await sleeping;
  assert.equal(remove.mock.callCount(), 1, "a completed sleep detaches its abort listener");
  controller.abort(new Error("after the sleep"));
});

for (const when of ["before", "during"] as const) {
  test(`sleepMs aborted ${when} waiting keeps the reason and leaves no timer or listener`, async (t) => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const set = globalThis.setTimeout;
    const clear = globalThis.clearTimeout;
    let armed = 0;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      armed += 1;
      return set(...args);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
      armed -= 1;
      clear(id);
    }) as typeof clearTimeout;
    const controller = new AbortController();
    const add = t.mock.method(controller.signal, "addEventListener");
    const remove = t.mock.method(controller.signal, "removeEventListener");
    const reason = new Error("stopped");
    try {
      if (when === "before") controller.abort(reason);
      const sleeping = sleepMs(60_000, controller.signal);
      if (when === "during") controller.abort(reason);
      await assert.rejects(sleeping, (error) => error === reason);
      assert.equal(armed, 0, "no sleep timer remains armed");
      assert.equal(add.mock.callCount() - remove.mock.callCount(), 0, "no abort listener remains attached");
    } finally {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    }
  });
}

test("timeoutSignal aborts at its mocked deadline with TimeoutError", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const signal = timeoutSignal(100);
  await clock.advance(99);
  assert.equal(signal.aborted, false);
  await clock.advance(1);
  assert.equal(signal.aborted, true);
  assert.ok(signal.reason instanceof DOMException);
  assert.equal(signal.reason.name, "TimeoutError");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeAbort } from "../navigation/orchestration/describe-abort.js";
import { createFakeClock } from "../test-support/fake-bot/fake-clock.js";
import { sleepMs, timeoutSignal } from "./wall-timers.js";

/** Counts the timers armed and cleared through the global functions while the body runs. */
async function countingTimers(body: (counts: { armed: number; cleared: number }) => Promise<void>): Promise<void> {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const counts = { armed: 0, cleared: 0 };
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    counts.armed += 1;
    return realSet(...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
    counts.cleared += 1;
    realClear(id);
  }) as typeof clearTimeout;
  try {
    await body(counts);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}

/** A signal that counts the abort listeners added to it and still attached. */
function listenedSignal(controller: AbortController): { signal: AbortSignal; attached: () => number } {
  const signal = controller.signal;
  let attached = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    attached += 1;
    add(...args);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    attached -= 1;
    remove(...args);
  }) as AbortSignal["removeEventListener"];
  return { signal, attached: () => attached };
}

test("sleepMs: a mocked setTimeout tick ends the sleep, so a fake clock reaches it", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  let woke = false;
  const sleeping = sleepMs(1000).then(() => {
    woke = true;
  });
  await clock.advance(999);
  assert.equal(woke, false, "the sleep must not end before its 1000 ms");
  await clock.advance(1);
  assert.equal(woke, true, "the clock, not the real clock, must end the sleep");
  await sleeping;
});

for (const when of ["before", "during"] as const) {
  test(`sleepMs: an abort ${when} the sleep rejects with the reason and leaves no timer and no listener`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    await countingTimers(async (counts) => {
      const controller = new AbortController();
      const { signal, attached } = listenedSignal(controller);
      const reason = new Error("hunger reflex");
      if (when === "before") controller.abort(reason);
      const sleeping = sleepMs(60_000, signal);
      if (when === "during") controller.abort(reason);
      await assert.rejects(sleeping, (error) => error === reason);
      assert.equal(counts.armed - counts.cleared, 0, "the aborted sleep must not leave its timer armed");
      assert.equal(attached(), 0, "the aborted sleep must not leave its abort listener");
    });
  });
}

test("sleepMs: a sleep that ends removes its abort listener", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { signal, attached } = listenedSignal(new AbortController());
  const sleeping = sleepMs(1000, signal);
  await clock.advance(1000);
  await sleeping;
  assert.equal(attached(), 0);
});

test("timeoutSignal: aborts at its deadline of mocked time with a reason that reads as a timeout", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const signal = timeoutSignal(100);
  await clock.advance(99);
  assert.equal(signal.aborted, false);
  await clock.advance(1);
  assert.equal(signal.aborted, true);
  assert.ok(signal.reason instanceof DOMException);
  assert.equal(signal.reason.name, "TimeoutError", "the name AbortSignal.timeout gives and portal-entry checks");
  assert.equal(describeAbort(signal.reason), "navigation timeout");
});

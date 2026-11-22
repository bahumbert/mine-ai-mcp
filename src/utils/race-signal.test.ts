import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { raceSignal } from "./race-signal.js";

const abortListeners = (signal: AbortSignal) => getEventListeners(signal, "abort").length;

/** A promise the test settles by hand, as a Mineflayer call the server answers (or does not). */
function pending<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((resolveWith, rejectWith) => { resolve = resolveWith; reject = rejectWith; });
  return { promise, resolve, reject };
}

test("raceSignal: an abort while the call is pending rejects with the signal's reason at once", async () => {
  const stop = new AbortController();
  const call = pending<string>();
  const raced = raceSignal(call.promise, stop.signal);
  const reason = new Error("died");
  stop.abort(reason);
  await assert.rejects(raced, (error) => error === reason);
});

test("raceSignal: a call that settles first returns its own result and its own error", async () => {
  const stop = new AbortController();
  const answered = pending<string>();
  const raced = raceSignal(answered.promise, stop.signal);
  answered.resolve("equipped");
  assert.equal(await raced, "equipped");

  const refused = pending<string>();
  const racedRefusal = raceSignal(refused.promise, stop.signal);
  const failure = new Error("Event blockUpdate did not fire");
  refused.reject(failure);
  await assert.rejects(racedRefusal, (error) => error === failure);
});

test("raceSignal: an abort after the call settled changes nothing", async () => {
  const stop = new AbortController();
  const result = await raceSignal(Promise.resolve(7), stop.signal);
  stop.abort(new Error("late"));
  assert.equal(result, 7);
});

test("raceSignal: a signal already aborted rejects without waiting for the call", async () => {
  const stop = new AbortController();
  const reason = new Error("already dead");
  stop.abort(reason);
  const call = pending<string>();
  await assert.rejects(raceSignal(call.promise, stop.signal), (error) => error === reason);
});

/** The late rejection of a call the race gave up on, whether the signal aborted before or during the race. */
for (const [when, abortBeforeRace] of [["during the race", false], ["before the race", true]] as const) {
  test(`raceSignal: the late rejection of an abandoned call is swallowed (abort ${when})`, async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const stop = new AbortController();
      const call = pending<string>();
      if (abortBeforeRace) stop.abort(new Error("died"));
      const raced = raceSignal(call.promise, stop.signal);
      if (!abortBeforeRace) stop.abort(new Error("died"));
      await assert.rejects(raced);
      call.reject(new Error("Event blockUpdate did not fire within timeout of 5000ms"));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
}

test("raceSignal: without a signal the call's own outcome is the result", async () => {
  assert.equal(await raceSignal(Promise.resolve("done"), undefined), "done");
  await assert.rejects(raceSignal(Promise.reject(new Error("refused")), undefined), /refused/);
});

test("raceSignal: its abort listener is removed on every outcome (no leak over 1000 calls)", async () => {
  const stop = new AbortController();
  for (let call = 0; call < 1_000; call += 1) {
    if (call % 2 === 0) await raceSignal(Promise.resolve(call), stop.signal);
    else await raceSignal(Promise.reject(new Error("refused")), stop.signal).catch(() => undefined);
  }
  assert.equal(abortListeners(stop.signal), 0);

  const abortedMidCall = new AbortController();
  const raced = raceSignal(pending<void>().promise, abortedMidCall.signal);
  abortedMidCall.abort(new Error("died"));
  await raced.catch(() => undefined);
  assert.equal(abortListeners(abortedMidCall.signal), 0);
});

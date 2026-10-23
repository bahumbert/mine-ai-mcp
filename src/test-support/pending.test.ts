import assert from "node:assert/strict";
import test from "node:test";
import { watch } from "./pending.js";

/** A promise the test ends when it chooses. */
function deferred() {
  let resolve!: (value: number) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<number>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a watched promise is not over before it ends", async () => {
  const pending = deferred();
  const watched = watch(pending.promise);
  await Promise.resolve();
  assert.equal(watched.over, false);
  pending.resolve(1);
});

test("a watched promise is over after it resolves", async () => {
  const pending = deferred();
  const watched = watch(pending.promise);
  pending.resolve(1);
  await pending.promise;
  assert.equal(watched.over, true);
});

test("a watched promise is over after it rejects, and the rejection stays the caller's to handle", async () => {
  const pending = deferred();
  const watched = watch(pending.promise);
  pending.reject(new Error("boom"));
  await assert.rejects(pending.promise, /boom/);
  assert.equal(watched.over, true);
});

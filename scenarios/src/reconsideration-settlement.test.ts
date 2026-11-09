import test from "node:test";
import assert from "node:assert/strict";
import { createFakeClock } from "../../src/test-support/fake-bot/index.ts";
import { settleReconsiderationHunt } from "./reconsideration-settlement.ts";

test("proof cancellation waits for the hunt to settle before the next action", async () => {
  const child = new AbortController();
  const hunt = Promise.withResolvers<string>();
  const result = settleReconsiderationHunt(hunt.promise, child, new Promise(() => {}));
  let nextStarted = false;
  const next = result.then(() => { nextStarted = true; });
  child.abort("proof");
  await Promise.resolve();
  assert.equal(nextStarted, false);
  hunt.resolve("settled");
  await next;
  assert.equal(nextStarted, true);
});

test("an observation failure cancels the hunt and waits for its settlement", async () => {
  const child = new AbortController();
  const hunt = Promise.withResolvers<string>();
  const failure = Promise.withResolvers<never>();
  const result = settleReconsiderationHunt(hunt.promise, child, failure.promise);
  const reason = new Error("arranged move not observed");
  let rejected = false;
  const rejectedResult = assert.rejects(result, reason).then(() => { rejected = true; });
  failure.reject(reason);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(child.signal.aborted, true);
  assert.equal(rejected, false);
  hunt.resolve("cancelled");
  await rejectedResult;
});

test("a hunt that ignores cancellation fails at the wall bound", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const child = new AbortController();
  const result = settleReconsiderationHunt(new Promise(() => {}), child, new Promise(() => {}));
  const rejection = assert.rejects(result, /hunt did not settle after cancel/);
  child.abort("proof");
  await clock.advance(10_000);
  await rejection;
});

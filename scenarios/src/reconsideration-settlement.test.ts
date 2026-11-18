import test from "node:test";
import assert from "node:assert/strict";
import { createFakeBot, createFakeClock } from "../../src/test-support/fake-bot/index.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "../../tests/minecraft/drivers/server-ticks.ts";
import { settleReconsiderationHunt } from "./reconsideration-settlement.ts";

function fixture(rate = 20) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, server: { ticksPerSecond: rate } });
  return { ...harness, clock };
}

test("proof cancellation waits for the hunt to settle before the next action", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  const child = new AbortController();
  const hunt = Promise.withResolvers<string>();
  const result = settleReconsiderationHunt(hunt.promise, child, new Promise(() => {}), f.bot);
  let nextStarted = false;
  const next = result.then(() => { nextStarted = true; });
  child.abort("proof");
  await Promise.resolve();
  assert.equal(nextStarted, false);
  hunt.resolve("settled");
  await next;
  assert.equal(nextStarted, true);
  assert.equal(f.clock.pendingGlobalTimers(), 0, "the settle budget is released");
});

test("an observation failure cancels the hunt and waits for its settlement", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  const child = new AbortController();
  const hunt = Promise.withResolvers<string>();
  const failure = Promise.withResolvers<never>();
  const result = settleReconsiderationHunt(hunt.promise, child, failure.promise, f.bot);
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
  assert.equal(f.clock.pendingGlobalTimers(), 0);
});

for (const rate of [20, 10]) {
  test(`a hunt that ignores cancellation fails after 200 server ticks, not before, at ${rate} tps`, async () => {
    const f = fixture(rate);
    using _timers = f.clock.install();
    const child = new AbortController();
    let failed = false;
    const result = settleReconsiderationHunt(new Promise(() => {}), child, new Promise(() => {}), f.bot);
    const rejection = assert.rejects(result, /hunt did not settle after cancel/).then(() => { failed = true; });
    child.abort("proof");
    const abortedAt = f.server.gameTime;
    while (!failed && f.server.gameTime - abortedAt < 400) await f.clock.advance(20_000 / rate);
    await rejection;
    assert.ok(f.server.gameTime - abortedAt >= 200, `failed after ${f.server.gameTime - abortedAt} server ticks`);
    assert.ok(f.server.gameTime - abortedAt <= 240, `failed after ${f.server.gameTime - abortedAt} server ticks`);
    assert.equal(f.clock.pendingGlobalTimers(), 0);
  });
}

test("a stopped server ends the wait for a hunt that ignores cancellation at the stopped-clock bound", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  const child = new AbortController();
  let failed = false;
  const result = settleReconsiderationHunt(new Promise(() => {}), child, new Promise(() => {}), f.bot);
  const rejection = assert.rejects(result, /hunt did not settle after cancel/).then(() => { failed = true; });
  child.abort("proof");
  f.server.stop();
  await f.clock.advance(DRIVER_CLOCK_STOPPED_MS - 100);
  assert.equal(failed, false, "100 ms inside the bound (the budget looks every 50 ms)");
  await f.clock.advance(200);
  await rejection;
});

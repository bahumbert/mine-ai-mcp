import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock, failIfFakeClockLeftInstalled } from "./fake-clock.js";

test("a mocked clock runs a 1000 ms setTimeout once and moves Date.now and performance.now by 1000", async () => {
  const clock = createFakeClock({ mode: "mocked", startMs: 5_000 });
  using _installed = clock.install();
  let fired = 0;
  setTimeout(() => (fired += 1), 1_000);
  const date = Date.now();
  const monotonic = performance.now();
  await clock.advance(999);
  assert.equal(fired, 0);
  await clock.advance(1_001);
  assert.equal(fired, 1);
  assert.equal(Date.now() - date, 2_000);
  assert.equal(performance.now() - monotonic, 2_000);
});

test("disposing a mocked clock restores the real performance.now and Date", () => {
  const realPerformanceNow = performance.now;
  const clock = createFakeClock({ mode: "mocked" });
  {
    using _installed = clock.install();
    assert.notEqual(performance.now, realPerformanceNow);
    assert.equal(Date.now(), 0);
  }
  assert.equal(performance.now, realPerformanceNow);
  assert.ok(Date.now() > 1_000_000_000_000);
});

test("a manual clock never touches the globals", async () => {
  const globals = { performanceNow: performance.now, dateNow: Date.now, setTimeout, setInterval };
  const clock = createFakeClock({ mode: "manual" });
  await clock.advance(1_000);
  assert.equal(clock.now(), 1_000);
  assert.deepEqual({ performanceNow: performance.now, dateNow: Date.now, setTimeout, setInterval }, globals);
  assert.throws(() => clock.install(), /manual/);
});

test("every ticks once per slice at its own period, and stops when cancelled", async () => {
  const clock = createFakeClock({ mode: "manual" });
  let eachSlice = 0;
  let eachSecond = 0;
  const stopSlice = clock.every(() => (eachSlice += 1), 50);
  clock.every(() => (eachSecond += 1), 1_000);
  await clock.advance(500);
  assert.equal(eachSlice, 10);
  stopSlice();
  await clock.advance(1_500);
  assert.equal(eachSlice, 10);
  assert.equal(eachSecond, 2);
});

test("advance runs a remainder that is not a whole step as a last, shorter slice", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const slices: number[] = [];
  clock.onSlice("server", (sliceMs) => slices.push(sliceMs));
  await clock.advance(120);
  assert.deepEqual(slices, [50, 50, 20]);
  assert.equal(clock.now(), 120);
});

test("a slice runs the timers, then the server, then the physics, then drains the promise queue", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const order: string[] = [];
  clock.after(50, () => order.push("timer"));
  clock.onSlice("physics", () => {
    order.push("physics");
    void Promise.resolve().then(() => order.push("reaction"));
  });
  clock.onSlice("server", () => order.push("server"));
  await clock.advance(50);
  assert.deepEqual(order, ["timer", "server", "physics", "reaction"]);
});

test("sleep resolves when the clock reaches its end, not before", async () => {
  const clock = createFakeClock({ mode: "manual" });
  let woke = false;
  void clock.sleep(300).then(() => (woke = true));
  await clock.advance(250);
  assert.equal(woke, false);
  await clock.advance(50);
  assert.equal(woke, true);
});

test("an aborted sleep rejects with the signal's reason and leaves no timer", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const already = new AbortController();
  already.abort(new Error("gone before"));
  await assert.rejects(clock.sleep(100, already.signal), /gone before/);
  const during = new AbortController();
  const sleeping = clock.sleep(1_000, during.signal);
  await clock.advance(100);
  during.abort(new Error("cancelled"));
  await assert.rejects(sleeping, /cancelled/);
  assert.equal(clock.pendingTimers(), 0);
});

test("a second install while a clock is installed throws, naming the file that installed the first", () => {
  const first = createFakeClock({ mode: "mocked" });
  using _installed = first.install();
  assert.throws(() => createFakeClock({ mode: "mocked" }).install(), /already installed by .*fake-clock\.test\.ts:\d+/);
});

test("after the installed clock is disposed another installs", () => {
  {
    using _first = createFakeClock({ mode: "mocked" }).install();
  }
  const second = createFakeClock({ mode: "mocked", startMs: 7 });
  using _installed = second.install();
  assert.equal(Date.now(), 7);
});

test("a failed second install leaves the first clock's timers and globals as they were", async () => {
  const first = createFakeClock({ mode: "mocked" });
  using _installed = first.install();
  let fired = 0;
  setTimeout(() => (fired += 1), 100);
  assert.throws(() => createFakeClock({ mode: "mocked" }).install(), /already installed/);
  await first.advance(100);
  assert.equal(fired, 1);
});

test("a clock left installed at the end of a test is restored and named", () => {
  const realPerformanceNow = performance.now;
  createFakeClock({ mode: "mocked" }).install();
  assert.throws(() => failIfFakeClockLeftInstalled(), /fake clock left installed/);
  assert.equal(performance.now, realPerformanceNow);
  assert.doesNotThrow(() => failIfFakeClockLeftInstalled());
});

test("promise work queued before advance runs at the time it was queued, before the first slice", async () => {
  const clock = createFakeClock({ mode: "manual" });
  let startedAt = -1;
  const start = async () => {
    await Promise.resolve();
    await Promise.resolve();
    startedAt = clock.now();
  };
  void start();
  await clock.advance(50);
  assert.equal(startedAt, 0);
});

test("settle advances until the promise resolves, stops at that slice and returns its value", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const value = await clock.settle(clock.sleep(300).then(() => "slept"), 10_000);
  assert.equal(value, "slept");
  assert.equal(clock.now(), 300);
});

test("settle rethrows the promise's rejection at the slice it rejected", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const failing = clock.sleep(120).then(() => Promise.reject(new Error("refused")));
  await assert.rejects(clock.settle(failing, 10_000), /refused/);
  assert.equal(clock.now(), 150);
});

test("settle gives up after maxMs of clock naming the bound, and a settled promise moves no time", async () => {
  const clock = createFakeClock({ mode: "manual" });
  await assert.rejects(clock.settle(new Promise(() => undefined), 1_000), /did not settle within 1000 ms of clock/);
  assert.equal(clock.now(), 1_000);
  assert.equal(await clock.settle(Promise.resolve(7), 1_000), 7);
  assert.equal(clock.now(), 1_000);
});

test("settle on a mocked clock lets code waiting on the global timers finish", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const waited = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now()), 2_000));
  assert.equal(await clock.settle(waited, 5_000, 100), 2_000);
});

// Bench verification, shared runs and independent cancellation of their waiters.
import test from "node:test";
import assert from "node:assert/strict";
import { BenchState, type CanaryRun } from "./bench-canary.ts";

function pendingRun() {
  const end = Promise.withResolvers<Awaited<CanaryRun["done"]>>();
  const signals: AbortSignal[] = [];
  const start = async (signal: AbortSignal): Promise<CanaryRun> => {
    signals.push(signal);
    return { done: end.promise, waitReport: () => "canary waits for a server" };
  };
  return { end, signals, start };
}

test("starts unverified, caches a pass, invalidates on infra and verifies again", async () => {
  const bench = new BenchState();
  assert.equal(bench.isVerified(), false);
  const run = pendingRun();
  const verdict = bench.ensure("/a", run.start, new AbortController().signal, () => {});
  run.end.resolve({ class: "pass", elapsedMs: 1200 });
  assert.deepEqual(await verdict, { kind: "verified", seconds: 1.2 });
  assert.equal(bench.isVerified(), true);
  assert.deepEqual(await bench.ensure("/a", async () => { throw new Error("must not start"); }, new AbortController().signal, () => {}), { kind: "verified", seconds: 1.2 });
  bench.sawInfra();
  assert.equal(bench.isVerified(), false);
  const next = pendingRun();
  const result = bench.ensure("/a", next.start, new AbortController().signal, () => {});
  next.end.resolve({ class: "pass", elapsedMs: 10 });
  assert.deepEqual(await result, { kind: "verified", seconds: 0.01 });
  bench.sawInfra();
  bench.sawPass();
  assert.equal(bench.isVerified(), true);
});

test("two waiters share one run; the first leaves and the second gets its verdict and wait line", async () => {
  for (const sameCallback of [false, true]) {
    const bench = new BenchState();
    const run = pendingRun();
    const first = new AbortController();
    const reports: string[] = [];
    const notify = (text: string) => reports.push(text);
    const a = bench.ensure("/a", run.start, first.signal, sameCallback ? notify : () => {});
    const b = bench.ensure("/a", async () => { throw new Error("duplicate run"); }, new AbortController().signal, notify);
    await Promise.resolve();
    first.abort();
    assert.equal(await a, "left");
    assert.equal(run.signals[0]!.aborted, false);
    run.end.resolve({ class: "pass", elapsedMs: 1000 });
    assert.deepEqual(await b, { kind: "verified", seconds: 1 });
    assert.ok(reports.includes("canary waits for a server"));
  }
});

test("the only waiter leaves: abort the run, and a new waiter starts a new run", async () => {
  const bench = new BenchState();
  const run = pendingRun();
  const waiter = new AbortController();
  const result = bench.ensure("/a", run.start, waiter.signal, () => {});
  await Promise.resolve();
  waiter.abort();
  assert.equal(await result, "left");
  assert.equal(run.signals[0]!.aborted, true);
  const next = pendingRun();
  const verdict = bench.ensure("/a", next.start, new AbortController().signal, () => {});
  run.end.resolve({ class: "pass", elapsedMs: 1 });
  next.end.resolve({ class: "product", elapsedMs: 1 });
  assert.deepEqual(await verdict, { kind: "unproven", class: "product" });
  assert.equal(bench.isVerified(), false, "an abandoned run cannot verify the bench");
});

test("infra not selfMade blocks; selfMade infra and product stay unproven and run again", async () => {
  for (const [resultClass, selfMade, kind] of [["infra", false, "infra"], ["infra", true, "unproven"], ["infra", undefined, "unproven"], ["product", undefined, "unproven"], ["cancelled", undefined, "unproven"]] as const) {
    const bench = new BenchState();
    const run = pendingRun();
    const result = bench.ensure("/a", run.start, new AbortController().signal, () => {});
    run.end.resolve({ class: resultClass, selfMade, cause: "cause", elapsedMs: 2 });
    assert.deepEqual(await result, kind === "infra" ? { kind, name: "/a", cause: "cause" } : { kind, class: resultClass, cause: "cause" });
    assert.equal(bench.isVerified(), false);
    const next = pendingRun();
    const retried = bench.ensure("/a", next.start, new AbortController().signal, () => {});
    next.end.resolve({ class: "pass", elapsedMs: 1 });
    assert.equal((await retried as { kind: string }).kind, "verified");
  }
});

test("different canary paths do not share a run", async () => {
  const bench = new BenchState();
  const a = pendingRun();
  const b = pendingRun();
  const results = [bench.ensure("/a", a.start, new AbortController().signal, () => {}), bench.ensure("/b", b.start, new AbortController().signal, () => {})];
  a.end.resolve({ class: "pass", elapsedMs: 1 });
  b.end.resolve({ class: "product", elapsedMs: 1 });
  assert.deepEqual((await Promise.all(results)).map(result => result === "left" ? result : result.kind), ["verified", "unproven"]);
});

test("an already cancelled waiter starts nothing", async () => {
  const bench = new BenchState();
  const waiter = AbortSignal.abort();
  assert.equal(await bench.ensure("/a", async () => { throw new Error("started"); }, waiter, () => {}), "left");
  assert.equal(bench.isVerified(), false);
});

// executeTrial: the lane held through the restore, the wall-clock abort, a cancel, a failed arrangement, a trial on a server of its own, and what `arranged` says.
import test from "node:test";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import { createFakeClock } from "../../../src/test-support/fake-bot/fake-clock.js";
import assert from "node:assert/strict";
import type { RunResult } from "mine-labs";
import { laneOf } from "../arena/lanes.ts";
import { ArrangementMutex } from "./arrangement-mutex.ts";
import { executeTrial, type TrialRunInput, type TrialRunner } from "./trial.ts";
import { config, scenario, result, job, runnerOf } from "./trial-fixtures.ts";

test("a passing lane trial hands its lane back after the restore ran, and the arena options name the lane", async () => {
  const events: string[] = [];
  let seen: TrialRunInput | undefined;
  const runner: TrialRunner = async input => { seen = input; return runnerOf({ events })(input); };
  const end = await executeTrial({ runTrial: runner, config }, job());
  assert.equal(end.result.outcome, "pass");
  assert.equal(end.lane, "free");
  assert.deepEqual(events, ["arrange", "prepared", "restore"]);
  assert.equal(seen?.arena?.id, "lane-3");
  assert.deepEqual(seen?.arena?.controlChunk, { x: -496, z: 3 * 512 - 240 });
  assert.equal(seen?.arena?.entityBox.minZ, 3 * 512 - 256);
  assert.equal(seen?.reuseServer, true);
});

test("two lanes' arrangements never overlap: the second runs after the first is prepared", async () => {
  const mutex = new ArrangementMutex();
  const events: string[] = [];
  const firstArranged = Promise.withResolvers<void>();
  const finishFirst = Promise.withResolvers<void>();
  const slowPrepare: TrialRunner = async input => {
    events.push(`arrange ${input.arena?.id}`);
    if (input.arena?.id === "lane-1") {
      firstArranged.resolve();
      await finishFirst.promise;
    }
    await input.onPrepared();
    events.push(`prepared ${input.arena?.id}`);
    input.deferReset(async () => {});
    return result("pass");
  };
  const running = Promise.all([
    executeTrial({ runTrial: slowPrepare, config }, job({ mutex, lane: laneOf(1) })),
    executeTrial({ runTrial: slowPrepare, config }, job({ mutex, lane: laneOf(2) })),
  ]);
  await firstArranged.promise;
  assert.deepEqual(events, ["arrange lane-1"]);
  finishFirst.resolve();
  await running;
  assert.deepEqual(events, ["arrange lane-1", "prepared lane-1", "arrange lane-2", "prepared lane-2"]);
});

test("a trial that returns before it was prepared frees the mutex for the next lane", async () => {
  const mutex = new ArrangementMutex();
  const early: TrialRunner = async () => result("error");
  await executeTrial({ runTrial: early, config }, job({ mutex }));
  (await mutex.acquire())();
});

test("a never-settling trial is aborted at goal timeout plus slack on the wall clock, then marks its server sick", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  let aborted = false;
  let settled = false;
  const neverSettles: TrialRunner = async input => {
    input.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    await input.onPrepared();
    return new Promise<RunResult>(() => {});
  };
  const started = monotonicNow();
  const running = executeTrial({ runTrial: neverSettles, config }, job());
  void running.then(() => { settled = true; });
  clock.stepWallClock(-1_700);
  await clock.advance(49, 1);
  assert.equal(aborted, false, "the goal timeout plus slack has not elapsed");
  await clock.advance(1, 1);
  assert.equal(aborted, true, "the goal timeout plus slack aborts the trial");
  await clock.advance(59, 1);
  assert.equal(settled, false, "an aborted trial still gets its full restore bound to settle");
  const end = await clock.settle(running, 1, 1);
  const elapsed = monotonicNow() - started;
  assert.ok(elapsed >= 30 + 20 + 60, `waited the goal timeout, the slack and the restore bound: ${elapsed} ms`);
  assert.ok(elapsed < 500, `and no longer: ${elapsed} ms`);
  assert.equal(end.result.outcome, "error");
  assert.match(end.result.error ?? "", /did not settle/u);
  assert.equal(end.lane, "held", "its arena may be mid-change: the lane is never handed out again");
  assert.equal(end.serverSick, true);
  assert.equal(end.hitWallBound, true);
});

test("the lane stays held while an aborted trial's restore runs, then frees", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const events: string[] = [];
  const restoring = Promise.withResolvers<void>();
  const finishRestore = Promise.withResolvers<void>();
  const honoursAbort: TrialRunner = async input => {
    await input.onPrepared();
    input.deferReset(async () => { restoring.resolve(); await finishRestore.promise; events.push("restore done"); });
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    return result("cancelled");
  };
  let settled = false;
  const running = executeTrial({ runTrial: honoursAbort, config }, job());
  void running.then(() => { settled = true; });
  await clock.advance(50, 1);
  await restoring.promise;
  assert.equal(settled, false, "the restore still owns its lane");
  finishRestore.resolve();
  const end = await running;
  events.push("lane released");
  assert.deepEqual(events, ["restore done", "lane released"]);
  assert.equal(end.lane, "free");
  assert.equal(end.hitWallBound, true);
  assert.equal(end.serverSick, false);
});

test("a restore that outlasts the restore bound marks the server sick and keeps the lane", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const restoring = Promise.withResolvers<void>();
  const slowRestore = runnerOf({ restore: () => { restoring.resolve(); return new Promise(() => {}); } });
  const running = executeTrial({ runTrial: slowRestore, config }, job());
  await restoring.promise;
  const end = await clock.settle(running, config.restoreBoundMs, 1);
  assert.equal(end.lane, "held");
  assert.equal(end.serverSick, true);
  assert.match(end.result.error ?? "", /restore did not finish/u);
});

test("a restore that throws quarantines the lane and leaves the server healthy", async () => {
  const end = await executeTrial({ runTrial: runnerOf({ restore: async () => { throw new Error("clone failed"); } }), config }, job());
  assert.equal(end.lane, "quarantined");
  assert.equal(end.serverSick, false);
  assert.equal(end.result.outcome, "pass", "the verdict stands; only the lane is lost");
});

test("a runner that throws is an error result and the lane is quarantined (no restore was handed over)", async () => {
  const end = await executeTrial({ runTrial: async () => { throw new Error("boom"); }, config }, job());
  assert.equal(end.result.outcome, "error");
  assert.match(end.result.error ?? "", /boom/u);
  assert.equal(end.lane, "quarantined");
});

test("the submitter cancelling ends the trial as cancelled, restore still runs", async () => {
  const events: string[] = [];
  const cancel = new AbortController();
  const listening = Promise.withResolvers<void>();
  const waitsForAbort: TrialRunner = async input => {
    await input.onPrepared();
    input.deferReset(async () => { events.push("restore"); });
    await new Promise<void>(resolve => {
      input.signal.addEventListener("abort", () => resolve(), { once: true });
      listening.resolve();
    });
    return result("cancelled");
  };
  const running = executeTrial({ runTrial: waitsForAbort, config }, job({ signal: cancel.signal, scenario: scenario(60) }));
  await listening.promise;
  cancel.abort("submitter left");
  const end = await running;
  assert.equal(end.result.outcome, "cancelled");
  assert.equal(end.hitWallBound, false);
  assert.deepEqual(events, ["restore"]);
  assert.equal(end.lane, "free");
});

test("a trial cancelled while it waits for the arrangement mutex never reaches the runner", async () => {
  const mutex = new ArrangementMutex();
  const holder = await mutex.acquire();
  const cancel = new AbortController();
  let ran = false;
  const running = executeTrial({ runTrial: async () => { ran = true; return result("pass"); }, config }, job({ mutex, signal: cancel.signal, scenario: scenario(60) }));
  cancel.abort("submitter left");
  const end = await running;
  holder();
  assert.equal(ran, false);
  assert.equal(end.result.outcome, "cancelled");
  assert.equal(end.lane, "free", "nothing was touched");
});

test("a scenario on its own server (no lane) restores at once without the mutex and passes no arena", async () => {
  const mutex = new ArrangementMutex();
  const holder = await mutex.acquire();
  const events: string[] = [];
  let seen: TrialRunInput | undefined;
  const runner: TrialRunner = async input => { seen = input; return runnerOf({ events })(input); };
  const end = await executeTrial({ runTrial: runner, config }, job({ lane: null, mutex, reuseServer: true }));
  holder();
  assert.equal(seen?.arena, undefined);
  assert.deepEqual(events, ["arrange", "prepared", "restore"]);
  assert.equal(end.lane, "free");
});

test("a scenario that cannot be reset runs without reuse and has no restore to wait for", async () => {
  let seen: TrialRunInput | undefined;
  const runner: TrialRunner = async input => { seen = input; await input.onPrepared(); return result("pass"); };
  const end = await executeTrial({ runTrial: runner, config }, job({ lane: null, reuseServer: false }));
  assert.equal(seen?.reuseServer, false);
  assert.equal(end.result.outcome, "pass");
  assert.equal(end.restored, false);
});

test("a trial that fails during its arrangement (before it was prepared) still restores its lane: the restore does not wait behind its own mutex", async () => {
  const failsInArrangement: TrialRunner = async input => {
    input.deferReset(async () => {});
    return { ...result("error"), error: "client exited" };
  };
  const mutex = new ArrangementMutex();
  const end = await executeTrial({ runTrial: failsInArrangement, config }, job({ mutex, scenario: scenario(60) }));
  (await mutex.acquire())();
  assert.equal(end.serverSick, false);
  assert.equal(end.lane, "free");
  assert.equal(end.restored, true);
  assert.equal(end.phases?.joinMs, 0, "an arrangement that failed has no join or trial time");
  assert.equal(end.phases?.trialMs, 0);
});

// `arranged` is what the scheduler asks of a trial on a server of its own when that server died: did anything of it run (R20).

test("a trial says it was arranged once its runner arranged or prepared, and not when the runner failed or the trial was cancelled before either", async () => {
  const arranges: TrialRunner = async input => { await input.onArranged(); return result("pass"); };
  const prepares: TrialRunner = async input => { await input.onPrepared(); return result("pass"); };
  const fails: TrialRunner = async () => { throw new Error("rcon closed"); };
  const returnsError: TrialRunner = async () => result("error");
  const own = { lane: null };
  assert.equal((await executeTrial({ runTrial: arranges, config }, job(own))).arranged, true, "onArranged");
  assert.equal((await executeTrial({ runTrial: prepares, config }, job(own))).arranged, true, "onPrepared alone");
  assert.equal((await executeTrial({ runTrial: arranges, config }, job())).arranged, true, "a lane trial");
  assert.equal((await executeTrial({ runTrial: fails, config }, job(own))).arranged, false, "the runner threw before arranging");
  assert.equal((await executeTrial({ runTrial: returnsError, config }, job(own))).arranged, false, "the runner returned an error before arranging");
  const mutex = new ArrangementMutex();
  const held = await mutex.acquire();
  const gone = new AbortController();
  const waiting = executeTrial({ runTrial: arranges, config }, job({ mutex, signal: gone.signal }));
  gone.abort("server died");
  const end = await waiting;
  assert.equal(end.result.outcome, "cancelled");
  assert.equal(end.arranged, false, "cancelled while waiting for the arrangement turn");
  held();
});

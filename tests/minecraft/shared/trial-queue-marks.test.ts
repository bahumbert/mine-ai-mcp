// The marks a trial writes in its server's mutex queue: arranged, restore queued, restore done, and what a failed or cancelled trial leaves.
import test from "node:test";
import assert from "node:assert/strict";
import { ArrangementMutex } from "./arrangement-mutex.ts";
import { executeTrial, type TrialJob, type TrialRunner } from "./trial.ts";
import { config, result, job, runnerOf } from "./trial-fixtures.ts";

/** The marks of a trial's place in its server's mutex queue, written down in the order they were called. */
function queueMarks(events: string[]): NonNullable<TrialJob["queue"]> {
  return {
    arranged: () => { if (!events.includes("arranged")) events.push("arranged"); }, restoreQueued: () => events.push("restoreQueued"),
    restoreDone: () => events.push("restoreDone"), leave: () => events.push("leave"),
  };
}

test("the queue marks follow the trial: arranged when the arrangement is done, the restore queued, then done", async () => {
  const events: string[] = [];
  const runner: TrialRunner = async input => {
    await input.onArranged();
    events.push("client joins");
    await input.onPrepared();
    input.deferReset(async () => { events.push("restore"); });
    return result("pass");
  };
  await executeTrial({ runTrial: runner, config }, job({ queue: queueMarks(events) }));
  assert.deepEqual(events, ["arranged", "client joins", "restoreQueued", "restore", "restoreDone"]);
});

test("a trial that fails before its arrangement ended still leaves the arrangement queue (arranged is marked once the trial is over)", async () => {
  const events: string[] = [];
  const failing: TrialRunner = async input => { input.deferReset(async () => {}); return result("error"); };
  await executeTrial({ runTrial: failing, config }, job({ queue: queueMarks(events) }));
  assert.equal(events[0], "arranged");
  assert.ok(events.includes("restoreDone"));
});

test("a cancelled trial that never reached the mutex marks nothing: the scheduler's leave takes it off", async () => {
  const mutex = new ArrangementMutex();
  const held = await mutex.acquire();
  const abort = new AbortController();
  const events: string[] = [];
  const pending = executeTrial({ runTrial: runnerOf(), config }, job({ mutex, signal: abort.signal, queue: queueMarks(events) }));
  abort.abort("cancelled");
  await pending;
  held();
  assert.deepEqual(events, []);
});

test("a restore the bound gave up on marks no restoreDone before the trial settles; its late end is marked after", async () => {
  const events: string[] = [];
  let finishRestore!: () => void;
  const runner: TrialRunner = async input => {
    await input.onPrepared();
    input.deferReset(() => new Promise<void>(resolve => { finishRestore = resolve; }));
    return result("pass");
  };
  const end = await executeTrial({ runTrial: runner, config }, job({ queue: queueMarks(events) }));
  assert.equal(end.serverSick, true);
  assert.deepEqual(events, ["arranged", "restoreQueued"]);
  finishRestore();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(events, ["arranged", "restoreQueued", "restoreDone"]);
});

test("a scenario on its own server has no queue to mark", async () => {
  const events: string[] = [];
  await executeTrial({ runTrial: runnerOf(), config }, job({ lane: null, queue: queueMarks(events) }));
  assert.deepEqual(events, []);
});

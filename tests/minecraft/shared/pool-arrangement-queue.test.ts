// A server's mutex queue: a trial counts in it from admission, a restore from queued, and the hold of the server is measured from the trials that settled.
import test from "node:test";
import assert from "node:assert/strict";
import { ServerPool } from "./pool.ts";
import { config, end, setup, readyShared } from "./pool-fixtures.ts";
import type { TrialEnd } from "./trial.ts";

function withPhases(arrangeMs: number, restoreMs: number, overrides: Partial<TrialEnd> = {}): TrialEnd {
  return end({ phases: { mutexWaitMs: 50, arrangeMs, joinMs: 9_000, trialMs: 5_000, restoreWaitMs: 40, restoreMs }, ...overrides });
}

const queueOf = (pool: ServerPool, id: string) => pool.queues([id]).get(id)!;

test("a trial counts in its server's mutex queue from admission until its arrangement is done, and a restore from queued until done", async () => {
  const { pool } = setup();
  const managed = await readyShared(pool);
  const lane = pool.leaseLane(managed.id)!;
  const marks = pool.joinMutexQueue(managed.id)!;
  assert.equal(queueOf(pool, managed.id).queued, 1, "admitted, not arranged");
  marks.arranged();
  assert.equal(queueOf(pool, managed.id).queued, 0);
  marks.restoreQueued();
  assert.equal(queueOf(pool, managed.id).queued, 1);
  marks.restoreDone();
  assert.equal(queueOf(pool, managed.id).queued, 0);
  pool.finishTrial(managed.id, lane, end(), 10);
});

test("each mark counts once however often it is called", async () => {
  const { pool } = setup();
  const managed = await readyShared(pool);
  pool.leaseLane(managed.id);
  const marks = pool.joinMutexQueue(managed.id)!;
  const other = pool.joinMutexQueue(managed.id)!;
  assert.equal(queueOf(pool, managed.id).queued, 2);
  marks.arranged();
  marks.arranged();
  marks.restoreDone();
  assert.equal(queueOf(pool, managed.id).queued, 1, "a second arranged() or a restoreDone() with no restore queued takes nothing off another trial");
  other.leave();
  other.leave();
  assert.equal(queueOf(pool, managed.id).queued, 0);
});

test("a trial aborted between admission and its arrangement leaves the queue when it settles", async () => {
  const { pool } = setup();
  const managed = await readyShared(pool);
  const lane = pool.leaseLane(managed.id)!;
  const marks = pool.joinMutexQueue(managed.id)!;
  assert.equal(queueOf(pool, managed.id).queued, 1);
  marks.leave();
  pool.finishTrial(managed.id, lane, end({ lane: "free" }), 10);
  assert.equal(queueOf(pool, managed.id).queued, 0);
});

test("a restore that never ends leaves the queue with the trial (the restore bound gave up on it)", async () => {
  const { pool } = setup();
  const managed = await readyShared(pool);
  pool.leaseLane(managed.id);
  const marks = pool.joinMutexQueue(managed.id)!;
  marks.arranged();
  marks.restoreQueued();
  assert.equal(queueOf(pool, managed.id).queued, 1);
  marks.leave();
  assert.equal(queueOf(pool, managed.id).queued, 0);
  marks.restoreDone();
  assert.equal(queueOf(pool, managed.id).queued, 0, "the restore finishing later takes nothing off");
});

test("the hold of a server is ARRANGE_HOLD_MS until 3 of its trials settled, then the median of arrange + restore over the last 20", async () => {
  const { pool } = setup();
  const managed = await readyShared(pool);
  assert.equal(queueOf(pool, managed.id).holdMs, config.arrangeHoldMs);
  const settle = (arrange: number, restore: number) => {
    const lane = pool.leaseLane(managed.id)!;
    pool.finishTrial(managed.id, lane, withPhases(arrange, restore), 10);
  };
  settle(300, 100);
  settle(900, 100);
  assert.equal(queueOf(pool, managed.id).holdMs, config.arrangeHoldMs, "two settled: still the default");
  settle(500, 100);
  assert.equal(queueOf(pool, managed.id).holdMs, 600, "median of 400, 1000, 600");
  for (let trial = 0; trial < 20; trial++) settle(100, 50);
  assert.equal(queueOf(pool, managed.id).holdMs, 150, "only the last 20 count");
});

test("the mutex wait and the join are not part of the hold, and an end with no phases adds nothing", async () => {
  const { pool } = setup();
  const managed = await readyShared(pool);
  for (let trial = 0; trial < 3; trial++) pool.finishTrial(managed.id, pool.leaseLane(managed.id)!, withPhases(200, 100), 10);
  pool.finishTrial(managed.id, pool.leaseLane(managed.id)!, end(), 10);
  assert.equal(queueOf(pool, managed.id).holdMs, 300);
});

test("a trial that was cancelled or failed (not restored) adds nothing to the hold", async () => {
  const { pool } = setup();
  const managed = await readyShared(pool);
  for (let trial = 0; trial < 3; trial++) pool.finishTrial(managed.id, pool.leaseLane(managed.id)!, withPhases(300, 100), 10);
  for (let trial = 0; trial < 5; trial++) pool.finishTrial(managed.id, pool.leaseLane(managed.id)!, withPhases(0, 0, { restored: false }), 10);
  pool.finishTrial(managed.id, pool.leaseLane(managed.id)!, withPhases(60_000, 0, { restored: false }), 10);
  assert.equal(queueOf(pool, managed.id).holdMs, 400);
});

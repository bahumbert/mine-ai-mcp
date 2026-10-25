// The arrangement mutex around a trial: free once the lane is arranged, held again by a restore, and a client that never joins.
import test from "node:test";
import assert from "node:assert/strict";
import { laneOf } from "../arena/lanes.ts";
import { ArrangementMutex } from "./arrangement-mutex.ts";
import { executeTrial, type TrialRunner } from "./trial.ts";
import { config, scenario, result, job } from "./trial-fixtures.ts";

/** A runner that has arranged its lane but is still booting its client: it waits for `joined` before it prepares. */
function joiningRunner(steps: { events?: string[]; joined: Promise<void> }): TrialRunner {
  return async input => {
    steps.events?.push(`arranged ${input.arena?.id}`);
    await input.onArranged();
    await steps.joined;
    await input.onPrepared();
    input.deferReset(async () => { steps.events?.push(`restore ${input.arena?.id}`); });
    return result("pass");
  };
}

/** The mutex turn if it is free within `ms`, else null. */
async function turnWithin(mutex: ArrangementMutex, ms: number): Promise<(() => void) | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const none = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([mutex.acquire(), none]);
  } finally {
    clearTimeout(timer);
  }
}

test("the arrangement mutex is free once the lane is arranged: the next lane arranges while the first lane's client still joins", async () => {
  const mutex = new ArrangementMutex();
  const events: string[] = [];
  let finishJoin!: () => void;
  const joined = new Promise<void>(resolve => { finishJoin = resolve; });
  const first = executeTrial({ runTrial: joiningRunner({ events, joined }), config }, job({ mutex, lane: laneOf(1), scenario: scenario(60) }));
  await new Promise(resolve => setTimeout(resolve, 10));
  const secondTurn = await turnWithin(mutex, 100);
  assert.notEqual(secondTurn, null, "the first lane is still joining and no longer holds the mutex");
  secondTurn?.();
  finishJoin();
  await first;
  assert.deepEqual(events, ["arranged lane-1", "restore lane-1"]);
});

test("a client that never joins leaves the mutex free until the wall bound aborts the trial, then the restore takes it again", async () => {
  const mutex = new ArrangementMutex();
  const events: string[] = [];
  const neverJoins: TrialRunner = async input => {
    await input.onArranged();
    input.deferReset(async () => { events.push("restore"); });
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    events.push("aborted");
    return result("cancelled");
  };
  // The wall bound (0.3 s goal timeout + 20 ms slack) comes well after the 100 ms window: only onArranged can free the mutex inside it.
  const running = executeTrial({ runTrial: neverJoins, config }, job({ mutex, lane: laneOf(1), scenario: scenario(0.3) }));
  await new Promise(resolve => setTimeout(resolve, 5));
  const other = await turnWithin(mutex, 100);
  assert.notEqual(other, null, "another lane can arrange while this client never joins");
  other?.();
  const end = await running;
  assert.equal(end.hitWallBound, true);
  assert.equal(end.lane, "free");
  assert.equal(end.restored, true);
  assert.deepEqual(events, ["aborted", "restore"]);
});

test("a restore after an abort between arranged and prepared queues behind a lane that is arranging", async () => {
  const mutex = new ArrangementMutex();
  const cancel = new AbortController();
  const events: string[] = [];
  const abortedWhileJoining: TrialRunner = async input => {
    await input.onArranged();
    input.deferReset(async () => { events.push("restore"); });
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    return result("cancelled");
  };
  const running = executeTrial({ runTrial: abortedWhileJoining, config }, job({ mutex, lane: laneOf(1), signal: cancel.signal, scenario: scenario(60) }));
  await new Promise(resolve => setTimeout(resolve, 5));
  const arranging = await mutex.acquire();
  cancel.abort("submitter left");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(events, [], "the restore waits for the lane that is arranging");
  arranging();
  const end = await running;
  assert.deepEqual(events, ["restore"]);
  assert.equal(end.lane, "free");
});

test("an onArranged that comes after the mutex was released, or twice, changes nothing", async () => {
  const mutex = new ArrangementMutex();
  const odd: TrialRunner = async input => {
    await input.onPrepared();
    await input.onArranged();
    await input.onArranged();
    input.deferReset(async () => {});
    return result("pass");
  };
  const end = await executeTrial({ runTrial: odd, config }, job({ mutex }));
  assert.equal(end.lane, "free");
  (await mutex.acquire())();
});

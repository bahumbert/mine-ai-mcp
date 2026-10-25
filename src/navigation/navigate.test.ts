/**
 * What `runNavigation` adds over the navigator it drives: one composed stop
 * signal, one result shape, and the words a caller reads when a route ends.
 * The navigator is a fake here so that only the wrapper is under test; the
 * engine's own stopping and cleanup are proven in `orchestration/`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { exactBlockGoal } from "./goals/index.js";
import { createMovementPolicy } from "./movements/policy.js";
import { runNavigation } from "./navigate.js";
import type { NavigationRequest, Navigator } from "./orchestration/navigator.js";
import type { NavigationEvidence, NavigationFailure, NavigationOutcome } from "./orchestration/outcome.js";

const evidence = (unrestoredPassages: NavigationEvidence["unrestoredPassages"] = []) =>
  ({ unrestoredPassages }) as unknown as NavigationEvidence;

/** A navigator that records each request and settles it as the test says, or reports itself busy. */
function fakeNavigator(
  outcome: (request: NavigationRequest) => NavigationOutcome | Promise<NavigationOutcome>,
  busyWith: string | null = null,
) {
  const requests: NavigationRequest[] = [];
  const navigator = {
    startRun(request: NavigationRequest) {
      requests.push(request);
      if (busyWith) return { kind: "busy", activeRunId: busyWith } as const;
      return {
        kind: "started",
        handle: { runId: "fake", outcome: Promise.resolve(outcome(request)), cancel: () => undefined },
      } as const;
    },
    setStepFieldProvider: () => undefined,
    active: null,
    cancelActive: () => undefined,
    terminateActive: () => undefined,
    abandonActive: () => undefined,
  } satisfies Navigator;
  return { navigator, requests };
}

/** Settles as stopped once the run's composed signal fires, naming what the signal carried. */
const whenStopped = (request: NavigationRequest) =>
  new Promise<NavigationOutcome>((resolve) => {
    const signal = request.signal!;
    const settle = () => {
      const reason: unknown = signal.reason;
      resolve({
        kind: "stopped",
        reason: typeof reason === "string" ? reason : (reason as Error).name,
        evidence: evidence(),
      });
    };
    if (signal.aborted) settle();
    else signal.addEventListener("abort", settle, { once: true });
  });

const request = { movements: createMovementPolicy(), goal: exactBlockGoal({ x: 6, y: 63, z: 0 }) };

test("every way a route may stop is composed into the one signal the engine takes, and only the action's is rethrown", async () => {
  // A stop signal's words survive as the reason.
  const stop = new AbortController();
  const { navigator: stoppable } = fakeNavigator(whenStopped);
  const stopped = runNavigation(stoppable, { ...request, stopSignal: stop.signal });
  stop.abort("the requested quantity is in the inventory");
  const byStop = await stopped;
  assert.deepEqual(
    [byStop.status, byStop.status === "stopped" && byStop.reason],
    ["stopped", "the requested quantity is in the inventory"],
  );

  // The wrapper's own patience arms a timeout the engine reads as one.
  const { navigator: patient } = fakeNavigator(whenStopped);
  const timedOut = await runNavigation(patient, { ...request, timeoutMs: 5 });
  assert.equal(timedOut.status, "stopped");
  if (timedOut.status === "stopped") assert.equal(timedOut.reason, "TimeoutError");

  // The action's own cancellation is not a route result: before the run it
  // never starts one, and during the run it is rethrown to the action runner.
  const early = new AbortController();
  early.abort(new Error("action cancelled"));
  const { navigator: unstarted, requests } = fakeNavigator(whenStopped);
  await assert.rejects(runNavigation(unstarted, { ...request, signal: early.signal }), /action cancelled/);
  assert.equal(requests.length, 0);

  const late = new AbortController();
  const { navigator: interrupted } = fakeNavigator((run) => {
    late.abort(new Error("reflex took the body"));
    return whenStopped(run);
  });
  await assert.rejects(runNavigation(interrupted, { ...request, signal: late.signal }), /reflex took the body/);
});

test("a settled outcome becomes one result: failures in their own words, doorways left open appended, busy refused", async () => {
  const completed = await runNavigation(
    fakeNavigator(() => ({ kind: "completed", evidence: evidence() })).navigator,
    request,
  );
  assert.equal(completed.status, "completed");

  const failed = await runNavigation(
    fakeNavigator(() => ({
      kind: "failed",
      failure: { kind: "no_progress", reason: "repeated_search", observation: "same question twice" },
      evidence: evidence(),
    })).navigator,
    request,
  );
  assert.deepEqual(
    [failed.status, failed.status === "stopped" && failed.reason],
    ["stopped", "repeated_search: same question twice"],
  );
  const stalled = await runNavigation(
    fakeNavigator(() => ({
      kind: "failed",
      failure: { kind: "no_progress", reason: "planning_stalled", observation: "20000 ms without a route commitment" },
      evidence: evidence(),
    })).navigator,
    request,
  );
  assert.equal(stalled.status, "stopped");
  assert.match(stalled.status === "stopped" ? stalled.reason : "", /planning_stalled: 20000 ms/);

  const doorway = [{ position: { x: 1, y: 63, z: 2 }, observation: "still open" }];
  const unrestored = await runNavigation(
    fakeNavigator(() => ({ kind: "stopped", reason: "no route", evidence: evidence(doorway) })).navigator,
    request,
  );
  assert.deepEqual(
    [unrestored.status, unrestored.status === "stopped" && unrestored.reason],
    ["stopped", "no route Doorway at 1,63,2: still open"],
  );

  // A cancelled action that left a door open says so in the error it throws.
  const cancelled = new AbortController();
  await assert.rejects(
    runNavigation(
      fakeNavigator(() => {
        cancelled.abort(new Error("cancelled"));
        return { kind: "completed", evidence: evidence(doorway) };
      }).navigator,
      { ...request, signal: cancelled.signal },
    ),
    /Navigation cancelled\. Doorway at 1,63,2: still open/,
  );

  await assert.rejects(runNavigation(fakeNavigator(whenStopped, "run-7").navigator, request), /busy with run run-7/);
});

test("a route ended by a failed break names the block, and only a break is named", async () => {
  const movement = (kind: "break" | "place") => ({
    kind: "operation_failed" as const,
    stepId: "dig",
    phase: "breaking" as const,
    observation: "No face of the block at 8,-57,0 is in view",
    operation: { kind, position: { x: 8, y: -57, z: 0 } },
  });
  const repeated = await runNavigation(
    fakeNavigator(() => ({
      kind: "failed",
      failure: {
        kind: "no_progress",
        reason: "repeated_movement_failure",
        observation: "No face of the block at 8,-57,0 is in view",
        movement: movement("break"),
      },
      evidence: evidence(),
    })).navigator,
    request,
  );
  assert.deepEqual(repeated.status === "stopped" && repeated.failedBreak, { x: 8, y: -57, z: 0 });

  const once = await runNavigation(
    fakeNavigator(() => ({ kind: "failed", failure: { kind: "movement_failed", movement: movement("break") }, evidence: evidence() })).navigator,
    request,
  );
  assert.deepEqual(once.status === "stopped" && once.failedBreak, { x: 8, y: -57, z: 0 });

  const placement = await runNavigation(
    fakeNavigator(() => ({ kind: "failed", failure: { kind: "movement_failed", movement: movement("place") }, evidence: evidence() })).navigator,
    request,
  );
  assert.equal(placement.status === "stopped" && placement.failedBreak, undefined);
});

test("a route is marked failed only when the route or the movement itself failed", async () => {
  const closest = { position: { x: 0, y: 63, z: 0 }, heuristic: 1, routeCost: 1, basis: "best_heuristic_search_node" as const };
  const search = { queued: 0, visited: 9, farthestVisited: 3, generated: 9, slices: 1, computeMs: 5 };
  const movement = { kind: "operation_failed" as const, stepId: "s", phase: "moving" as const, observation: "no" };
  const failures: ReadonlyArray<readonly [NavigationFailure, boolean]> = [
    [{ kind: "no_path", search, closest }, true],
    [{ kind: "search_limit", search, limit: { kind: "search_time", limit: 2000, observed: 2001, closest } }, true],
    [{ kind: "no_progress", reason: "planning_stalled", observation: "20000 ms" }, true],
    [{ kind: "movement_failed", movement }, true],
    [{ kind: "invalid_goal", observation: "the goal is a portal" }, false],
    [{ kind: "world_unavailable", observation: "chunks not loaded" }, false],
    [{ kind: "resource_changed", observation: "the pickaxe is gone" }, false],
    [{ kind: "restoration_incomplete", observation: "a doorway stayed open" }, false],
    [{ kind: "internal_error", message: "boom" }, false],
  ];
  for (const [failure, expected] of failures) {
    const result = await runNavigation(fakeNavigator(() => ({ kind: "failed", failure, evidence: evidence() })).navigator, request);
    assert.equal(result.status === "stopped" && result.routeFailed === true, expected, failure.kind);
  }
  const stopped = await runNavigation(fakeNavigator(() => ({ kind: "stopped", reason: "the pickaxe broke", evidence: evidence() })).navigator, request);
  assert.equal(stopped.status === "stopped" && stopped.routeFailed, undefined);
});

test("an escape request reaches the run as an escape, and a plain one does not", async () => {
  const { navigator, requests } = fakeNavigator(() => ({ kind: "completed", evidence: evidence() }));
  await runNavigation(navigator, { ...request, escape: true });
  await runNavigation(navigator, request);
  assert.deepEqual(requests.map((started) => started.escape), [true, undefined]);
});

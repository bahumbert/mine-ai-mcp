import test from "node:test";
import assert from "node:assert/strict";
import type { RunResult, Scenario } from "mine-labs";
import { fixtureScenario } from "./scenario-fixture.ts";
import { laneOf } from "../arena/lanes.ts";
import { ArrangementMutex } from "./arrangement-mutex.ts";
import { loadScenarioServerConfig } from "./config.ts";
import type { ScenarioServer } from "./scenario-server.ts";
import { executeTrial, type TrialJob, type TrialRunInput, type TrialRunner } from "./trial.ts";

const config = loadScenarioServerConfig({ MINE_AI_SCENARIO_TRIAL_SLACK_MS: "20", MINE_AI_SCENARIO_RESTORE_BOUND_MS: "60" });

const server: ScenarioServer = {
  id: "s1", kind: "shared", gamePort: 25_400, heapMb: 3_072,
  command: async () => "", javaPid: () => null, stop: async () => {},
};

function scenario(timeoutSeconds = 0.03): Scenario {
  return fixtureScenario(timeoutSeconds);
}

function result(outcome: RunResult["outcome"]): RunResult {
  return { scenario: "demo", outcome, elapsedMs: 5, goal: { state: outcome === "pass" ? "passed" : "pending", detail: "" }, goalText: "" };
}

function job(overrides: Partial<TrialJob> = {}): TrialJob {
  return {
    name: "demo", scenario: scenario(), lane: laneOf(3), server, mutex: new ArrangementMutex(), runDir: "/tmp/run", log: () => {},
    signal: new AbortController().signal, reuseServer: true, ...overrides,
  };
}

/** A runner that prepares, then ends with `outcome`, leaving `restore` to be run by the caller. */
function runnerOf(steps: { outcome?: RunResult["outcome"]; restore?: () => Promise<void>; events?: string[] } = {}): TrialRunner {
  return async (input: TrialRunInput) => {
    steps.events?.push("arrange");
    await input.onPrepared();
    steps.events?.push("prepared");
    input.deferReset(steps.restore ?? (async () => { steps.events?.push("restore"); }));
    return result(steps.outcome ?? "pass");
  };
}

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
  const slowPrepare: TrialRunner = async input => {
    events.push(`arrange ${input.arena?.id}`);
    await new Promise(resolve => setTimeout(resolve, 10));
    await input.onPrepared();
    events.push(`prepared ${input.arena?.id}`);
    input.deferReset(async () => {});
    return result("pass");
  };
  await Promise.all([
    executeTrial({ runTrial: slowPrepare, config }, job({ mutex, lane: laneOf(1) })),
    executeTrial({ runTrial: slowPrepare, config }, job({ mutex, lane: laneOf(2) })),
  ]);
  assert.deepEqual(events, ["arrange lane-1", "prepared lane-1", "arrange lane-2", "prepared lane-2"]);
});

test("a trial that returns before it was prepared frees the mutex for the next lane", async () => {
  const mutex = new ArrangementMutex();
  const early: TrialRunner = async () => result("error");
  await executeTrial({ runTrial: early, config }, job({ mutex }));
  (await mutex.acquire())();
});

test("a never-settling trial is aborted at goal timeout plus slack on the wall clock, then marks its server sick", async () => {
  const neverSettles: TrialRunner = async input => { await input.onPrepared(); return new Promise<RunResult>(() => {}); };
  const started = Date.now();
  const end = await executeTrial({ runTrial: neverSettles, config }, job());
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 30 + 20 + 60, `waited the goal timeout, the slack and the restore bound: ${elapsed} ms`);
  assert.ok(elapsed < 500, `and no longer: ${elapsed} ms`);
  assert.equal(end.result.outcome, "error");
  assert.match(end.result.error ?? "", /did not settle/u);
  assert.equal(end.lane, "held", "its arena may be mid-change: the lane is never handed out again");
  assert.equal(end.serverSick, true);
  assert.equal(end.hitWallBound, true);
});

test("the lane stays held while an aborted trial's restore runs, then frees", async () => {
  const events: string[] = [];
  const honoursAbort: TrialRunner = async input => {
    await input.onPrepared();
    input.deferReset(async () => { await new Promise(resolve => setTimeout(resolve, 25)); events.push("restore done"); });
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    return result("cancelled");
  };
  const end = await executeTrial({ runTrial: honoursAbort, config }, job());
  events.push("lane released");
  assert.deepEqual(events, ["restore done", "lane released"]);
  assert.equal(end.lane, "free");
  assert.equal(end.hitWallBound, true);
  assert.equal(end.serverSick, false);
});

test("a restore that outlasts the restore bound marks the server sick and keeps the lane", async () => {
  const slowRestore = runnerOf({ restore: () => new Promise(() => {}) });
  const end = await executeTrial({ runTrial: slowRestore, config }, job());
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
  const waitsForAbort: TrialRunner = async input => {
    await input.onPrepared();
    input.deferReset(async () => { events.push("restore"); });
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    return result("cancelled");
  };
  const running = executeTrial({ runTrial: waitsForAbort, config }, job({ signal: cancel.signal, scenario: scenario(60) }));
  await new Promise(resolve => setTimeout(resolve, 10));
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

test("the time spent waiting for the arrangement mutex is reported", async () => {
  const mutex = new ArrangementMutex();
  const holder = await mutex.acquire();
  const running = executeTrial({ runTrial: runnerOf(), config }, job({ mutex, scenario: scenario(60) }));
  setTimeout(() => { holder(); }, 30);
  const end = await running;
  assert.ok(end.mutexWaitMs >= 25, `waited ${end.mutexWaitMs} ms`);
});

test("a trial that fails during its arrangement (before it was prepared) still restores its lane: the restore does not wait behind its own mutex", async () => {
  const failsInArrangement: TrialRunner = async input => {
    input.deferReset(async () => {});
    return { ...result("error"), error: "client exited" };
  };
  const end = await executeTrial({ runTrial: failsInArrangement, config }, job({ scenario: scenario(60) }));
  assert.equal(end.serverSick, false);
  assert.equal(end.lane, "free");
  assert.equal(end.restored, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import type { ClientProvider, RunResult, Scenario } from "mine-labs";
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

test("the six trial phases are measured apart and written as one line to the run's log", async () => {
  const mutex = new ArrangementMutex();
  const lines: string[] = [];
  const holder = await mutex.acquire();
  const phased: TrialRunner = async input => {
    await new Promise(resolve => setTimeout(resolve, 20));
    await input.onArranged();
    await new Promise(resolve => setTimeout(resolve, 30));
    await input.onPrepared();
    input.deferReset(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
    await new Promise(resolve => setTimeout(resolve, 40));
    return result("pass");
  };
  const running = executeTrial({ runTrial: phased, config }, job({ mutex, log: line => lines.push(line), scenario: scenario(60) }));
  setTimeout(() => { holder(); }, 25);
  const end = await running;
  const phases = end.phases;
  assert.ok(phases, "a trial that ran reports its phases");
  assert.ok(phases.mutexWaitMs >= 20, `mutexWait ${phases.mutexWaitMs}`);
  assert.ok(phases.arrangeMs >= 15, `arrange ${phases.arrangeMs}`);
  assert.ok(phases.joinMs >= 25, `join ${phases.joinMs}`);
  assert.ok(phases.trialMs >= 35, `trial ${phases.trialMs}`);
  assert.ok(phases.restoreMs >= 10, `restore ${phases.restoreMs}`);
  assert.equal(phases.mutexWaitMs, end.mutexWaitMs);
  const written = lines.filter(text => text.startsWith("phases: "));
  assert.equal(written.length, 1);
  assert.match(written[0]!, /^phases: mutexWait=\d+ arrange=\d+ join=\d+ trial=\d+ restoreWait=\d+ restore=\d+$/u);
});

test("the restore wait is told apart from the restore itself when another lane holds the mutex", async () => {
  const mutex = new ArrangementMutex();
  const runner: TrialRunner = async input => {
    await input.onPrepared();
    input.deferReset(async () => {});
    const neighbour = await mutex.acquire();
    setTimeout(neighbour, 40);
    return result("pass");
  };
  const end = await executeTrial({ runTrial: runner, config }, job({ mutex, scenario: scenario(60) }));
  assert.ok((end.phases?.restoreWaitMs ?? 0) >= 30, `waited ${end.phases?.restoreWaitMs} ms`);
  assert.ok((end.phases?.restoreMs ?? 99) < (end.phases?.restoreWaitMs ?? 0), `restore took ${end.phases?.restoreMs} ms`);
});

test("a restore the bound gave up on reports the time it had waited or run so far, not 0", async () => {
  const mutex = new ArrangementMutex();
  let neighbour!: () => void;
  const neighbourArranges: TrialRunner = async input => {
    await input.onPrepared();
    input.deferReset(async () => {});
    neighbour = await mutex.acquire();
    return result("pass");
  };
  const stuckBehindNeighbour = await executeTrial({ runTrial: neighbourArranges, config }, job({ mutex, scenario: scenario(60) }));
  assert.equal(stuckBehindNeighbour.serverSick, true);
  assert.ok((stuckBehindNeighbour.phases?.restoreWaitMs ?? 0) >= 50, `waited ${stuckBehindNeighbour.phases?.restoreWaitMs} ms`);
  assert.equal(stuckBehindNeighbour.phases?.restoreMs, 0, "it never got its turn");
  neighbour();
  const hangs = await executeTrial({ runTrial: runnerOf({ restore: () => new Promise(() => {}) }), config }, job({ scenario: scenario(60) }));
  assert.ok((hangs.phases?.restoreMs ?? 0) >= 50, `ran ${hangs.phases?.restoreMs} ms`);
});

test("a scenario on its own server has no mutex wait and no restore wait in its phases", async () => {
  const end = await executeTrial({ runTrial: runnerOf(), config }, job({ lane: null }));
  assert.equal(end.phases?.mutexWaitMs, 0);
  assert.equal(end.phases?.restoreWaitMs, 0);
});

test("a trial cancelled while it waits for the mutex still reports its phases", async () => {
  const mutex = new ArrangementMutex();
  const holder = await mutex.acquire();
  const cancel = new AbortController();
  const lines: string[] = [];
  const running = executeTrial({ runTrial: runnerOf(), config }, job({ mutex, signal: cancel.signal, log: line => lines.push(line), scenario: scenario(60) }));
  setTimeout(() => cancel.abort("left"), 15);
  const end = await running;
  holder();
  assert.ok((end.phases?.mutexWaitMs ?? 0) >= 10);
  assert.equal(end.phases?.arrangeMs, 0);
  assert.ok(lines.some(text => text.startsWith("phases: ")));
});

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

// T7h-b: a client booted ahead moves the boot out of `join`: join runs from the first `init`, the settle delay before it is its own phase.
function providedClient(): ClientProvider {
  return () => undefined;
}

test("a runner that asks for its client after the settle delay gets a settle phase, and join runs from that ask to prepared", async () => {
  const lines: string[] = [];
  const asking: TrialRunner = async input => {
    await input.onArranged();
    await new Promise(resolve => setTimeout(resolve, 40));
    input.clientProvider?.({ command: "bun", args: [], env: {} }, "Walker");
    await new Promise(resolve => setTimeout(resolve, 25));
    await input.onPrepared();
    input.deferReset(async () => {});
    return result("pass");
  };
  const end = await executeTrial({ runTrial: asking, config }, job({ log: line => lines.push(line), scenario: scenario(60), clientProvider: providedClient() }));
  const phases = end.phases!;
  assert.ok((phases.settleMs ?? 0) >= 35, `settle ${phases.settleMs}`);
  assert.ok(phases.joinMs >= 20 && phases.joinMs < 38, `join ${phases.joinMs}: the 40 ms before the ask are not in it`);
  assert.match(lines.find(text => text.startsWith("phases: "))!, /^phases: mutexWait=\d+ arrange=\d+ settle=\d+ join=\d+ trial=\d+ restoreWait=\d+ restore=\d+$/u);
});

test("the provider the scheduler gave is the one the runner is handed, and its answer is passed on unchanged", async () => {
  const asked: string[] = [];
  const provider: ClientProvider = (_client, username) => { asked.push(username); return undefined; };
  let handed: ClientProvider | undefined;
  const runner: TrialRunner = async input => {
    handed = input.clientProvider;
    await input.onPrepared();
    input.deferReset(async () => {});
    return result("pass");
  };
  await executeTrial({ runTrial: runner, config }, job({ clientProvider: provider }));
  assert.equal(handed?.({ command: "bun", args: [], env: {} }, "Walker"), undefined);
  assert.deepEqual(asked, ["Walker"]);
});

test("a trial given no provider hands its runner none, and its phases keep today's six", async () => {
  let handed: ClientProvider | undefined = providedClient();
  const runner: TrialRunner = async input => { handed = input.clientProvider; return runnerOf()(input); };
  const lines: string[] = [];
  const end = await executeTrial({ runTrial: runner, config }, job({ log: line => lines.push(line) }));
  assert.equal(handed, undefined);
  assert.equal(end.phases?.settleMs, undefined);
  assert.match(lines.find(text => text.startsWith("phases: "))!, /^phases: mutexWait=\d+ arrange=\d+ join=\d+ trial=\d+ restoreWait=\d+ restore=\d+$/u);
});

test("a provider that throws ends the trial with its message, the lane freed", async () => {
  const mutex = new ArrangementMutex();
  const provider: ClientProvider = () => { throw new Error("scenario client 'bun client-host.ts' failed to boot 2 times in a row"); };
  const runner: TrialRunner = async input => {
    await input.onArranged();
    input.clientProvider?.({ command: "bun", args: [], env: {} }, "Walker");
    return result("pass");
  };
  const end = await executeTrial({ runTrial: runner, config }, job({ mutex, clientProvider: provider }));
  assert.equal(end.result.outcome, "error");
  assert.match(end.result.error ?? "", /trial threw: scenario client 'bun client-host\.ts' failed to boot 2 times in a row/u);
  assert.equal(end.lane, "quarantined");
  (await mutex.acquire())();
});

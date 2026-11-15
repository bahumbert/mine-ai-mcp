// Infra retries exercise the real scheduler, pool and ledger with controlled runner ends.
import test from "node:test";
import assert from "node:assert/strict";
import type { RunResult } from "mine-labs";
import { createFakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { ClientsAhead } from "./client-ahead.ts";
import { spec } from "./pool-fixtures.ts";
import { fixtureScenario } from "./scenario-fixture.ts";
import { lanePlacement, SchedulerRig } from "./scheduler-rig.ts";
import { Scheduler, type SubmissionEvent } from "./scheduler.ts";
import { settlesWithin } from "./settles-within.ts";
import type { TrialRunInput } from "./trial.ts";

interface Attempt {
  readonly input: TrialRunInput;
  readonly result: PromiseWithResolvers<RunResult>;
}

/** Uses the existing server double; runner callbacks follow Mine Labs' trial/run.ts lifecycle. */
async function retryRig(servers = 2) {
  const rig = new SchedulerRig();
  for (let index = 0; index < servers; index++) await rig.pool.startServer(spec({ key: "k" }), rig.clock).ready;
  const attempts: Attempt[] = [];
  const events: SubmissionEvent[] = [];
  const finished: string[] = [];
  const written = new Map<string, RunResult>();
  const clientEnds: (boolean | undefined)[] = [];
  const ahead = new ClientsAhead({ config: rig.config, log: () => {} });
  const trialEnded = ahead.trialEnded.bind(ahead);
  ahead.trialEnded = (sequence, options) => { clientEnds.push(options?.sentBack); trialEnded(sequence, options); };
  const finishTrial = rig.pool.finishTrial.bind(rig.pool);
  rig.pool.finishTrial = (...args) => { finished.push(args[0]); finishTrial(...args); };
  const scheduler = new Scheduler({ pool: rig.pool, config: rig.config, now: () => rig.clock, clientsAhead: ahead,
    log: line => rig.logs.push(line),
    runIo: { open: async () => ({ log: () => {}, close: async () => {} }), writeResult: async (dir, result) => { written.set(dir, result); } },
    runTrial: async input => {
      await input.onArranged();
      await input.onPrepared();
      const result = Promise.withResolvers<RunResult>();
      attempts.push({ input, result });
      return result.promise;
    },
  });
  const base = fixtureScenario(60, "a");
  const scenario = { ...base, client: { ...base.client, args: ["other-driver.ts"] } };
  const handle = scheduler.submit({ entries: [{ name: "a", scenario, placement: lanePlacement("k") }], repeat: 1,
    maxLanes: null, lock: false, hold: false, outDir: "/tmp/out", emit: event => events.push(event) });
  const sample = (memAvailableMb = 28_000) => scheduler.onSample({ cpuBusy: 0.2, memAvailableMb, threads: 24 }, rig.clock);
  rig.factory.failNextStart = servers === 0;
  sample();
  await rig.settle();
  return { rig, scheduler, handle, attempts, events, finished, written, clientEnds, sample };
}

/** Resolves the runner's actual result, including the transport field Mine Labs records at its RCON boundary. */
function finish(attempt: Attempt, outcome: RunResult["outcome"] = "pass", transportFailure?: string): void {
  attempt.result.resolve({ scenario: "a", outcome, elapsedMs: 1, goal: { state: outcome === "pass" ? "passed" : "failed", detail: outcome },
    goalText: "", ...(transportFailure === undefined ? {} : { transportFailure }) });
}

/** The sampler confirms a dead java with two absent readings; no invented game packets. */
function killServer(rig: SchedulerRig, id: string): void {
  rig.pool.noteJavaProcess(id, false);
  rig.pool.noteJavaProcess(id, false);
  rig.pool.stopDeadJava();
}

test("a death after arrangement runs again on the other server and passes", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const { rig, scheduler, handle, attempts, events, finished, written, clientEnds } = await retryRig();
  killServer(rig, attempts[0]!.input.server.id);
  assert.equal(attempts[0]!.input.signal.aborted, true, "running trials are told their server died");
  finish(attempts[0]!, "cancelled");
  await rig.settle();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(attempt => attempt.input.server.id), ["s1", "s2"]);
  assert.equal(events.filter(event => event.type === "result").length, 0, "the first attempt is not a result");
  finish(attempts[1]!);
  const summary = await handle.finished;
  assert.deepEqual([summary.runs, summary.passed, summary.retried], [1, 1, 1]);
  const event = events.find(event => event.type === "result");
  assert.equal(event?.type === "result" && event.class, "pass");
  assert.match(event?.type === "result" ? event.retried ?? "" : "", /^server died:/u);
  assert.equal(rig.logs.filter(line => /infra \(server died:.*back in the queue for another server; first run \/tmp\/out\/runs\//u.test(line)).length, 1);
  assert.deepEqual(finished, ["s1", "s2"], "finishTrial is called once per run");
  assert.ok(rig.pool.readings().every(server => !server.busy));
  assert.equal(scheduler.runningCount, 0);
  assert.deepEqual(clientEnds, [false, false], "clients already used never return to the spares");
  assert.deepEqual(attempts.map(attempt => written.get(attempt.input.runDir)?.outcome), ["cancelled", "pass"],
    "both attempt results remain addressable even when the wall timestamp is unchanged");
  assert.ok(rig.logs.some(line => line.endsWith(`first run ${attempts[0]!.input.runDir}`)));
  const scenario = { ...fixtureScenario(60, "next"), client: attempts[0]!.input.scenario.client };
  const next = scheduler.submit({ entries: [{ name: "next", scenario, placement: lanePlacement("k") }], repeat: 1,
    maxLanes: null, lock: false, hold: false, outDir: "/tmp/out", emit: event => events.push(event) });
  await rig.settle();
  assert.equal(attempts[2]!.input.server.id, "s2", "the next trial uses the healthy server");
  finish(attempts[2]!);
  assert.equal((await next.finished).passed, 1);
});

for (const [second, wantClass, wantCause] of [
  ["fail", "product", "fail"],
  ["transport", "product", "infra twice (rcon: first; rcon: second)"],
  ["throw", "infra", "runner broke"],
  ["death", "product", "infra twice (server died: its java process is gone; server died: its java process is gone)"],
] as const) {
  test(`a ${second === "death" ? "death" : "transport failure"} then ${second} settles once as ${wantClass}`, async () => {
    const { rig, handle, attempts, events } = await retryRig();
    if (second === "death") killServer(rig, attempts[0]!.input.server.id);
    finish(attempts[0]!, "fail", second === "death" ? undefined : "first");
    await rig.settle();
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0]!.input.server.id, attempts[1]!.input.server.id);
    if (second === "throw") attempts[1]!.result.reject(new Error("runner broke"));
    else {
      if (second === "death") killServer(rig, attempts[1]!.input.server.id);
      finish(attempts[1]!, "fail", second === "transport" ? "second" : undefined);
    }
    const summary = await handle.finished;
    assert.deepEqual([summary.runs, summary.failed, summary.infra ?? 0], [1, 1, wantClass === "infra" ? 1 : 0]);
    const event = events.find(event => event.type === "result");
    assert.equal(event?.type === "result" && event.class, wantClass);
    assert.equal(event?.type === "result" && event.cause, wantCause);
    if (second === "transport" || second === "death") assert.equal(event?.type === "result" && event.outcome, "fail");
    assert.equal(event?.type === "result" && event.retried, undefined);
    assert.equal(attempts.length, 2);
  });
}

for (const second of ["death", "throw"] as const) {
  test(`a lane start failure then ${second} uses one budget`, async () => {
    const { rig, scheduler, sample, handle, attempts, events } = await retryRig(0);
    sample();
    await rig.settle();
    assert.equal(rig.factory.requests.length, 2);
    assert.equal(attempts.length, 1, "the first admission never reached the runner");
    if (second === "death") { killServer(rig, attempts[0]!.input.server.id); finish(attempts[0]!, "cancelled"); }
    else attempts[0]!.result.reject(new Error("runner broke"));
    assert.equal(await settlesWithin(handle.finished), true);
    const summary = await handle.finished;
    assert.deepEqual([summary.runs, summary.failed, summary.infra], [1, 1, 1]);
    assert.equal(events.filter(event => event.type === "result").length, 1);
    assert.equal(scheduler.queuedCount, 0);
    assert.equal(rig.factory.requests.length, 2);
  });
}

test("a retry leaves both the sample's ledger and its young client reserve intact", async () => {
  const { rig, scheduler, handle, attempts, sample } = await retryRig();
  for (const server of rig.pool.list()) rig.pool.setHealth(server.id, { residentMb: 3_000, msptP95: 5 });
  sample(1_000);
  const ledger = scheduler.sampleReport()!.ledgerMb;
  const serverGrowth = rig.config.sharedHeapMb + rig.config.serverOverheadMb - 3_000;
  finish(attempts[0]!, "fail", "first");
  await rig.settle();
  assert.equal(scheduler.queuedCount, 1);
  assert.equal(scheduler.sampleReport()!.ledgerMb, ledger + serverGrowth,
    "only the now-idle server's growth leaves; no client reserve is subtracted after the sample reset the tally");
  sample(28_000);
  assert.equal(scheduler.sampleReport()!.ledgerMb, 28_000 - 2 * rig.config.clientMemMb - serverGrowth,
    "the first young client remains and the retry reserves a second client");
  await rig.settle();
  finish(attempts[1]!);
  await handle.finished;
});

test("a cancelled submission between the runs re-queues nothing", async () => {
  const { rig, scheduler, handle, attempts, sample } = await retryRig();
  sample(1_000);
  finish(attempts[0]!, "fail", "first");
  await rig.settle();
  assert.equal(scheduler.queuedCount, 1);
  handle.cancel("stop between attempts");
  const summary = await handle.finished;
  sample();
  await rig.settle();
  assert.deepEqual([summary.runs, summary.cancelled], [1, 1]);
  assert.equal(attempts.length, 1);
  assert.equal(scheduler.queuedCount, 0);
});

test("with the only server avoided a new server starts for the retry", async () => {
  const { rig, handle, attempts, sample } = await retryRig(1);
  finish(attempts[0]!, "fail", "first");
  await rig.settle();
  sample();
  await rig.settle();
  assert.deepEqual(attempts.map(attempt => attempt.input.server.id), ["s1", "s2"]);
  assert.equal(rig.factory.requests.length, 2);
  finish(attempts[1]!);
  assert.equal((await handle.finished).passed, 1);
});

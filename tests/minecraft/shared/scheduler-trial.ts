// One admitted trial inside the scheduler: wait for its server, run it, choose between a send-back to the queue and a settle, and report its result.
import { join } from "node:path";
import type { Scenario } from "mine-labs";
import type { Lane } from "../arena/lanes.ts";
import { renameBodyOnOwnServer } from "../arena/own-body.ts";
import { settingsOf } from "../arena/settings.ts";
import { shiftScenario } from "../arena/shift-scenario.ts";
import { trialLine } from "./daemon-lines.ts";
import type { ManagedServer } from "./pool.ts";
import { fileRunIo, type RunIo } from "./run-io.ts";
import { classifyEnd, type Classified } from "./result-class.ts";
import type { Admitted, QueuedTrial, Submission } from "./scheduler-records.ts";
import type { SchedulerDeps, SubmissionEntry } from "./scheduler-types.ts";
import { awaitDeathOrCancel, blameDeadServer, deathConfirmBoundMs } from "./server-death.ts";
import { executeTrial, phasesLine, type TrialEnd } from "./trial.ts";

/** What a trial in flight asks of the scheduler that holds the queue, the ledger and the counts. */
export interface TrialHost {
  /** The trial goes back to the queue once to be placed on another server; false when it stays its error. */
  sendBack(queued: QueuedTrial, admitted: Admitted, why: string, avoid: string, cause: NonNullable<QueuedTrial["infraCause"]>): boolean;
  /** Re-inserts a released infra trial without returning its used clients or memory reserves. */
  requeue(queued: QueuedTrial, avoid: string): void;
  /** The trial leaves what admission gave it: its place in the mutex queue, its booked client, its count among the running. */
  unadmit(queued: QueuedTrial, admitted: Admitted): void;
  /** The server's trial ran into its wall bound. */
  hitWallBound(serverId: string): void;
  /** The trial is settled: its submission may be done, and the slot it frees starts the next trial. */
  settled(submission: Submission): void;
}

/** What the scheduler hands a trial run: its dependencies and its host. */
export interface TrialEnvironment {
  readonly deps: SchedulerDeps;
  readonly host: TrialHost;
}

/** The admitted trial with the server and lane it was placed on. */
export interface PlacedTrial {
  readonly queued: QueuedTrial;
  readonly managed: ManagedServer;
  readonly lane: Lane | null;
  readonly admitted: Admitted;
}

/** The next scenario on a reused server of its own cannot have a fresh body: its end keeps that server from being reused, or every later scenario of the key would fail the same way. */
class FreshBodyRefused extends Error {}

/** The server did not start: the trial never touched it, so it can be placed on another one. */
class ServerStartFailed extends Error {}
class ShiftRefused extends Error {}

function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 60);
}

/** Runs an admitted trial: settles it, sends back a never-ran trial, or retries its first infra end on another server. */
export async function runAdmittedTrial(env: TrialEnvironment, trial: PlacedTrial): Promise<void> {
  const { deps, host } = env;
  const { queued, managed, admitted } = trial;
  const { entry, submission } = queued;
  const runDir = join(submission.spec.outDir, "runs", `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-t${String(queued.sequence).padStart(5, "0")}-${managed.id}-${slug(entry.name)}`);
  const io = deps.runIo ?? fileRunIo;
  let end: TrialEnd;
  const wait = { serverMs: 0 };
  let ran = false;
  let caught: unknown;
  let didCatch = false;
  let diedAt: number | undefined = managed.died.aborted ? performance.now() : undefined;
  const onDeath = () => { diedAt = performance.now(); };
  managed.died.addEventListener("abort", onDeath, { once: true });
  try {
    end = await executeOnServer(deps, trial, runDir, io, wait);
    ran = true;
  } catch (error) {
    didCatch = true;
    caught = error;
    if (error instanceof ServerStartFailed && host.sendBack(queued, admitted, "its server failed to start", managed.id,
      { cause: `server did not start: ${error.message}`, selfMade: entry.placement.kind === "own" })) {
      managed.died.removeEventListener("abort", onDeath);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    end = {
      result: { scenario: entry.name, outcome: "error", elapsedMs: 0, goal: { state: "pending", detail }, goalText: "", error: detail },
      lane: error instanceof FreshBodyRefused ? "quarantined" : "free", serverSick: false, hitWallBound: false, restored: false, mutexWaitMs: 0, arranged: false,
    };
  }
  // Mine Labs returns a failed arrangement as an error result, so a lane trial's queue marks say "arranged" too: only the end knows whether it ran.
  const unrun = !end.arranged;
  // A trial on a dead java fails its RCON commands at once, 5-10 s before the sampler confirms the death: it is not settled red before then.
  // An end the scheduler made itself (a failed start, a body refused) has nothing of a dead java in it.
  if (ran && unrun && !managed.died.aborted && end.result.outcome !== "pass" && !submission.abort.signal.aborted) {
    const boundMs = deathConfirmBoundMs(deps.config);
    deps.log(`${entry.name}: failed before its arrangement, waiting up to ${boundMs} ms for the death of server ${managed.id} to be confirmed`);
    await awaitDeathOrCancel(AbortSignal.any([managed.died, submission.abort.signal]), boundMs);
  }
  managed.died.removeEventListener("abort", onDeath);
  if (unrun && managed.died.aborted && host.sendBack(queued, admitted, "its server died before its arrangement", managed.id,
    { cause: `server died: ${String(managed.died.reason)}`, selfMade: true })) return;
  const detail = didCatch ? (caught instanceof Error ? caught.message : String(caught)) : null;
  const classified = classifyEnd({
    outcome: end.result.outcome, placement: entry.placement.kind, submissionCancelled: submission.abort.signal.aborted,
    startFailed: caught instanceof ServerStartFailed ? detail : null,
    diedBeforeSettle: diedAt !== undefined && (end.settledAt === undefined || diedAt <= end.settledAt) ? String(managed.died.reason) : null,
    transportFailure: end.result.transportFailure ?? null, hitWallBound: end.hitWallBound, late: end.late === true,
    harnessError: end.threw ?? (caught instanceof ServerStartFailed || caught instanceof FreshBodyRefused || caught instanceof ShiftRefused ? null : detail),
    phases: end.phases ? phasesLine(end.phases) : null, detail: end.result.error ?? end.result.goal.detail,
  });
  const blamed = blameDeadServer(managed, submission, end);
  const retry = classified.class === "infra" && !queued.sentBack && !submission.abort.signal.aborted;
  if (retry) {
    queued.sentBack = true;
    queued.infraCause = { cause: classified.cause!, selfMade: classified.selfMade === true };
    releaseServer(env, trial, wait.serverMs, blamed);
    deps.log(`${entry.name}: infra (${classified.cause}), back in the queue for another server; first run ${runDir}`);
    host.requeue(queued, managed.id);
    return;
  }
  releaseServer(env, trial, wait.serverMs, blamed);
  countAndEmit(env, trial, blamed, classified, runDir);
}

/** The scenario this trial runs: shifted into its lane, or on a server of its own under the body that server is up to. */
function scenarioFor(deps: SchedulerDeps, entry: SubmissionEntry, lane: Lane | null, body: number): Scenario {
  if (lane) {
    const shifted = (deps.shift ?? shiftScenario)(entry.placement.kind === "lane" ? entry.placement.scenario : entry.scenario, lane);
    if (!shifted.ok) throw new ShiftRefused(`the scenario could not be shifted to lane ${lane.index}: ${shifted.reason}`);
    return shifted.scenario;
  }
  const renamed = renameBodyOnOwnServer(entry.scenario, body);
  if (!renamed.ok) throw new FreshBodyRefused(`the scenario could not be given a fresh body (${body}) on its reused server: ${renamed.reason}`);
  return renamed.scenario;
}

/** Waits for the trial's server, runs the scenario on it and writes its result; `wait.serverMs` gets the time spent waiting for the server. */
async function executeOnServer(deps: SchedulerDeps, trial: PlacedTrial, runDir: string, io: RunIo, wait: { serverMs: number }): Promise<TrialEnd> {
  const { queued, managed, lane, admitted } = trial;
  const { entry, submission } = queued;
  const waitedFrom = deps.now();
  const server = await managed.ready.catch((error: unknown) => {
    throw new ServerStartFailed(`server failed to start: ${error instanceof Error ? error.message : String(error)}`);
  }).finally(() => { wait.serverMs = deps.now() - waitedFrom; });
  const scenario = scenarioFor(deps, entry, lane, admitted.body);
  const run = await io.open(runDir);
  try {
    const end = await executeTrial({ runTrial: deps.runTrial, config: deps.config }, {
      name: entry.name, scenario, lane, server, mutex: managed.mutex, runDir, log: run.log, queue: admitted.queue ?? undefined,
      tickRate: entry.placement.kind === "lane" ? entry.placement.settings.tickRate : settingsOf(entry.scenario, {}).settings.tickRate,
      signal: AbortSignal.any([submission.abort.signal, managed.died]), reuseServer: lane !== null || (entry.placement.kind === "own" && entry.placement.reusable),
      clientProvider: deps.clientsAhead?.providerFor(submission.id, queued.sequence, run.log),
    });
    await io.writeResult(runDir, end.result);
    return end;
  } finally {
    await run.close();
  }
}

/** Releases one attempt's server and admission exactly once, whether it retries or settles. */
function releaseServer(env: TrialEnvironment, trial: PlacedTrial, serverWaitMs: number, end: TrialEnd): void {
  const { deps, host } = env;
  const { queued, managed, lane, admitted } = trial;
  const { entry } = queued;
  const now = deps.now();
  deps.log(trialLine({
    name: entry.name, lane: lane?.index ?? null, serverId: managed.id, queueMs: admitted.at - queued.queuedAt, serverWaitMs,
    phases: end.phases, holdMs: now - admitted.at,
  }));
  deps.pool.finishTrial(managed.id, lane, end, now, { reusable: entry.placement.kind === "own" && entry.placement.reusable });
  if (end.hitWallBound) host.hitWallBound(managed.id);
  host.unadmit(queued, admitted);
}

/** Counts and emits only the final attempt, retaining the first infra cause for a recovered pass. */
function countAndEmit(env: TrialEnvironment, trial: PlacedTrial, end: TrialEnd, classified: Classified, runDir: string): void {
  const { queued } = trial;
  const { submission, entry, infraCause } = queued;
  const infraTwice = classified.class === "infra" && infraCause?.selfMade && classified.selfMade;
  if (infraTwice) {
    classified = { class: "product", cause: `infra twice (${infraCause.cause}; ${classified.cause})` };
  }
  const retried = classified.class === "pass" ? infraCause?.cause : undefined;
  const { result } = end;
  submission.summary.runs += 1;
  if (classified.class === "pass") submission.summary.passed += 1;
  else if (classified.class === "cancelled") submission.summary.cancelled += 1;
  else submission.summary.failed += 1;
  if (classified.class === "infra") submission.summary.infra = (submission.summary.infra ?? 0) + 1;
  if (retried !== undefined) submission.summary.retried = (submission.summary.retried ?? 0) + 1;
  submission.spec.emit({
    type: "result", name: entry.name, outcome: infraTwice ? "fail" : result.outcome, elapsedMs: result.elapsedMs, detail: result.goal.detail, error: result.error, runDir, class: classified.class, cause: classified.cause, retried,
  });
  env.host.settled(submission);
}

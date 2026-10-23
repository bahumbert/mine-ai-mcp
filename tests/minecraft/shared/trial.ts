// Runs one trial on a server under the wall-clock bounds: the arrangement mutex, the abort at goal timeout + slack, the lane's restore.
import type { ArenaTrialOptions, RunResult, Scenario } from "mine-labs";
import { controlChunkOf, type Lane } from "../arena/lanes.ts";
import type { ArrangementMutex } from "./arrangement-mutex.ts";
import type { ScenarioServerConfig } from "./config.ts";
import type { ScenarioServer } from "./scenario-server.ts";

const DEFAULT_GOAL_TIMEOUT_SECONDS = 120;
const WORLD_FLOOR_Y = -64;
const WORLD_CEILING_Y = 319;

export interface TrialRunInput {
  readonly server: ScenarioServer;
  readonly scenario: Scenario;
  readonly runDir: string;
  readonly log: (message: string) => void;
  readonly signal: AbortSignal;
  readonly reuseServer: boolean;
  readonly arena?: ArenaTrialOptions;
  /** Hands over the arena restore to run after the trial (Mine Labs' `deferReset`). */
  readonly deferReset: (restore: (log: (message: string) => void) => Promise<void>) => void;
  /** The arrangement is done and the clients joined: the next lane may arrange. */
  readonly onPrepared: () => Promise<void>;
}

export type TrialRunner = (input: TrialRunInput) => Promise<RunResult>;

export interface TrialJob {
  readonly name: string;
  /** Already shifted for a lane. */
  readonly scenario: Scenario;
  /** Null: the scenario runs alone on its own server at offset 0, with no arena. */
  readonly lane: Lane | null;
  readonly server: ScenarioServer;
  readonly mutex: ArrangementMutex;
  readonly runDir: string;
  readonly log: (message: string) => void;
  /** The submitter's cancel. */
  readonly signal: AbortSignal;
  readonly reuseServer: boolean;
}

export interface TrialEnd {
  readonly result: RunResult;
  /** `free`: the arena is certified clean; `quarantined`: not certified, never reuse; `held`: something may still be running there. */
  readonly lane: "free" | "quarantined" | "held";
  readonly serverSick: boolean;
  /** The trial was aborted at goal timeout + slack. */
  readonly hitWallBound: boolean;
  /** A restore ran and finished. */
  readonly restored: boolean;
  readonly mutexWaitMs: number;
}

type TrialDeps = { readonly runTrial: TrialRunner; readonly config: Pick<ScenarioServerConfig, "trialSlackMs" | "restoreBoundMs"> };

function arenaOf(lane: Lane): ArenaTrialOptions {
  const { cell } = lane;
  return {
    id: `lane-${lane.index}`,
    entityBox: { minX: cell.minX, minY: WORLD_FLOOR_Y, minZ: cell.minZ, maxX: cell.maxX, maxY: WORLD_CEILING_Y, maxZ: cell.maxZ },
    controlChunk: controlChunkOf(lane),
  };
}

function errorResult(job: TrialJob, startedAt: number, error: string): RunResult {
  return { scenario: job.name, outcome: "error", elapsedMs: Date.now() - startedAt, goal: { state: "pending", detail: error }, goalText: "", error };
}

/** Resolves "late" `boundMs` after the signal aborts (at once if it already did); `cancel` stops the clock. */
function lateAfterAbort(signal: AbortSignal, boundMs: number): { readonly promise: Promise<"late">; readonly cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const promise = new Promise<"late">(resolve => {
    onAbort = () => { timer = setTimeout(() => resolve("late"), boundMs); };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, cancel: () => { clearTimeout(timer); if (onAbort) signal.removeEventListener("abort", onAbort); } };
}

async function within<T>(work: Promise<T>, boundMs: number): Promise<{ readonly done: true; readonly value: T } | { readonly done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ done: false }>(resolve => { timer = setTimeout(() => resolve({ done: false }), boundMs); });
  try {
    return await Promise.race([work.then(value => ({ done: true as const, value })), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Takes the mutex for a lane trial; a trial on its own server has nothing to share. */
async function takeArrangementTurn(job: TrialJob): Promise<() => void> {
  return job.lane ? job.mutex.acquire(job.signal) : () => {};
}

/**
 * Run `job` and say what is left of its arena: the lane stays held until the trial and its restore have settled
 * (Mine Labs' clearScenario and pinRegions ignore the abort signal), and a trial that never settles or a restore that
 * outlasts the bound marks the server sick instead of freeing a lane that may still be changing.
 */
export async function executeTrial(deps: TrialDeps, job: TrialJob): Promise<TrialEnd> {
  const queuedAt = Date.now();
  let release: () => void;
  try {
    release = await takeArrangementTurn(job);
  } catch {
    const cancelled: RunResult = { ...errorResult(job, queuedAt, "trial cancelled before its arrangement"), outcome: "cancelled" };
    return { result: cancelled, lane: "free", serverSick: false, hitWallBound: false, restored: false, mutexWaitMs: Date.now() - queuedAt };
  }
  const startedAt = Date.now();
  const mutexWaitMs = startedAt - queuedAt;
  const wall = new AbortController();
  const timeoutMs = (job.scenario.goal.timeout ?? DEFAULT_GOAL_TIMEOUT_SECONDS) * 1000 + deps.config.trialSlackMs;
  const wallTimer = setTimeout(() => wall.abort("wall-clock bound"), timeoutMs);
  const signal = AbortSignal.any([job.signal, wall.signal]);
  const late = lateAfterAbort(signal, deps.config.restoreBoundMs);
  let restore: ((log: (message: string) => void) => Promise<void>) | undefined;
  try {
    const trial = deps.runTrial({
      server: job.server, scenario: job.scenario, runDir: job.runDir, log: job.log, signal, reuseServer: job.reuseServer,
      arena: job.lane ? arenaOf(job.lane) : undefined,
      deferReset: handed => { restore = handed; },
      onPrepared: async () => { release(); },
    });
    const settled = await Promise.race([trial.then(result => ({ result }), (error: unknown) => ({ error })), late.promise]);
    const hitWallBound = wall.signal.aborted;
    if (settled === "late") {
      const result = errorResult(job, startedAt, `trial did not settle within ${deps.config.restoreBoundMs} ms after it was aborted`);
      return { result, lane: "held", serverSick: true, hitWallBound, restored: false, mutexWaitMs };
    }
    if ("error" in settled) {
      const detail = settled.error instanceof Error ? settled.error.message : String(settled.error);
      return { result: errorResult(job, startedAt, `trial threw: ${detail}`), lane: "quarantined", serverSick: false, hitWallBound, restored: false, mutexWaitMs };
    }
    // A trial that failed before `onPrepared` still holds its arrangement turn; its own restore must not wait behind it.
    release();
    return { ...(await restoreArena(deps, job, restore, settled.result)), hitWallBound, mutexWaitMs };
  } finally {
    clearTimeout(wallTimer);
    late.cancel();
    release();
  }
}

type RestoreEnd = Pick<TrialEnd, "result" | "lane" | "serverSick" | "restored">;

async function restoreArena(
  deps: TrialDeps,
  job: TrialJob,
  restore: ((log: (message: string) => void) => Promise<void>) | undefined,
  result: RunResult,
): Promise<RestoreEnd> {
  if (!restore) return { result, lane: "free", serverSick: false, restored: false };
  const restoring = (async () => {
    const turn = await takeRestoreTurn(job);
    try { await restore(job.log); } finally { turn(); }
  })();
  let failure: unknown;
  const outcome = await within(restoring.catch((error: unknown) => { failure = error; }), deps.config.restoreBoundMs);
  if (!outcome.done) {
    const note = `restore did not finish within ${deps.config.restoreBoundMs} ms`;
    return { result: { ...result, error: result.error ? `${result.error}; ${note}` : note }, lane: "held", serverSick: true, restored: false };
  }
  if (failure !== undefined) {
    job.log(`restore failed: ${failure instanceof Error ? failure.message : String(failure)}`);
    return { result, lane: "quarantined", serverSick: false, restored: false };
  }
  return { result, lane: "free", serverSick: false, restored: true };
}

/** The restore waits its turn on the mutex like an arrangement, and is not cancelled by the abort that ended the trial. */
async function takeRestoreTurn(job: TrialJob): Promise<() => void> {
  return job.lane ? job.mutex.acquire() : () => {};
}

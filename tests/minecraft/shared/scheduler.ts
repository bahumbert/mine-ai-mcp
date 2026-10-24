// The queue of trials and the loop that admits them: each sample, and each time a trial settles, the first admissible trial starts.
import { join } from "node:path";
import type { RunResult, Scenario } from "mine-labs";
import {
  advanceAdmissionState, decideAdmission, EMPTY_TALLY, initialAdmissionState, noteAdmission, noteWallBoundHit,
  type AdmissionDecision, type AdmissionRequest, type AdmissionSample, type AdmissionState, type AdmissionTally,
} from "./admission.ts";
import type { Lane } from "../arena/lanes.ts";
import { shiftScenario, type Shifted } from "../arena/shift-scenario.ts";
import type { ScenarioServerConfig } from "./config.ts";
import { isTimingTrial, reservePlacement, type Placement } from "./placement.ts";
import type { ManagedServer, ServerPool } from "./pool.ts";
import { fileRunIo, type RunIo } from "./run-io.ts";
import { serverSpecFor } from "./server-spec.ts";
import { executeTrial, type TrialEnd, type TrialRunner } from "./trial.ts";

export interface SubmissionEntry {
  readonly name: string;
  readonly scenario: Scenario;
  readonly placement: Placement;
}

export type SubmissionEvent =
  | { readonly type: "info"; readonly text: string }
  | { readonly type: "result"; readonly name: string; readonly outcome: RunResult["outcome"]; readonly elapsedMs: number; readonly detail: string; readonly error?: string; readonly runDir: string };

export interface SubmissionSpec {
  readonly entries: readonly SubmissionEntry[];
  readonly repeat: number;
  /** `--lanes N`: at most this many of this submission's trials at once. */
  readonly maxLanes: number | null;
  /** A timing batch: its trials run on servers reserved for it, start on a calm machine, and nothing else is held back for it. */
  readonly lock: boolean;
  /** A load batch (`--load`, the master's only): waits for the queue ahead of it to empty, then nothing else starts until it ends. */
  readonly hold: boolean;
  readonly outDir: string;
  readonly emit: (event: SubmissionEvent) => void;
}

export interface SubmissionSummary { readonly runs: number; readonly passed: number; readonly failed: number; readonly cancelled: number }

export interface SubmissionHandle {
  readonly id: number;
  readonly finished: Promise<SubmissionSummary>;
  cancel(reason: string): void;
}

export interface MachineReading { readonly cpuBusy: number | null; readonly memAvailableMb: number; readonly threads: number }

export interface SchedulerDeps {
  readonly pool: ServerPool;
  readonly config: ScenarioServerConfig;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly runTrial: TrialRunner;
  readonly runIo?: RunIo;
  readonly shift?: (scenario: Scenario, lane: Lane) => Shifted;
}

interface QueuedTrial {
  readonly sequence: number;
  readonly submission: Submission;
  readonly entry: SubmissionEntry;
  refusal: string | null;
  /** Samples in a row this trial was refused for want of room for a new server. */
  roomSamples: number;
  /** A timing trial whose last refusal was the cpu bound: it holds the other trials to CPU_CALM so the load drains. */
  waitingForCalm: boolean;
}

interface Submission {
  readonly id: number;
  readonly spec: SubmissionSpec;
  readonly abort: AbortController;
  readonly summary: { runs: number; passed: number; failed: number; cancelled: number };
  readonly done: PromiseWithResolvers<SubmissionSummary>;
  running: number;
  queued: number;
}

/** The line a submitter waits for before it starts the load a hold batch runs under (`scenario-repeat.sh --load`). */
export const HOLD_STARTED_TEXT = "hold: this batch runs alone now";

function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 60);
}

export class Scheduler {
  readonly #queue: QueuedTrial[] = [];
  readonly #submissions = new Map<number, Submission>();
  readonly #young: number[] = [];
  #admission: AdmissionState;
  #base: Omit<AdmissionSample, "servers"> | null = null;
  #tally: AdmissionTally = EMPTY_TALLY;
  #running = 0;
  #timingRunning = 0;
  /** Queued timing trials refused for the cpu bound at their last turn. */
  #timingWaitingForCalm = 0;
  #holdHolder: number | null = null;
  /** The submission that started the last trial: the next pass begins with the one after it, so submissions take turns. */
  #lastServed = 0;
  #nextSubmission = 1;
  #sequence = 0;

  constructor(private readonly deps: SchedulerDeps) {
    this.#admission = initialAdmissionState(deps.config);
  }

  get runningCount(): number {
    return this.#running;
  }

  /** The machine's cpu share over the last sample window (null before the second sample): the daemon logs it with each sample. */
  get cpuBusy(): number | null {
    return this.#base?.cpuBusy ?? null;
  }

  get queuedCount(): number {
    return this.#queue.length;
  }

  submit(spec: SubmissionSpec): SubmissionHandle {
    const submission: Submission = {
      id: this.#nextSubmission++, spec, abort: new AbortController(), summary: { runs: 0, passed: 0, failed: 0, cancelled: 0 },
      done: Promise.withResolvers<SubmissionSummary>(), running: 0, queued: 0,
    };
    this.#submissions.set(submission.id, submission);
    // A timing batch's trials get a pool key of their own: their servers are made for it and stop with it.
    const entries = spec.lock ? spec.entries.map(entry => ({ ...entry, placement: reservePlacement(entry.placement, submission.id) })) : spec.entries;
    for (let cycle = 0; cycle < spec.repeat; cycle++) {
      for (const entry of entries) {
        this.#queue.push({ sequence: ++this.#sequence, submission, entry, refusal: null, roomSamples: 0, waitingForCalm: false });
        submission.queued += 1;
      }
    }
    this.#finishIfDone(submission);
    this.#pump(false);
    return { id: submission.id, finished: submission.done.promise, cancel: reason => this.#cancel(submission, reason) };
  }

  /** The keys of trials still queued: their servers are kept warm. */
  queuedKeys(): Set<string> {
    return new Set(this.#queue.map(queued => queued.entry.placement.key));
  }

  /** Why the first queued trial of a submission waits (the bound that holds it), or null when none waits. */
  waitReport(submissionId: number): string | null {
    const waiting = this.#queue.find(queued => queued.submission.id === submissionId && queued.refusal !== null);
    return waiting ? `${waiting.entry.name} waits: ${waiting.refusal}` : null;
  }

  /** A new machine reading: advance the admission state, then admit what the bounds allow. */
  onSample(machine: MachineReading, now: number): void {
    const young = this.#young.filter(admittedAt => now - admittedAt < this.deps.config.clientRampMs);
    this.#young.splice(0, this.#young.length, ...young);
    this.#base = { at: now, ...machine, ownTrials: this.#running, youngClients: young.length };
    this.#tally = EMPTY_TALLY;
    this.#admission = advanceAdmissionState(this.#admission, this.#liveSample()!, this.#queue.length > 0, this.deps.config);
    this.#pump(true);
  }

  cancelAll(reason: string): void {
    for (const submission of [...this.#submissions.values()]) this.#cancel(submission, reason);
  }

  #liveSample(): AdmissionSample | null {
    return this.#base ? { ...this.#base, servers: this.deps.pool.readings() } : null;
  }

  #cancel(submission: Submission, reason: string): void {
    submission.abort.abort(reason);
    const dropped = this.#queue.filter(queued => queued.submission === submission);
    this.#queue.splice(0, this.#queue.length, ...this.#queue.filter(queued => queued.submission !== submission));
    for (const queued of dropped) this.#setWaitingForCalm(queued, false);
    submission.queued = 0;
    submission.summary.runs += dropped.length;
    submission.summary.cancelled += dropped.length;
    this.#finishIfDone(submission);
  }

  #finishIfDone(submission: Submission): void {
    if (submission.queued > 0 || submission.running > 0 || !this.#submissions.has(submission.id)) return;
    this.#submissions.delete(submission.id);
    if (this.#holdHolder === submission.id) this.#holdHolder = null;
    if (submission.spec.lock) this.deps.pool.releaseReservation(submission.id);
    submission.done.resolve(submission.summary);
  }

  /**
   * Walks the queue once in turn order: a trial held back never blocks the ones behind it, except one that has waited
   * `starveSamples` samples for room for a new server, which keeps the memory it needs from the trials after it.
   */
  #pump(isSample: boolean): void {
    if (!this.#base) return;
    let starved: QueuedTrial | null = null;
    for (const queued of this.#turnOrder()) {
      if (starved && this.#running > 0) {
        queued.refusal = `waits behind ${starved.entry.name}, which has waited ${starved.roomSamples} samples for room to start a server`;
        continue;
      }
      queued.refusal = this.#tryStart(queued, isSample);
      if (queued.refusal !== null && queued.roomSamples >= this.deps.config.starveSamples) starved ??= queued;
    }
  }

  /** The queue interleaved by submission, each taking a turn, the first turn going to the submission after the last one served. */
  #turnOrder(): QueuedTrial[] {
    const bySubmission = new Map<number, QueuedTrial[]>();
    for (const queued of this.#queue) {
      const own = bySubmission.get(queued.submission.id) ?? [];
      own.push(queued);
      bySubmission.set(queued.submission.id, own);
    }
    const ids = [...bySubmission.keys()].sort((first, second) => first - second);
    const next = ids.findIndex(id => id > this.#lastServed);
    const turn = next < 0 ? ids : [...ids.slice(next), ...ids.slice(0, next)];
    const order: QueuedTrial[] = [];
    for (let round = 0; order.length < this.#queue.length; round++) {
      for (const id of turn) {
        const queued = bySubmission.get(id)![round];
        if (queued) order.push(queued);
      }
    }
    return order;
  }

  /** Null when the trial started; otherwise the reason it waits. */
  #tryStart(queued: QueuedTrial, isSample: boolean): string | null {
    const { submission, entry } = queued;
    const gate = this.#holdGate(submission);
    if (gate) return this.#refusedNotForRoom(queued, gate);
    const cap = submission.spec.maxLanes;
    if (cap !== null && submission.running >= cap) return this.#refusedNotForRoom(queued, `--lanes ${cap} reached for this submission`);
    const decision = decideAdmission({
      sample: this.#liveSample()!, state: this.#admission, tally: this.#tally, config: this.deps.config,
      request: this.#requestFor(entry.placement, this.#isTiming(submission, entry)),
    });
    const timing = this.#isTiming(submission, entry);
    this.#setWaitingForCalm(queued, timing && !decision.admit && decision.bound === "cpu");
    if (decision.admit) {
      queued.roomSamples = 0;
      return this.#start(queued, decision);
    }
    queued.roomSamples = decision.waitsForServerRoom ? queued.roomSamples + (isSample ? 1 : 0) : 0;
    return `${decision.bound}: ${decision.detail}`;
  }

  #setWaitingForCalm(queued: QueuedTrial, waiting: boolean): void {
    if (queued.waitingForCalm === waiting) return;
    queued.waitingForCalm = waiting;
    this.#timingWaitingForCalm += waiting ? 1 : -1;
  }

  /** A refusal that is neither a wait for room for a new server nor for a calm machine: both waits start again from zero. */
  #refusedNotForRoom(queued: QueuedTrial, reason: string): string {
    queued.roomSamples = 0;
    this.#setWaitingForCalm(queued, false);
    return reason;
  }

  /** A hold batch's trials are never timing trials: the load it runs under is the point of it. */
  #isTiming(submission: Submission, entry: SubmissionEntry): boolean {
    return !submission.spec.hold && isTimingTrial(entry.placement, submission.spec.lock);
  }

  #requestFor(placement: Placement, timing: boolean): AdmissionRequest {
    const { pool, config } = this.deps;
    // A timing trial waiting for a calm machine counts as one running: the others start only under CPU_CALM until it has started.
    const base = { timing, timingRunning: this.#timingRunning + this.#timingWaitingForCalm };
    return placement.kind === "lane"
      ? { ...base, candidates: pool.sharedCandidates(placement.key), newServerHeapMb: config.sharedHeapMb }
      : { ...base, candidates: pool.reusableSingles(placement.key), newServerHeapMb: config.singleHeapMb };
  }

  /**
   * A hold batch waits for the submissions ahead of it to finish, then runs alone; submissions after it wait for it.
   * Submissions ahead of a waiting hold batch go on, so it starts once their queue empties.
   */
  #holdGate(submission: Submission): string | null {
    if (this.#holdHolder !== null) {
      return this.#holdHolder === submission.id ? null : `waiting for hold batch ${this.#holdHolder} to end`;
    }
    const pending = [...this.#submissions.values()].find(candidate => candidate.spec.hold && candidate.queued > 0);
    if (!pending) return null;
    if (pending !== submission) return submission.id > pending.id ? `waiting for hold batch ${pending.id}, which runs alone` : null;
    const ahead = [...this.#submissions.values()].some(other => other.id < pending.id && (other.queued > 0 || other.running > 0));
    if (ahead) return "hold batch waits for the submissions ahead of it to finish";
    this.#holdHolder = submission.id;
    submission.spec.emit({ type: "info", text: HOLD_STARTED_TEXT });
    return null;
  }

  #start(queued: QueuedTrial, decision: Extract<AdmissionDecision, { admit: true }>): string | null {
    const { pool, config } = this.deps;
    const { entry, submission } = queued;
    const now = this.deps.now();
    const managed = decision.server === "new"
      ? pool.startServer(serverSpecFor(entry.placement, entry.scenario, config), now)
      : pool.get(decision.server);
    if (!managed) return `server ${decision.server} left the pool`;
    let lane: Lane | null = null;
    if (entry.placement.kind === "lane") {
      lane = pool.leaseLane(managed.id);
      if (!lane) return `server ${managed.id} has no free lane`;
    } else {
      pool.noteSingleTrialStarted(managed.id);
    }
    this.#tally = {
      trials: this.#tally.trials + 1, newServers: this.#tally.newServers + (decision.server === "new" ? 1 : 0),
      reservedMb: this.#tally.reservedMb + config.clientMemMb,
    };
    this.#young.push(now);
    this.#admission = noteAdmission(this.#admission, now);
    this.#running += 1;
    if (this.#isTiming(submission, entry)) this.#timingRunning += 1;
    this.#lastServed = submission.id;
    submission.running += 1;
    submission.queued -= 1;
    this.#queue.splice(this.#queue.indexOf(queued), 1);
    void this.#run(queued, managed, lane);
    return null;
  }

  async #run(queued: QueuedTrial, managed: ManagedServer, lane: Lane | null): Promise<void> {
    const { entry, submission } = queued;
    const runDir = join(submission.spec.outDir, "runs", `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-t${String(queued.sequence).padStart(5, "0")}-${slug(entry.name)}`);
    const io = this.deps.runIo ?? fileRunIo;
    let end: TrialEnd;
    try {
      end = await this.#execute(queued, managed, lane, runDir, io);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      end = {
        result: { scenario: entry.name, outcome: "error", elapsedMs: 0, goal: { state: "pending", detail }, goalText: "", error: detail },
        lane: "free", serverSick: false, hitWallBound: false, restored: false, mutexWaitMs: 0,
      };
    }
    this.#settle(queued, managed, lane, end, runDir);
  }

  async #execute(queued: QueuedTrial, managed: ManagedServer, lane: Lane | null, runDir: string, io: RunIo): Promise<TrialEnd> {
    const { entry, submission } = queued;
    const server = await managed.ready.catch((error: unknown) => {
      throw new Error(`server failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });
    const shifted = lane ? (this.deps.shift ?? shiftScenario)(entry.placement.kind === "lane" ? entry.placement.scenario : entry.scenario, lane)
      : { ok: true as const, scenario: entry.scenario };
    if (!shifted.ok) throw new Error(`the scenario could not be shifted to lane ${lane?.index}: ${shifted.reason}`);
    const run = await io.open(runDir);
    try {
      const end = await executeTrial({ runTrial: this.deps.runTrial, config: this.deps.config }, {
        name: entry.name, scenario: shifted.scenario, lane, server, mutex: managed.mutex, runDir, log: run.log,
        signal: submission.abort.signal, reuseServer: lane !== null || (entry.placement.kind === "own" && entry.placement.reusable),
      });
      await io.writeResult(runDir, end.result);
      return end;
    } finally {
      await run.close();
    }
  }

  #settle(queued: QueuedTrial, managed: ManagedServer, lane: Lane | null, end: TrialEnd, runDir: string): void {
    const { submission, entry } = queued;
    const now = this.deps.now();
    this.deps.pool.finishTrial(managed.id, lane, end, now, { reusable: entry.placement.kind === "own" && entry.placement.reusable });
    if (end.hitWallBound) this.#admission = noteWallBoundHit(this.#admission, managed.id);
    this.#running -= 1;
    if (this.#isTiming(submission, entry)) this.#timingRunning -= 1;
    this.#tally = { ...this.#tally, trials: this.#tally.trials - 1 };
    submission.running -= 1;
    const { result } = end;
    submission.summary.runs += 1;
    if (result.outcome === "pass") submission.summary.passed += 1;
    else if (result.outcome === "cancelled") submission.summary.cancelled += 1;
    else submission.summary.failed += 1;
    submission.spec.emit({
      type: "result", name: entry.name, outcome: result.outcome, elapsedMs: result.elapsedMs, detail: result.goal.detail, error: result.error, runDir,
    });
    this.#finishIfDone(submission);
    this.#pump(false);
  }
}

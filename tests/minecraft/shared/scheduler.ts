// The queue of trials and the loop that admits them: each sample, and each time a trial settles, the first admissible trial starts.
import { join } from "node:path";
import type { RunResult, Scenario } from "mine-labs";
import {
  advanceAdmissionState, decideAdmission, initialAdmissionState, noteAdmission, noteWallBoundHit,
  type AdmissionDecision, type AdmissionSample, type AdmissionState, type AdmissionTally,
} from "./admission.ts";
import type { Lane } from "../arena/lanes.ts";
import { shiftScenario, type Shifted } from "../arena/shift-scenario.ts";
import type { ScenarioServerConfig } from "./config.ts";
import type { Placement } from "./placement.ts";
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
  | { readonly type: "result"; readonly name: string; readonly outcome: RunResult["outcome"]; readonly elapsedMs: number; readonly detail: string; readonly error?: string; readonly runDir: string };

export interface SubmissionSpec {
  readonly entries: readonly SubmissionEntry[];
  readonly repeat: number;
  /** `--lanes N`: at most this many of this submission's trials at once. */
  readonly maxLanes: number | null;
  /** A timing batch: runs alone, nothing else admitted until it ends. */
  readonly lock: boolean;
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

function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 60);
}

export class Scheduler {
  readonly #queue: QueuedTrial[] = [];
  readonly #submissions = new Map<number, Submission>();
  readonly #young: number[] = [];
  #admission: AdmissionState;
  #base: Omit<AdmissionSample, "servers"> | null = null;
  #tally: AdmissionTally = { trials: 0, newServers: 0, reservedMb: 0 };
  #running = 0;
  #lockHolder: number | null = null;
  #nextSubmission = 1;
  #sequence = 0;

  constructor(private readonly deps: SchedulerDeps) {
    this.#admission = initialAdmissionState(deps.config);
  }

  get runningCount(): number {
    return this.#running;
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
    for (let cycle = 0; cycle < spec.repeat; cycle++) {
      for (const entry of spec.entries) {
        this.#queue.push({ sequence: ++this.#sequence, submission, entry, refusal: null });
        submission.queued += 1;
      }
    }
    this.#finishIfDone(submission);
    this.#pump();
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
    this.#tally = { trials: 0, newServers: 0, reservedMb: 0 };
    this.#admission = advanceAdmissionState(this.#admission, this.#liveSample()!, this.#queue.length > 0, this.deps.config);
    this.#pump();
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
    submission.queued = 0;
    submission.summary.runs += dropped.length;
    submission.summary.cancelled += dropped.length;
    this.#finishIfDone(submission);
  }

  #finishIfDone(submission: Submission): void {
    if (submission.queued > 0 || submission.running > 0 || !this.#submissions.has(submission.id)) return;
    this.#submissions.delete(submission.id);
    if (this.#lockHolder === submission.id) this.#lockHolder = null;
    submission.done.resolve(submission.summary);
  }

  /** Walks the queue once: a trial held back never blocks the ones behind it. */
  #pump(): void {
    if (!this.#base) return;
    for (const queued of [...this.#queue]) {
      const refusal = this.#tryStart(queued);
      queued.refusal = refusal;
    }
  }

  /** Null when the trial started; otherwise the reason it waits. */
  #tryStart(queued: QueuedTrial): string | null {
    const { submission, entry } = queued;
    const gate = this.#lockGate(submission);
    if (gate) return gate;
    const cap = submission.spec.maxLanes;
    if (cap !== null && submission.running >= cap) return `--lanes ${cap} reached for this submission`;
    const decision = decideAdmission({
      sample: this.#liveSample()!, state: this.#admission, tally: this.#tally, config: this.deps.config,
      request: this.#requestFor(entry.placement),
    });
    if (!decision.admit) return `${decision.bound}: ${decision.detail}`;
    return this.#start(queued, decision);
  }

  #requestFor(placement: Placement): { candidates: readonly string[]; newServerHeapMb: number } {
    const { pool, config } = this.deps;
    return placement.kind === "lane"
      ? { candidates: pool.sharedCandidates(placement.key), newServerHeapMb: config.sharedHeapMb }
      : { candidates: pool.reusableSingles(placement.key), newServerHeapMb: config.singleHeapMb };
  }

  /** A locked batch waits for the running trials to end, then runs alone; before it, nothing else is admitted. */
  #lockGate(submission: Submission): string | null {
    if (this.#lockHolder !== null) {
      return this.#lockHolder === submission.id ? null : `waiting for lock batch ${this.#lockHolder} to end`;
    }
    const pending = [...this.#submissions.values()].find(candidate => candidate.spec.lock && candidate.queued > 0);
    if (!pending) return null;
    if (pending !== submission) return `waiting for lock batch ${pending.id}, which runs alone`;
    if (this.#running > 0) return "lock batch waits for the running trials to end";
    this.#lockHolder = submission.id;
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
    this.#pump();
  }
}

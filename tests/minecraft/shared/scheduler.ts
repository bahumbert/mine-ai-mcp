// The queue of trials and the loop that admits them: each sample, and each time a trial settles, the first admissible trial starts.
import {
  advanceAdmissionState, decideAdmission, EMPTY_TALLY, initialAdmissionState, ledgerMb, noteWallBoundHit,
  type AdmissionDecision, type AdmissionRequest, type AdmissionSample, type AdmissionState, type AdmissionTally,
} from "./admission.ts";
import type { Lane } from "../arena/lanes.ts";
import { spreadThreshold } from "./config.ts";
import type { SampleReport } from "./daemon-lines.ts";
import { isTimingTrial, reservePlacement, runsOurClientHost, type Placement } from "./placement.ts";
import type { MutexQueueMarks } from "./pool.ts";
import { bootClientsForQueuedTrials, clientReserveMb, keepClientsFor, type AheadPass } from "./scheduler-ahead.ts";
import type { Admitted, QueuedTrial, Submission } from "./scheduler-records.ts";
import { runAdmittedTrial, type TrialHost } from "./scheduler-trial.ts";
import type {
  MachineReading, SchedulerDeps, SubmissionEntry, SubmissionHandle, SubmissionSpec, SubmissionSummary,
} from "./scheduler-types.ts";
import { serverSpecFor } from "./server-spec.ts";
import { countStartableTrialsPerKey, turnOrder } from "./trial-turns.ts";

export type { MachineReading, SchedulerDeps, SubmissionEntry, SubmissionEvent, SubmissionHandle, SubmissionSpec, SubmissionSummary } from "./scheduler-types.ts";

/** The line a submitter waits for before it starts the load a hold batch runs under (`scenario-repeat.sh --load`). */
export const HOLD_STARTED_TEXT = "hold: this batch runs alone now";

/** The reason a server of its own starts, for the daemon log (a lane server's reason is the pool's own). */
function ownStartReason(placement: Placement): string | undefined {
  if (placement.kind !== "own") return undefined;
  return placement.reusable ? "own, no idle server of its key" : "own, not reusable";
}

export class Scheduler {
  readonly #queue: QueuedTrial[] = [];
  readonly #submissions = new Map<number, Submission>();
  /** Clients admitted lately and what each still has to grow into (a whole client, or less when its trial took one booted ahead). */
  readonly #young: { readonly at: number; readonly mb: number }[] = [];
  #admission: AdmissionState;
  #base: (Omit<AdmissionSample, "servers"> & { readonly load1?: number | null }) | null = null;
  #tally: AdmissionTally = EMPTY_TALLY;
  #running = 0;
  /** Queued trials the last pass refused for the target alone: the demand that lets the target grow. */
  #refusedForTarget = 0;
  /** Queued trials per pool key that could start as the current pass began (a key's demand does not shrink as the pass starts its trials). */
  #startableOfKey = new Map<string, number>();
  /** The pass is a sample's or a submission's: a trial settling frees a slot but starts no server of a key's spread, so a start that keeps failing is retried once per sample, not per settle. */
  #mayStartKeyServers = false;
  /** Clients booted in the current pass: their cpu is not in the last sample. */
  #bootsThisPass = 0;
  /** The bounds that held trials in the last sample's pass, with how many each. */
  #held: Readonly<Record<string, number>> = {};
  #timingRunning = 0;
  /** Queued timing trials refused for the cpu bound at their last turn. */
  #timingWaitingForCalm = 0;
  #holdHolder: number | null = null;
  /** The submission that started the last trial: the next pass begins with the one after it, so submissions take turns. */
  #lastServed = 0;
  #nextSubmission = 1;
  #sequence = 0;

  readonly #host: TrialHost = {
    sendBack: (queued, admitted, why) => this.#sendBack(queued, admitted, why),
    unadmit: (queued, admitted) => this.#unadmit(queued, admitted),
    hitWallBound: serverId => { this.#admission = noteWallBoundHit(this.#admission, serverId); },
    settled: submission => { this.#finishIfDone(submission); this.#pump(false); },
  };

  constructor(private readonly deps: SchedulerDeps) {
    this.#admission = initialAdmissionState(deps.config);
    // A client lost or a tuple given up: boot another for the queued trials, or fail the trials that cannot get one, without waiting for the next sample.
    deps.clientsAhead?.onChange(() => this.#pump(false));
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

  /** What the last sample read and did, for the daemon's sample line; null before the first sample. */
  sampleReport(): SampleReport | null {
    const sample = this.#liveSample();
    if (!sample) return null;
    const { cpuBusy, ownCpu = null, load1 = null, memAvailableMb } = this.#base!;
    return {
      cpuBusy, ownCpu, load1, memAvailableMb, ledgerMb: ledgerMb(sample, this.#tally, this.deps.config), target: this.#admission.target,
      running: this.#running, queued: this.#queue.length, servers: sample.servers.length, starts: this.deps.pool.startedCount,
      held: this.#held, event: this.#admission.event,
    };
  }

  submit(spec: SubmissionSpec): SubmissionHandle {
    const submission: Submission = {
      id: this.#nextSubmission++, spec, abort: new AbortController(), summary: { runs: 0, passed: 0, failed: 0, cancelled: 0 },
      done: Promise.withResolvers<SubmissionSummary>(), running: 0, queued: 0,
    };
    this.#submissions.set(submission.id, submission);
    // A timing batch's trials get a pool key of their own: their servers are made for it and stop with it.
    const entries = spec.lock ? spec.entries.map(entry => ({ ...entry, placement: reservePlacement(entry.placement, submission.id) })) : spec.entries;
    const aheadClients = new Map(entries.map(entry => [entry, this.deps.clientsAhead && runsOurClientHost(entry.scenario) ? entry.scenario.client : null]));
    for (let cycle = 0; cycle < spec.repeat; cycle++) {
      for (const entry of entries) {
        this.#queue.push({
          sequence: ++this.#sequence, aheadClient: aheadClients.get(entry) ?? null, players: entry.scenario.players.length, queuedAt: this.deps.now(),
          heldBy: null, submission, entry, refusal: null, roomSamples: 0, waitingForCalm: false, sentBack: false,
        });
        submission.queued += 1;
      }
    }
    this.#finishIfDone(submission);
    this.#pump(false, true);
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
    const young = this.#young.filter(client => now - client.at < this.deps.config.clientRampMs);
    this.#young.splice(0, this.#young.length, ...young);
    const youngClientsMb = young.reduce((sum, client) => sum + client.mb, 0) + (this.deps.clientsAhead?.youngMb(now) ?? 0);
    this.#base = { at: now, ...machine, ownTrials: this.#running, youngClients: young.length, youngClientsMb };
    this.#tally = EMPTY_TALLY;
    this.#admission = advanceAdmissionState(this.#admission, this.#liveSample()!, this.#refusedForTarget > 0, this.deps.config);
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
    // Its trials that have not taken their clients never will: every client it booted and did not hand over dies now.
    this.deps.clientsAhead?.release(submission.id, reason);
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
    this.deps.clientsAhead?.release(submission.id, "the submission ended");
    if (this.#holdHolder === submission.id) this.#holdHolder = null;
    if (submission.spec.lock) this.deps.pool.releaseReservation(submission.id);
    submission.done.resolve(submission.summary);
  }

  /**
   * Walks the queue once in turn order: a trial held back never blocks the ones behind it, except one that has waited
   * `starveSamples` samples for room for a new server, which keeps the memory it needs from the trials after it.
   */
  #pump(isSample: boolean, mayStartKeyServers = isSample): void {
    if (!this.#base) return;
    this.#failTrialsOfUnbootableClients();
    this.#bootsThisPass = 0;
    this.#mayStartKeyServers = mayStartKeyServers;
    let starved: QueuedTrial | null = null;
    const held: Record<string, number> = {};
    let refusedForTarget = 0;
    this.#startableOfKey = countStartableTrialsPerKey(this.#queue);
    for (const queued of turnOrder(this.#queue, this.#lastServed)) {
      if (starved && this.#running > 0) {
        queued.refusal = `waits behind ${starved.entry.name}, which has waited ${starved.roomSamples} samples for room to start a server`;
        queued.heldBy = "starved";
      } else {
        queued.heldBy = null;
        queued.refusal = this.#tryStart(queued, isSample);
        if (queued.refusal !== null && queued.roomSamples >= this.deps.config.starveSamples) starved ??= queued;
      }
      if (queued.refusal === null) continue;
      held[queued.heldBy ?? "other"] = (held[queued.heldBy ?? "other"] ?? 0) + 1;
      if (queued.heldBy === "target") refusedForTarget += 1;
    }
    this.#refusedForTarget = refusedForTarget;
    if (isSample) this.#held = held;
    this.#bootClientsForQueuedTrials();
  }

  /** A trial whose client command failed to boot twice in its submission cannot run: it fails with the boot's stderr instead of waiting for a lane. */
  #failTrialsOfUnbootableClients(): void {
    const ahead = this.deps.clientsAhead;
    if (!ahead) return;
    for (const queued of [...this.#queue]) {
      const reason = queued.aheadClient && ahead.brokenReason(queued.submission.id, queued.aheadClient);
      if (!reason) continue;
      const { submission, entry } = queued;
      this.#queue.splice(this.#queue.indexOf(queued), 1);
      this.#setWaitingForCalm(queued, false);
      submission.queued -= 1;
      submission.summary.runs += 1;
      submission.summary.failed += 1;
      submission.spec.emit({ type: "result", name: entry.name, outcome: "error", elapsedMs: 0, detail: reason, error: reason, runDir: submission.spec.outDir });
      this.#finishIfDone(submission);
    }
  }

  /** What a client-booting step needs of this pass, or null when no client is booted ahead. */
  #aheadPass(): AheadPass | null {
    const ahead = this.deps.clientsAhead;
    if (!ahead) return null;
    return {
      ahead, config: this.deps.config, sample: this.#liveSample()!, tally: this.#tally, bootsThisPass: this.#bootsThisPass,
      timingBusy: this.#timingRunning + this.#timingWaitingForCalm > 0, isTiming: (submission, entry) => this.#isTiming(submission, entry),
    };
  }

  #bootClientsForQueuedTrials(): void {
    const pass = this.#aheadPass();
    if (!pass) return;
    const booted = bootClientsForQueuedTrials(pass, turnOrder(this.#queue, this.#lastServed));
    this.#bootsThisPass += booted;
    // The client holds its booted size until it is in MemAvailable; this pass's later decisions must see it.
    this.#tally = { ...this.#tally, reservedMb: this.#tally.reservedMb + booted * this.deps.config.clientBootedMemMb };
  }

  /** Null when the trial started; otherwise the reason it waits. */
  #tryStart(queued: QueuedTrial, isSample: boolean): string | null {
    const { submission, entry } = queued;
    const gate = this.#holdGate(submission);
    if (gate) return this.#refusedNotForRoom(queued, gate, "hold");
    const cap = submission.spec.maxLanes;
    if (cap !== null && submission.running >= cap) return this.#refusedNotForRoom(queued, `--lanes ${cap} reached for this submission`, "lanes");
    const decision = decideAdmission({
      sample: this.#liveSample()!, state: this.#admission, tally: this.#tally, config: this.deps.config,
      request: this.#requestFor(entry.placement, this.#isTiming(submission, entry), clientReserveMb(this.deps.config, this.deps.clientsAhead, queued)),
    });
    const timing = this.#isTiming(submission, entry);
    this.#setWaitingForCalm(queued, timing && !decision.admit && decision.bound === "cpu");
    if (decision.admit) {
      queued.roomSamples = 0;
      return this.#start(queued, decision);
    }
    queued.roomSamples = decision.waitsForServerRoom ? queued.roomSamples + (isSample ? 1 : 0) : 0;
    queued.heldBy = decision.bound;
    return `${decision.bound}: ${decision.detail}`;
  }

  #setWaitingForCalm(queued: QueuedTrial, waiting: boolean): void {
    if (queued.waitingForCalm === waiting) return;
    queued.waitingForCalm = waiting;
    this.#timingWaitingForCalm += waiting ? 1 : -1;
  }

  /** A refusal that is neither a wait for room for a new server nor for a calm machine: both waits start again from zero. */
  #refusedNotForRoom(queued: QueuedTrial, reason: string, heldBy: string): string {
    queued.roomSamples = 0;
    queued.heldBy = heldBy;
    this.#setWaitingForCalm(queued, false);
    return reason;
  }

  /** A hold batch's trials are never timing trials: the load it runs under is the point of it. */
  #isTiming(submission: Submission, entry: SubmissionEntry): boolean {
    return !submission.spec.hold && isTimingTrial(entry.placement, submission.spec.lock);
  }

  #requestFor(placement: Placement, timing: boolean, reserveMb: number): AdmissionRequest {
    const { pool, config } = this.deps;
    // A timing trial waiting for a calm machine counts as one running: the others start only under CPU_CALM until it has started.
    const base = { timing, timingRunning: this.#timingRunning + this.#timingWaitingForCalm, clientReserveMb: reserveMb };
    if (placement.kind !== "lane") return { ...base, candidates: pool.reusableSingles(placement.key), newServerHeapMb: config.singleHeapMb };
    const candidates = pool.sharedCandidates(placement.key);
    return { ...base, candidates, queues: pool.queues(candidates), newServerHeapMb: config.sharedHeapMb, spreadToNewServer: this.#mayStartKeyServers && this.#keyWantsMoreServers(placement.key) };
  }

  /** The key has servers, fewer than SERVERS_PER_KEY, and trials queued to fill them all to half (the first server of a key starts as any new server does). */
  #keyWantsMoreServers(key: string): boolean {
    const { pool, config } = this.deps;
    if (config.serversPerKey === 1) return false;
    const servers = pool.sharedServerCount(key);
    return servers > 0 && servers < config.serversPerKey && (this.#startableOfKey.get(key) ?? 0) >= spreadThreshold(config);
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
      ? pool.startServer(serverSpecFor(entry.placement, entry.scenario, config), now, ownStartReason(entry.placement), decision.spread ? config.serversPerKey : undefined)
      : pool.get(decision.server);
    if (!managed) return `server ${decision.server} left the pool`;
    let lane: Lane | null = null;
    let queue: MutexQueueMarks | null = null;
    let body = 0;
    if (entry.placement.kind === "lane") {
      lane = pool.leaseLane(managed.id);
      if (!lane) return `server ${managed.id} has no free lane`;
      queue = pool.joinMutexQueue(managed.id);
    } else {
      body = pool.noteSingleTrialStarted(managed.id);
    }
    const clientMb = clientReserveMb(this.deps.config, this.deps.clientsAhead, queued);
    const pass = this.#aheadPass();
    if (pass) this.#bootsThisPass += keepClientsFor(pass, queued);
    this.#tally = {
      trials: this.#tally.trials + 1, newServers: this.#tally.newServers + (decision.server === "new" ? 1 : 0),
      reservedMb: this.#tally.reservedMb + clientMb,
    };
    this.#young.push({ at: now, mb: clientMb });
    this.#running += 1;
    if (this.#isTiming(submission, entry)) this.#timingRunning += 1;
    this.#lastServed = submission.id;
    submission.running += 1;
    submission.queued -= 1;
    this.#queue.splice(this.#queue.indexOf(queued), 1);
    void runAdmittedTrial({ deps: this.deps, host: this.#host }, { queued, managed, lane, admitted: { at: now, queue, body, clientMb } });
    return null;
  }

  /** A server that failed to start or died before this trial's arrangement never ran it: it goes back to the queue once, to be placed on another server; a second failure stays its error. Returns false when it stays one. */
  #sendBack(queued: QueuedTrial, admitted: Admitted, why: string): boolean {
    const { submission, entry } = queued;
    if (queued.sentBack || submission.abort.signal.aborted) return false;
    queued.sentBack = true;
    this.#unadmit(queued, admitted, true);
    // The client of the admission never started a trial: it is not growing into the ledger.
    const young = this.#young.findIndex(client => client.at === admitted.at && client.mb === admitted.clientMb);
    if (young >= 0) this.#young.splice(young, 1);
    this.#tally = { ...this.#tally, reservedMb: this.#tally.reservedMb - admitted.clientMb };
    this.deps.log(`${entry.name}: ${why}, back in the queue`);
    const next = this.#queue.findIndex(other => other.sequence > queued.sequence);
    this.#queue.splice(next < 0 ? this.#queue.length : next, 0, queued);
    queued.refusal = null;
    queued.heldBy = null;
    queued.roomSamples = 0;
    submission.queued += 1;
    this.#pump(false);
    return true;
  }

  /** The trial leaves what admission gave it: its place in the mutex queue, its booked client, its count among the running. */
  #unadmit(queued: QueuedTrial, admitted: Admitted, sentBack = false): void {
    const { submission, entry } = queued;
    admitted.queue?.leave();
    // A client it was kept and never took (its server did not start, or died) goes back to the submission's spares.
    this.deps.clientsAhead?.trialEnded(queued.sequence, { sentBack });
    this.#running -= 1;
    if (this.#isTiming(submission, entry)) this.#timingRunning -= 1;
    this.#tally = { ...this.#tally, trials: this.#tally.trials - 1 };
    submission.running -= 1;
  }
}

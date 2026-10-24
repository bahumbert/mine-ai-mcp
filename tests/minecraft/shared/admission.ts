// The one place that decides whether a trial (and a new server for it) may start now: pure functions of a sample.
import type { ScenarioServerConfig } from "./config.ts";

export interface ServerReading {
  readonly id: string;
  readonly key: string;
  readonly status: "starting" | "ready" | "sick";
  /** Lane servers carry the tick-time and resident-size bounds; a single-scenario server only its health. */
  readonly shared: boolean;
  /** Null: no `tick query` answer yet. */
  readonly msptP95: number | null;
  readonly heapMb: number;
  readonly residentMb: number;
}

export interface AdmissionSample {
  readonly at: number;
  /** Null on the first reading, which has no window yet. */
  readonly cpuBusy: number | null;
  /** The share of the machine our process tree used over the same window; null or absent when it could not be read. */
  readonly ownCpu?: number | null;
  readonly memAvailableMb: number;
  readonly threads: number;
  readonly servers: readonly ServerReading[];
  /** Our trials running at the sample, including those admitted since it was read. */
  readonly ownTrials: number;
  /** Clients admitted less than `clientRampMs` ago, still growing into their memory. */
  readonly youngClients: number;
}

/** What has been admitted since the sample was read (the sample itself does not know). */
export interface AdmissionTally {
  readonly trials: number;
  readonly newServers: number;
  readonly reservedMb: number;
}

export const EMPTY_TALLY: AdmissionTally = { trials: 0, newServers: 0, reservedMb: 0 };

/** What a shared server has queued on its arrangement mutex: trials admitted whose arrangement has not run, restores not done. */
export interface ServerQueue {
  readonly queued: number;
  /** The mutex time one trial of this server takes (its arrangement plus its restore). */
  readonly holdMs: number;
}

interface ServerBackoff { readonly overStopStreak: number; readonly backedOff: boolean; readonly goodSamples: number }

/** What the last state advance did to the target, for the daemon log. */
export type AdmissionEvent = "halved" | "foreign load" | "memory full" | "grew";

export interface AdmissionState {
  readonly target: number;
  /** The first sample: the 60 s without a breach that growth needs start here. */
  readonly firstSampleAt: number | null;
  /** The last time a machine bound or a server bound was not held. */
  readonly lastBreachAt: number | null;
  readonly lastGrowAt: number | null;
  readonly servers: Readonly<Record<string, ServerBackoff>>;
  readonly event: AdmissionEvent | null;
}

export interface AdmissionRequest {
  /** Ids of the servers that could take this trial (same key with a lane, or an idle reusable server). */
  readonly candidates: readonly string[];
  /** The mutex queue of each shared candidate; a server not listed has none. */
  readonly queues?: ReadonlyMap<string, ServerQueue>;
  /** Heap of the server a new start would create. */
  readonly newServerHeapMb: number;
  /** This trial measures time (a locked batch, a scenario tagged exclusive): it starts only on a calm machine. */
  readonly timing?: boolean;
  /** Timing trials running now (this sample's admissions included) or waiting for a calm machine: while one is there nothing starts on a busy machine. */
  readonly timingRunning?: number;
}

export type AdmissionBound = "memory" | "cpu" | "target" | "server" | "new-server-per-sample";

export type AdmissionDecision =
  | { readonly admit: true; readonly server: string | "new"; readonly reserveMb: number }
  | { readonly admit: false; readonly bound: AdmissionBound; readonly detail: string; readonly waitsForServerRoom: boolean };

export function initialAdmissionState(config: ScenarioServerConfig): AdmissionState {
  return { target: config.targetStart, firstSampleAt: null, lastBreachAt: null, lastGrowAt: null, servers: {}, event: null };
}

/** MemAvailable minus what servers and young clients are still going to take, minus what this sample admitted. */
export function ledgerMb(sample: AdmissionSample, tally: AdmissionTally, config: ScenarioServerConfig): number {
  const serversStillGrowing = sample.servers.reduce(
    (sum, server) => sum + Math.max(0, server.heapMb + config.serverOverheadMb - server.residentMb), 0);
  return sample.memAvailableMb - serversStillGrowing - sample.youngClients * config.clientMemMb - tally.reservedMb;
}

function serverRefusal(reading: ServerReading | undefined, id: string, state: AdmissionState, config: ScenarioServerConfig): string | null {
  if (!reading) return `${id} is not in the sample`;
  if (reading.status === "sick") return `${id} is sick (a trial did not settle in time)`;
  if (state.servers[id]?.backedOff) return `${id} is backing off after lagging`;
  if (!reading.shared) return null;
  if (reading.msptP95 !== null && reading.msptP95 >= config.msptAdmitMs) {
    return `${id} tick time P95 ${reading.msptP95} ms is not under ${config.msptAdmitMs} ms`;
  }
  const limit = Math.floor(config.rssFull * (reading.heapMb + config.serverOverheadMb));
  if (reading.residentMb >= limit) return `${id} resident ${reading.residentMb} MB reached ${limit} MB, it takes no more lanes`;
  return null;
}

/** What the next trial of a shared server would wait for its arrangement turn: every queued trial's mutex time, and its own. */
function queueWaitMs(queue: ServerQueue | undefined, config: ScenarioServerConfig): number {
  return ((queue?.queued ?? 0) + 1) * (queue?.holdMs ?? config.arrangeHoldMs);
}

function refusal(bound: AdmissionBound, detail: string, waitsForServerRoom = false): AdmissionDecision {
  return { admit: false, bound, detail, waitsForServerRoom };
}

/**
 * Why the machine's cpu holds this trial back, or null. A plain trial with none of ours running is never held (foreign load
 * must not starve us: memory alone decides); a timing trial, and any trial while one runs, needs a calm machine and a reading.
 */
function cpuRefusalFor(sample: AdmissionSample, request: AdmissionRequest, running: number, config: ScenarioServerConfig): string | null {
  const calmNeeded = request.timing === true || (request.timingRunning ?? 0) > 0;
  const bound = calmNeeded ? config.cpuCalm : config.cpuAdmit;
  const reason = request.timing === true ? "a timing trial" : "a trial while a timing trial runs or waits for a calm machine";
  if (sample.cpuBusy === null) return calmNeeded ? `no cpu reading yet, ${reason} waits for one` : null;
  if (!calmNeeded && running === 0) return null;
  if (sample.cpuBusy < bound) return null;
  return `cpu ${Math.round(sample.cpuBusy * 100)}% busy, the bound is ${Math.round(bound * 100)}%${calmNeeded ? ` for ${reason}` : ""}`;
}

/** No new server can start now: the trial takes the shared server with the fewest trials on its mutex queue (the first on a tie). */
function shortestQueue(servers: readonly { readonly id: string; readonly queued: number }[], config: ScenarioServerConfig): AdmissionDecision {
  const shortest = servers.reduce((best, next) => (next.queued < best.queued ? next : best));
  return { admit: true, server: shortest.id, reserveMb: config.clientMemMb };
}

/** Admit the trial on a candidate server, on a new one, or refuse naming the bound that holds it. */
export function decideAdmission(input: {
  readonly sample: AdmissionSample;
  readonly state: AdmissionState;
  readonly tally: AdmissionTally;
  readonly request: AdmissionRequest;
  readonly config: ScenarioServerConfig;
}): AdmissionDecision {
  const { sample, state, tally, request, config } = input;
  const running = sample.ownTrials + tally.trials;
  const available = ledgerMb(sample, tally, config);
  if (available < config.clientMemMb) {
    return refusal("memory", `memory ledger ${available} MB does not cover a client (${config.clientMemMb} MB)`);
  }
  const cpuRefusal = cpuRefusalFor(sample, request, running, config);
  if (cpuRefusal) return refusal("cpu", cpuRefusal);
  if (running >= state.target) return refusal("target", `${running} trials running, the concurrency target is ${state.target}`);
  const refusals: string[] = [];
  /** Servers refused only for their arrangement queue, a placement preference: they take the trial when no new server can start for memory. */
  const queueFull: { readonly id: string; readonly queued: number }[] = [];
  for (const id of request.candidates) {
    const reading = sample.servers.find(server => server.id === id);
    const refusal = serverRefusal(reading, id, state, config);
    if (refusal) { refusals.push(refusal); continue; }
    const wait = reading?.shared ? queueWaitMs(request.queues?.get(id), config) : 0;
    if (wait <= config.arrangeQueueMs) return { admit: true, server: id, reserveMb: config.clientMemMb };
    queueFull.push({ id, queued: request.queues?.get(id)?.queued ?? 0 });
  }
  if (tally.newServers >= 1) {
    if (queueFull.length > 0) return shortestQueue(queueFull, config);
    return refusal("new-server-per-sample", [...refusals, "a new server starts at most once per sample"].join("; "));
  }
  const needed = config.clientMemMb + request.newServerHeapMb + config.serverMemMarginMb;
  if (available < needed && queueFull.length > 0) return shortestQueue(queueFull, config);
  if (available < needed) {
    const detail = `memory ledger ${available} MB does not cover a new server (${needed} MB)`;
    return refusal(refusals.length ? "server" : "memory", [...refusals, detail].join("; "), true);
  }
  return { admit: true, server: "new", reserveMb: needed };
}

function nextBackoff(previous: ServerBackoff | undefined, msptP95: number | null, config: ScenarioServerConfig): ServerBackoff {
  const before = previous ?? { overStopStreak: 0, backedOff: false, goodSamples: 0 };
  const overStopStreak = msptP95 !== null && msptP95 > config.msptStopMs ? before.overStopStreak + 1 : 0;
  if (overStopStreak >= 2) return { overStopStreak, backedOff: true, goodSamples: 0 };
  if (!before.backedOff) return { overStopStreak, backedOff: false, goodSamples: 0 };
  const goodSamples = msptP95 !== null && msptP95 < config.msptAdmitMs ? before.goodSamples + 1 : 0;
  return goodSamples >= config.recoverySamples
    ? { overStopStreak, backedOff: false, goodSamples: 0 }
    : { overStopStreak, backedOff: true, goodSamples };
}

/** Our process tree used under OWN_SHARE_HALVE of the busy cpu: the breach is other workers' load, and halving our target would not cure it. */
function cpuIsForeign(sample: AdmissionSample, config: ScenarioServerConfig): boolean {
  const own = sample.ownCpu;
  return own !== null && own !== undefined && sample.cpuBusy !== null && sample.cpuBusy > 0 && own < config.ownShareHalve * sample.cpuBusy;
}

/** The cpu the machine would show with one more trial of ours: each running trial is taken to cost an equal share of what we use now. */
function projectedCpu(sample: AdmissionSample): number {
  const perTrial = (sample.ownCpu ?? sample.cpuBusy ?? 0) / Math.max(1, sample.ownTrials);
  return (sample.cpuBusy ?? 0) + perTrial;
}

/**
 * Called once per sample: server back-off, target halving on a cpu breach of our own making, and +1 growth while trials
 * wait at the target (`demandAtTarget`): no breach for GROW_AFTER, the last growth GROW_EVERY ago, the projected cpu under the bound.
 */
export function advanceAdmissionState(
  state: AdmissionState,
  sample: AdmissionSample,
  demandAtTarget: boolean,
  config: ScenarioServerConfig,
): AdmissionState {
  const servers = Object.fromEntries(
    sample.servers.map(server => [server.id, nextBackoff(state.servers[server.id], server.msptP95, config)]));
  const cpuBreached = sample.cpuBusy !== null && sample.cpuBusy >= config.cpuAdmit;
  const memoryFull = ledgerMb(sample, EMPTY_TALLY, config) < config.clientMemMb;
  const serverLagging = sample.servers.some(server => server.shared && server.msptP95 !== null && server.msptP95 >= config.msptAdmitMs);
  const serverBackedOff = Object.values(servers).some(backoff => backoff.backedOff);
  const breached = cpuBreached || memoryFull || serverLagging || serverBackedOff;
  const lastBreachAt = breached ? sample.at : state.lastBreachAt;
  const firstSampleAt = state.firstSampleAt ?? sample.at;
  const next: AdmissionState = { ...state, servers, lastBreachAt, firstSampleAt, event: null };
  if (sample.ownTrials > 0 && cpuBreached && !cpuIsForeign(sample, config)) {
    // CPU over the bound with our trials as the cause is overload: halve.
    return { ...next, target: Math.max(1, Math.floor(state.target / 2)), event: "halved" };
  }
  if (sample.ownTrials > 0 && memoryFull) {
    // A full ledger is capacity, not overload, and the ledger refuses every admission by itself while it is full: the target
    // stays where it is. (T4 capped it at the trials running; the tail of a batch then left it at 2 for the next batch,
    // which took 266 s warm to climb back, T7c measurement.)
    return { ...next, event: "memory full" };
  }
  if (sample.ownTrials > 0 && cpuBreached) return { ...next, event: "foreign load" };
  const quietSince = Math.max(lastBreachAt ?? -Infinity, firstSampleAt);
  const mayGrow = demandAtTarget && !breached && sample.cpuBusy !== null
    && sample.at - quietSince >= config.growAfterMs
    && sample.at - (state.lastGrowAt ?? -Infinity) >= config.growEveryMs
    && projectedCpu(sample) < config.cpuAdmit;
  return mayGrow ? { ...next, target: state.target + 1, lastGrowAt: sample.at, event: "grew" } : next;
}

/** A trial on this server hit its wall-clock bound: no new trial until it recovers. */
export function noteWallBoundHit(state: AdmissionState, serverId: string): AdmissionState {
  return { ...state, servers: { ...state.servers, [serverId]: { overStopStreak: 0, backedOff: true, goodSamples: 0 } } };
}

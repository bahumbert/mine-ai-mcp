// The one place that decides whether a trial (and a new server for it) may start now: pure functions of a sample.
import type { ScenarioServerConfig } from "./config.ts";

export interface ServerReading {
  readonly id: string;
  readonly key: string;
  readonly status: "starting" | "ready" | "sick";
  /** Lane servers carry the tick-time and resident-size bounds; a single-scenario server only its health. */
  readonly shared: boolean;
  /** Can still grow into its heap: starting, a trial running on it, or its arrangement mutex queue holding an arrangement or a restore. An idle warm server stays where it is. */
  readonly busy: boolean;
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
  /**
   * What the young clients still have to grow into, in MB, when it is not `youngClients` whole clients: a trial that took a client booted
   * ahead reserves only its difference to a logged-in client, and a client booted ahead for a queued trial reserves its booted size.
   */
  readonly youngClientsMb?: number;
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
  /** What this trial's client adds to the ledger when it is not a whole client (`clientMemMb`): the client was booted ahead, so only its login is still to come. */
  readonly clientReserveMb?: number;
  /** Heap of the server a new start would create. */
  readonly newServerHeapMb: number;
  /** The key has enough trials queued to fill `serversPerKey` servers and fewer servers than that: a new one starts now, whatever the candidates could take. */
  readonly spreadToNewServer?: boolean;
  /** This trial measures time (a locked batch, a scenario tagged exclusive): it starts only on a calm machine. */
  readonly timing?: boolean;
  /** Timing trials running now (this sample's admissions included) or waiting for a calm machine: while one is there nothing starts on a busy machine. */
  readonly timingRunning?: number;
}

export type AdmissionBound = "memory" | "cpu" | "target" | "server" | "new-server-per-sample";

export type AdmissionDecision =
  | { readonly admit: true; readonly server: string | "new"; readonly reserveMb: number; readonly spread?: true }
  | { readonly admit: false; readonly bound: AdmissionBound; readonly detail: string; readonly waitsForServerRoom: boolean };

export function initialAdmissionState(config: ScenarioServerConfig): AdmissionState {
  return { target: config.targetStart, firstSampleAt: null, lastBreachAt: null, lastGrowAt: null, servers: {}, event: null };
}

/** What a server will take from MemAvailable before it is full: its heap and overhead less what it already holds. */
function growthMb(server: ServerReading, config: ScenarioServerConfig): number {
  return Math.max(0, server.heapMb + config.serverOverheadMb - server.residentMb);
}

/**
 * MemAvailable minus what busy servers and young clients are still going to take, minus what this sample admitted. An idle warm
 * server is not counted (it will not grow, and its resident size is already out of MemAvailable). The trial admitted onto it
 * must find that growth plus its client free (`reserveMb`); the scheduler then leases the lane, which makes the server busy in the
 * next reading, so the ledger holds the growth from there and the tally keeps only the client.
 */
export function ledgerMb(sample: AdmissionSample, tally: AdmissionTally, config: ScenarioServerConfig): number {
  const serversStillGrowing = sample.servers.reduce((sum, server) => sum + (server.busy ? growthMb(server, config) : 0), 0);
  return sample.memAvailableMb - serversStillGrowing - (sample.youngClientsMb ?? sample.youngClients * config.clientMemMb) - tally.reservedMb;
}

/**
 * What the ledger keeps free beyond `serverMemMarginMb` after an admission that reserves `reserveMb`: negative when the admission would take it
 * under the margin. The one rule of every path (a lane on a running server, an idle server's growth, a new server, a client booted ahead):
 * the margin is the reserve that other daemons and a live run sharing the machine draw on, and this ledger does not see them.
 */
export function roomAfterAdmissionMb(ledger: number, reserveMb: number, config: Pick<ScenarioServerConfig, "serverMemMarginMb">): number {
  return ledger - reserveMb - config.serverMemMarginMb;
}

/** The refusal text of a ledger that cannot cover `reserveMb` (`what`) and the margin. */
export function marginRefusalDetail(ledger: number, reserveMb: number, what: string, config: Pick<ScenarioServerConfig, "serverMemMarginMb">): string {
  return `memory ledger ${ledger} MB does not cover ${what} (${reserveMb} MB) and the server margin (${config.serverMemMarginMb} MB)`;
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

/** The memory one more trial reserves on this server: its client, and the growth the trial wakes when the server is idle. */
function reserveOn(reading: ServerReading, clientMb: number, config: ScenarioServerConfig): number {
  return clientMb + (reading.busy ? 0 : growthMb(reading, config));
}

/** A shared server that could take the trial: its mutex queue and what the trial reserves on it. */
interface ServerOffer { readonly id: string; readonly queued: number; readonly reserveMb: number }

/** The trial takes the shared server with the fewest trials on its mutex queue (the first on a tie). */
function shortestQueue(servers: readonly ServerOffer[]): AdmissionDecision {
  const shortest = servers.reduce((best, next) => (next.queued < best.queued ? next : best));
  return { admit: true, server: shortest.id, reserveMb: shortest.reserveMb };
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
  const clientMb = request.clientReserveMb ?? config.clientMemMb;
  const available = ledgerMb(sample, tally, config);
  if (roomAfterAdmissionMb(available, clientMb, config) < 0) {
    return refusal("memory", marginRefusalDetail(available, clientMb, "a client", config));
  }
  const cpuRefusal = cpuRefusalFor(sample, request, running, config);
  if (cpuRefusal) return refusal("cpu", cpuRefusal);
  if (running >= state.target) return refusal("target", `${running} trials running, the concurrency target is ${state.target}`);
  // A new server's reserve holds the margin (the tally of the pass keeps it from the next admission); the other reserves leave it free outside.
  const needed = clientMb + request.newServerHeapMb + config.serverMemMarginMb;
  // A spread start is the key's servers starting together, not the next server of a sample: only the ledger holds it.
  const newServerFits = roomAfterAdmissionMb(available, clientMb + request.newServerHeapMb, config) >= 0;
  if (request.spreadToNewServer && newServerFits) return { admit: true, server: "new", reserveMb: needed, spread: true };
  const refusals: string[] = [];
  /** Idle candidates the ledger cannot afford the growth of: a memory refusal, not a server one. */
  const unaffordable: string[] = [];
  /** Servers refused only for their arrangement queue, a placement preference: they take the trial when no new server can start for memory. */
  const queueFull: ServerOffer[] = [];
  /** With servers spread, every candidate that fits competes on queue length; with 1 the first that fits takes the trial. */
  const fitting: ServerOffer[] = [];
  for (const id of request.candidates) {
    const reading = sample.servers.find(server => server.id === id);
    const refusal = serverRefusal(reading, id, state, config);
    if (refusal || !reading) {
      if (refusal) refusals.push(refusal);
      continue;
    }
    const reserveMb = reserveOn(reading, clientMb, config);
    if (roomAfterAdmissionMb(available, reserveMb, config) < 0) {
      unaffordable.push(marginRefusalDetail(available, reserveMb, `${id}'s client and the ${reserveMb - clientMb} MB it grows by (idle server)`, config));
      continue;
    }
    const wait = reading.shared ? queueWaitMs(request.queues?.get(id), config) : 0;
    const offer = { id, queued: request.queues?.get(id)?.queued ?? 0, reserveMb };
    if (wait > config.arrangeQueueMs) queueFull.push(offer);
    else if (config.serversPerKey === 1) return { admit: true, server: id, reserveMb };
    else fitting.push(offer);
  }
  if (fitting.length > 0) return shortestQueue(fitting);
  if (tally.newServers >= 1) {
    if (queueFull.length > 0) return shortestQueue(queueFull);
    if (unaffordable.length > 0 && refusals.length === 0) return refusal("memory", unaffordable.join("; "), true);
    return refusal("new-server-per-sample", [...refusals, ...unaffordable, "a new server starts at most once per sample"].join("; "));
  }
  if (!newServerFits && queueFull.length > 0) return shortestQueue(queueFull);
  if (!newServerFits) {
    const detail = marginRefusalDetail(available, clientMb + request.newServerHeapMb, "a client and a new server", config);
    return refusal(refusals.length ? "server" : "memory", [...refusals, ...unaffordable, detail].join("; "), true);
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
  const memoryFull = roomAfterAdmissionMb(ledgerMb(sample, EMPTY_TALLY, config), config.clientMemMb, config) < 0;
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

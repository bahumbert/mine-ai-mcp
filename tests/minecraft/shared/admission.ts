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

interface ServerBackoff { readonly overStopStreak: number; readonly backedOff: boolean; readonly goodSamples: number }

export interface AdmissionState {
  readonly target: number;
  readonly lastAdmissionAt: number | null;
  /** The last time a machine bound or a server bound was not held. */
  readonly lastBreachAt: number | null;
  readonly lastGrowAt: number | null;
  readonly servers: Readonly<Record<string, ServerBackoff>>;
}

export interface AdmissionRequest {
  /** Ids of the servers that could take this trial (same key with a lane, or an idle reusable server). */
  readonly candidates: readonly string[];
  /** Heap of the server a new start would create. */
  readonly newServerHeapMb: number;
}

export type AdmissionBound = "memory" | "cpu" | "target" | "server" | "new-server-per-sample";

export type AdmissionDecision =
  | { readonly admit: true; readonly server: string | "new"; readonly reserveMb: number }
  | { readonly admit: false; readonly bound: AdmissionBound; readonly detail: string };

export function initialAdmissionState(config: ScenarioServerConfig): AdmissionState {
  return { target: config.targetStart, lastAdmissionAt: null, lastBreachAt: null, lastGrowAt: null, servers: {} };
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
    return { admit: false, bound: "memory", detail: `memory ledger ${available} MB does not cover a client (${config.clientMemMb} MB)` };
  }
  // With none of our trials running, foreign load must not starve us: memory alone decides.
  if (running > 0 && sample.cpuBusy !== null && sample.cpuBusy >= config.cpuAdmit) {
    return { admit: false, bound: "cpu", detail: `cpu ${Math.round(sample.cpuBusy * 100)}% busy, the bound is ${Math.round(config.cpuAdmit * 100)}%` };
  }
  if (running >= state.target) {
    return { admit: false, bound: "target", detail: `${running} trials running, the concurrency target is ${state.target}` };
  }
  const refusals: string[] = [];
  for (const id of request.candidates) {
    const refusal = serverRefusal(sample.servers.find(server => server.id === id), id, state, config);
    if (!refusal) return { admit: true, server: id, reserveMb: config.clientMemMb };
    refusals.push(refusal);
  }
  if (tally.newServers >= 1) {
    return { admit: false, bound: "new-server-per-sample", detail: [...refusals, "a new server starts at most once per sample"].join("; ") };
  }
  const needed = config.clientMemMb + request.newServerHeapMb + config.serverMemMarginMb;
  if (available < needed) {
    const detail = `memory ledger ${available} MB does not cover a new server (${needed} MB)`;
    return { admit: false, bound: refusals.length ? "server" : "memory", detail: [...refusals, detail].join("; ") };
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

/** Called once per sample: server back-off, target halving on a machine breach, +1 growth after GROW_AFTER of held bounds. */
export function advanceAdmissionState(
  state: AdmissionState,
  sample: AdmissionSample,
  demand: boolean,
  config: ScenarioServerConfig,
): AdmissionState {
  const servers = Object.fromEntries(
    sample.servers.map(server => [server.id, nextBackoff(state.servers[server.id], server.msptP95, config)]));
  const cpuBreached = sample.cpuBusy !== null && sample.cpuBusy >= config.cpuAdmit;
  const memoryFull = ledgerMb(sample, EMPTY_TALLY, config) < config.clientMemMb;
  const machineBreached = cpuBreached || memoryFull;
  const serverLagging = sample.servers.some(server => server.shared && server.msptP95 !== null && server.msptP95 >= config.msptAdmitMs);
  const breached = machineBreached || serverLagging;
  const lastBreachAt = breached ? sample.at : state.lastBreachAt;
  if (sample.ownTrials > 0 && (cpuBreached || memoryFull)) {
    // CPU over the bound is overload: halve. A full memory ledger is capacity: hold at what runs, so the batch keeps that many going.
    const target = cpuBreached ? Math.floor(state.target / 2) : Math.min(state.target, sample.ownTrials);
    return { ...state, servers, lastBreachAt, target: Math.max(1, target) };
  }
  const lastEventAt = Math.max(state.lastAdmissionAt ?? -Infinity, lastBreachAt ?? -Infinity, state.lastGrowAt ?? -Infinity);
  // The first sample starts the growth clock: a target is not raised before it has been held for GROW_AFTER.
  if (lastEventAt === -Infinity) return { ...state, servers, lastBreachAt, lastGrowAt: sample.at };
  if (demand && !breached && sample.at - lastEventAt >= config.growAfterMs) {
    return { ...state, servers, lastBreachAt, target: state.target + 1, lastGrowAt: sample.at };
  }
  return { ...state, servers, lastBreachAt };
}

export function noteAdmission(state: AdmissionState, at: number): AdmissionState {
  return { ...state, lastAdmissionAt: at };
}

/** A trial on this server hit its wall-clock bound: no new trial until it recovers. */
export function noteWallBoundHit(state: AdmissionState, serverId: string): AdmissionState {
  return { ...state, servers: { ...state.servers, [serverId]: { overStopStreak: 0, backedOff: true, goodSamples: 0 } } };
}

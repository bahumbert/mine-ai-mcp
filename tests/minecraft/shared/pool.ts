// The servers the daemon owns: one or more per settings key, lanes leased from each, single-scenario servers, idle and sick stops.
import type { Scenario } from "mine-labs";
import { LAST_BODY, type Lane } from "../arena/lanes.ts";
import type { ServerQueue, ServerReading } from "./admission.ts";
import { ArrangementMutex } from "./arrangement-mutex.ts";
import { lanesPerServer, type ScenarioServerConfig } from "./config.ts";
import { StallWatch } from "./health.ts";
import { LanePool } from "./lane-pool.ts";
import type { ScenarioServer } from "./scenario-server.ts";
import type { TrialEnd } from "./trial.ts";

/** What a new server is: its key, kind and heap, the commands that set it up once, and a scenario naming version and world. */
export interface ServerSpec {
  readonly kind: ScenarioServer["kind"];
  readonly key: string;
  readonly heapMb: number;
  /** Run once after the server is up (the key's settings, the block limit); empty for a single-scenario server. */
  readonly setup: readonly string[];
  readonly scenario: Scenario;
  /** The locked batch this server was made for: no other submission's trial uses it, and it stops when that batch ends. */
  readonly reservedFor?: number;
}

export type ServerRequest = ServerSpec & { readonly id: string };

/** Starts one server (process, ports, world) and returns it ready for commands. */
export interface ServerFactory {
  create(request: ServerRequest): Promise<ScenarioServer>;
}

type ServerStatus = ServerReading["status"];

/** Trials of a server whose mutex time its hold is the median of. */
const HOLD_WINDOW = 20;
/** Settled trials a server needs before its own median replaces ARRANGE_HOLD_MS. */
const HOLD_MIN_TRIALS = 3;

/**
 * One lane trial's place in its server's arrangement queue: the arrangement it waits for, then the restore it waits for.
 * Each mark counts once; `leave` takes off whatever is left (an abort before the arrangement, a restore the bound gave up on).
 */
export interface MutexQueueMarks {
  /** The arrangement has run (or failed, or was cancelled): the trial no longer waits for the mutex for it. */
  arranged(): void;
  restoreQueued(): void;
  restoreDone(): void;
  leave(): void;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface ManagedServer {
  readonly id: string;
  readonly key: string;
  readonly kind: ScenarioServer["kind"];
  readonly mutex: ArrangementMutex;
  /** Resolves with the server once its setup commands ran; rejects when it could not start. */
  readonly ready: Promise<ScenarioServer>;
}

interface PoolEntry extends ManagedServer {
  readonly heapMb: number;
  readonly reservedFor: number | null;
  readonly lanes: LanePool | null;
  readonly stall: StallWatch;
  server: ScenarioServer | null;
  status: ServerStatus;
  running: number;
  lastTrialAt: number;
  msptP95: number | null;
  residentMb: number;
  /** A single-scenario server waiting for its next scenario of the same key. */
  idleReusable: boolean;
  /** Stop as soon as nothing runs on it (sick, restart, or a scenario that dirtied its world). */
  retire: boolean;
  /** Trials admitted to this shared server whose arrangement has not run, plus restores queued or running: all want its mutex. */
  mutexQueued: number;
  /** The mutex time (arrange + restore) of the last HOLD_WINDOW settled trials. */
  holds: number[];
  /** The body a single server's next scenario gets (its first scenario is body 0). */
  nextBody: number;
}

/** Can still grow into its heap: starting, a trial running on it, or its mutex queue holding an arrangement or a restore. */
function isBusy(entry: PoolEntry): boolean {
  return entry.status === "starting" || entry.running > 0 || entry.mutexQueued > 0;
}

export class ServerPool {
  readonly #entries = new Map<string, PoolEntry>();
  #nextId = 1;
  #started = 0;

  constructor(
    private readonly factory: ServerFactory,
    private readonly config: ScenarioServerConfig,
    private readonly log: (message: string) => void,
  ) {}

  /** Servers started since the daemon began: the sample line shows it. */
  get startedCount(): number {
    return this.#started;
  }

  /** Why a server for this spec is started now: the plan's reasons for the log, so the starts of a run can be explained. */
  #startReason(spec: ServerSpec, spreadOver?: number): string {
    if (spec.key.startsWith("probe:")) return "probe";
    if (spec.kind === "single") return "own, no idle server of its key";
    const ofKey = [...this.#entries.values()].filter(entry => entry.kind === "shared" && entry.key === spec.key);
    const retired = ofKey.find(entry => entry.retire);
    if (retired) return `replaces retired ${retired.id}`;
    if (ofKey.length === 0) return "new key";
    if (spreadOver !== undefined) return `spread over ${spreadOver} servers`;
    // A server of the key with a free lane was refused for its mutex queue, tick time or size; without one the lanes are all in use.
    return ofKey.some(entry => entry.lanes!.freeCount > 0 && entry.status !== "sick") ? "key's servers refused it (arrangement queue, tick time or size)" : "key full";
  }

  /** Begin creating a server; it is listed as `starting` at once and its `ready` settles when it is usable. `reason` is logged (the pool names its own when none is given; `spreadOver`, the servers a key spreads over, is the pool's reason for a key's other servers). */
  startServer(spec: ServerSpec, now: number, reason?: string, spreadOver?: number): ManagedServer {
    reason ??= this.#startReason(spec, spreadOver);
    const id = `s${this.#nextId++}`;
    this.#started += 1;
    this.log(`server ${id} (${spec.kind}, key ${spec.key.slice(0, 60)}) starting: ${reason}`);
    const entry: PoolEntry = {
      id, key: spec.key, kind: spec.kind, heapMb: spec.heapMb, reservedFor: spec.reservedFor ?? null, mutex: new ArrangementMutex(),
      lanes: spec.kind === "shared" ? new LanePool(lanesPerServer(this.config)) : null,
      stall: new StallWatch(this.config.stallStopMs, now), server: null, status: "starting", running: 0,
      lastTrialAt: now, msptP95: null, residentMb: 0, idleReusable: false, retire: false,
      mutexQueued: 0, holds: [], nextBody: 0,
      ready: this.#create(id, spec),
    };
    this.#entries.set(id, entry);
    entry.ready.then(server => { entry.server = server; entry.status = "ready"; }, () => { this.#entries.delete(id); });
    return entry;
  }

  async #create(id: string, spec: ServerSpec): Promise<ScenarioServer> {
    const server = await this.factory.create({ ...spec, id });
    try {
      for (const command of spec.setup) await server.command(command);
    } catch (error) {
      await server.stop();
      throw error;
    }
    this.log(`server ${id} (${spec.kind}, key ${spec.key.slice(0, 60)}) ready on port ${server.gamePort}`);
    return server;
  }

  /** A locked batch ended: its servers stop as soon as nothing runs on them (never reused, never kept for SERVER_IDLE). */
  releaseReservation(submissionId: number): void {
    for (const entry of this.#entries.values()) if (entry.reservedFor === submissionId) entry.retire = true;
  }

  get(id: string): ManagedServer | undefined {
    return this.#entries.get(id);
  }

  list(): readonly ManagedServer[] {
    return [...this.#entries.values()];
  }

  readings(): ServerReading[] {
    return [...this.#entries.values()].map(entry => ({
      id: entry.id, key: entry.key, status: entry.status, shared: entry.kind === "shared", busy: isBusy(entry),
      msptP95: entry.msptP95, heapMb: entry.heapMb, residentMb: entry.residentMb,
    }));
  }

  /** Shared servers of the key that are not sick or retired, starting ones and full ones included. */
  sharedServerCount(key: string): number {
    return [...this.#entries.values()].filter(entry => entry.kind === "shared" && entry.key === key && entry.status !== "sick" && !entry.retire).length;
  }

  /** Shared servers of the key that can take another lane. */
  sharedCandidates(key: string): string[] {
    return [...this.#entries.values()]
      .filter(entry => entry.kind === "shared" && entry.key === key && entry.status !== "sick" && !entry.retire && entry.lanes!.freeCount > 0)
      .map(entry => entry.id);
  }

  /** Single-scenario servers idle and left reusable for this key. */
  reusableSingles(key: string): string[] {
    return [...this.#entries.values()]
      .filter(entry => entry.kind === "single" && entry.key === key && entry.idleReusable && entry.status === "ready")
      .map(entry => entry.id);
  }

  /** The mutex queue and hold of each of these shared servers (a server of its own, or one that left, has no entry). */
  queues(ids: readonly string[]): Map<string, ServerQueue> {
    const queues = new Map<string, ServerQueue>();
    for (const id of ids) {
      const entry = this.#entries.get(id);
      if (entry?.kind !== "shared") continue;
      const holdMs = entry.holds.length >= HOLD_MIN_TRIALS ? median(entry.holds) : this.config.arrangeHoldMs;
      queues.set(id, { queued: entry.mutexQueued, holdMs });
    }
    return queues;
  }

  /** A lane trial has been admitted to this shared server: it now waits for the mutex. Null for a server of its own, which has none. */
  joinMutexQueue(id: string): MutexQueueMarks | null {
    const entry = this.#entries.get(id);
    if (entry?.kind !== "shared") return null;
    const waiting = { arrangement: true, restore: false };
    entry.mutexQueued += 1;
    const take = (key: keyof typeof waiting, now: boolean): void => {
      if (waiting[key] === now) return;
      waiting[key] = now;
      entry.mutexQueued += now ? 1 : -1;
    };
    return {
      arranged: () => take("arrangement", false),
      restoreQueued: () => take("restore", true),
      restoreDone: () => take("restore", false),
      leave: () => { take("arrangement", false); take("restore", false); },
    };
  }

  leaseLane(id: string): Lane | null {
    const entry = this.#entries.get(id);
    const lane = entry?.lanes?.acquire() ?? null;
    if (entry && lane) entry.running += 1;
    return lane;
  }

  /** A scenario starts on a server of its own; returns its body (0 for the first scenario of the server's life, then 1, 2...). */
  noteSingleTrialStarted(id: string): number {
    const entry = this.#entries.get(id);
    if (!entry) return 0;
    entry.idleReusable = false;
    entry.running += 1;
    return entry.nextBody++;
  }

  /** The ready servers, for the sampler to ask them `tick query`. */
  healthTargets(): { readonly id: string; readonly server: ScenarioServer }[] {
    return [...this.#entries.values()].flatMap(entry => (entry.status !== "starting" && entry.server ? [{ id: entry.id, server: entry.server }] : []));
  }

  setHealth(id: string, health: { readonly msptP95: number | null; readonly residentMb: number }): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    entry.msptP95 = health.msptP95;
    entry.residentMb = health.residentMb;
  }

  /** The server answered a command (whatever it said): it is not stalled. */
  answered(id: string, now: number): void {
    this.#entries.get(id)?.stall.answered(now);
  }

  /** Stop, now and by force of the server, the servers silent for STALL_STOP; their trials fail on the dead RCON. Returns their ids. */
  async stopStalled(now: number): Promise<string[]> {
    const stalled = [...this.#entries.values()].filter(entry => entry.status === "ready" && entry.stall.isStalled(now));
    for (const entry of stalled) {
      this.log(`server ${entry.id} answered nothing for ${this.config.stallStopMs} ms: stopping it`);
      this.#entries.delete(entry.id);
    }
    await Promise.allSettled(stalled.map(entry => this.#stop(entry, "stalled")));
    return stalled.map(entry => entry.id);
  }

  /** A trial ended: free, quarantine or keep its lane as the end says, and decide what happens to the server. */
  finishTrial(id: string, lane: Lane | null, end: TrialEnd, now: number, options: { readonly reusable?: boolean } = {}): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    entry.running -= 1;
    entry.lastTrialAt = now;
    // Only a trial that was arranged and restored measures the mutex: a cancelled or failed one has 0 or its whole time as arrange.
    if (entry.kind === "shared" && end.phases && end.restored) entry.holds = [...entry.holds, end.phases.arrangeMs + end.phases.restoreMs].slice(-HOLD_WINDOW);
    if (lane && entry.lanes) {
      if (end.lane === "free") entry.lanes.release(lane);
      else if (end.lane === "quarantined") entry.lanes.quarantine(lane);
    }
    if (end.serverSick) {
      entry.status = "sick";
      entry.retire = true;
    }
    if (entry.kind === "single") {
      // A body past the last one would give a name back to a player the server has seen: the server is retired instead.
      const reusable = Boolean(options.reusable) && end.lane === "free" && !end.serverSick && entry.nextBody <= LAST_BODY;
      entry.idleReusable = reusable;
      entry.retire = !reusable;
    } else if (entry.lanes?.needsRestart) {
      entry.retire = true;
    }
  }

  markSick(id: string): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    entry.status = "sick";
    entry.retire = true;
  }

  /** Stop what has drained and must go (sick, restart, dirtied), and what has been idle past SERVER_IDLE with its key not wanted. */
  async reap(now: number, wantedKeys: ReadonlySet<string>): Promise<void> {
    const stopping = [...this.#entries.values()].filter(entry => {
      if (entry.status === "starting" || entry.running > 0) return false;
      if (entry.retire) return true;
      return now - entry.lastTrialAt >= this.config.serverIdleMs && !wantedKeys.has(entry.key);
    });
    for (const entry of stopping) this.#entries.delete(entry.id);
    await Promise.allSettled(stopping.map(entry => this.#stop(entry, this.#stopReason(entry))));
  }

  /** Why a drained server stops: the plan's reasons for the log. */
  #stopReason(entry: PoolEntry): string {
    if (entry.status === "sick") return "sick";
    if (entry.kind === "single" && entry.retire) return "own after trial";
    return entry.retire ? "retired" : "idle";
  }

  async stopAll(): Promise<void> {
    const all = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.allSettled(all.map(entry => this.#stop(entry, "daemon stopping")));
  }

  async #stop(entry: PoolEntry, reason: string): Promise<void> {
    this.log(`server ${entry.id} stopping: ${reason}`);
    const server = entry.server ?? await entry.ready.catch(() => null);
    await server?.stop();
  }
}

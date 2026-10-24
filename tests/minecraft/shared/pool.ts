// The servers the daemon owns: one or more per settings key, lanes leased from each, single-scenario servers, idle and sick stops.
import type { Scenario } from "mine-labs";
import type { Lane } from "../arena/lanes.ts";
import type { ServerReading } from "./admission.ts";
import { ArrangementMutex } from "./arrangement-mutex.ts";
import type { ScenarioServerConfig } from "./config.ts";
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
}

export class ServerPool {
  readonly #entries = new Map<string, PoolEntry>();
  #nextId = 1;

  constructor(
    private readonly factory: ServerFactory,
    private readonly config: ScenarioServerConfig,
    private readonly log: (message: string) => void,
  ) {}

  /** Begin creating a server; it is listed as `starting` at once and its `ready` settles when it is usable. */
  startServer(spec: ServerSpec, now: number): ManagedServer {
    const id = `s${this.#nextId++}`;
    const entry: PoolEntry = {
      id, key: spec.key, kind: spec.kind, heapMb: spec.heapMb, reservedFor: spec.reservedFor ?? null, mutex: new ArrangementMutex(),
      lanes: spec.kind === "shared" ? new LanePool(this.config.maxPlayers - 2) : null,
      stall: new StallWatch(this.config.stallStopMs, now), server: null, status: "starting", running: 0,
      lastTrialAt: now, msptP95: null, residentMb: 0, idleReusable: false, retire: false,
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
      id: entry.id, key: entry.key, status: entry.status, shared: entry.kind === "shared",
      msptP95: entry.msptP95, heapMb: entry.heapMb, residentMb: entry.residentMb,
    }));
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

  leaseLane(id: string): Lane | null {
    const entry = this.#entries.get(id);
    const lane = entry?.lanes?.acquire() ?? null;
    if (entry && lane) entry.running += 1;
    return lane;
  }

  noteSingleTrialStarted(id: string): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    entry.idleReusable = false;
    entry.running += 1;
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
    await Promise.allSettled(stalled.map(entry => this.#stop(entry)));
    return stalled.map(entry => entry.id);
  }

  /** A trial ended: free, quarantine or keep its lane as the end says, and decide what happens to the server. */
  finishTrial(id: string, lane: Lane | null, end: TrialEnd, now: number, options: { readonly reusable?: boolean } = {}): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    entry.running -= 1;
    entry.lastTrialAt = now;
    if (lane && entry.lanes) {
      if (end.lane === "free") entry.lanes.release(lane);
      else if (end.lane === "quarantined") entry.lanes.quarantine(lane);
    }
    if (end.serverSick) {
      entry.status = "sick";
      entry.retire = true;
    }
    if (entry.kind === "single") {
      const reusable = Boolean(options.reusable) && end.lane === "free" && !end.serverSick;
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
    await Promise.allSettled(stopping.map(entry => this.#stop(entry)));
  }

  async stopAll(): Promise<void> {
    const all = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.allSettled(all.map(entry => this.#stop(entry)));
  }

  async #stop(entry: PoolEntry): Promise<void> {
    this.log(`server ${entry.id} stopping`);
    const server = entry.server ?? await entry.ready.catch(() => null);
    await server?.stop();
  }
}

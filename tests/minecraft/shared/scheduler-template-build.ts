// The daemon builds a missing template while nothing else runs (spec 2026-10-30-scenario-clients-ext4 D11, plan P3b): when a build starts, what it holds back, what it costs the ledger, how it fails.
import { basename } from "node:path";
import { marginRefusalDetail, roomAfterAdmissionMb } from "./admission.ts";
import type { ScenarioServerConfig } from "./config.ts";
import type { PortPairs } from "./port-block.ts";
import { findJavaPid, procFs, type PidFile } from "./server-pids.ts";
import { BUILD_SERVER_HEAP_MB, buildTemplate, realTemplatePorts, type BuildOptions, type BuildResult, type TemplatePorts, type TemplateServer } from "./world-template.ts";
import { pruneTemplates } from "./world-template-prune.ts";
import type { LaneWorldTemplates, TemplateBuildStatus } from "./world-template-use.ts";

/**
 * Tries of one key's build per daemon life: the first and 2 more after a cut. The build takes 55.7 s on a quiet machine against a 180 s bound (P3b smoke),
 * so a cut means a machine over 3 times slower: one retry after the load goes is worth it, an endless one costs ~3 GB and a CPU every ~185 s.
 */
export const TEMPLATE_BUILD_TRIES = 3;

type CutKind = "bound" | "no-port";

export interface TemplateBuildDeps {
  readonly config: ScenarioServerConfig;
  readonly log: (line: string) => void;
  /** A monotonic millisecond clock. */
  readonly now: () => number;
  /** Which versions have a key and whether their template is on disk. */
  readonly templates: Pick<LaneWorldTemplates, "buildStatus">;
  /** The daemon's port pairs: the build server takes one like any server the daemon starts. */
  readonly ports: Pick<PortPairs, "lease" | "release">;
  /** The daemon's pid file: a build server killed with its daemon is found by the next start. */
  readonly pidFile: Pick<PidFile, "add" | "remove">;
  /** The java process running in a server root, or null. */
  readonly findJavaPid: (root: string) => number | null;
  /** The ports of a build server that asks for `preferPort`. */
  readonly templatePorts: (preferPort: number) => TemplatePorts;
  readonly build: (options: BuildOptions, ports: TemplatePorts) => Promise<BuildResult>;
}

/** What a sample tells the build: whether nothing runs, queues or is being submitted (asked again after the build's own waits), and what the memory ledger has left. */
export interface BuildMoment {
  readonly idle: () => boolean;
  readonly ledgerMb: number;
}

interface ActiveBuild {
  readonly version: string;
  readonly key: string;
  readonly startedAt: number;
  /** The build server's java pid once it runs and was found; null before and when no process was found. */
  pid: number | null;
  /** Its resident size at the last sample (0 before the first reading). */
  residentMb: number;
  /** Stops the build server (once, whoever asks first); null while none runs. */
  stopServer: (() => Promise<void>) | null;
  finished: Promise<void>;
}

/**
 * At most one build at a time, started only at an idle moment of the daemon (a build beside trials would generate its chunks during the very overload
 * it removes, spec D11). While it runs the scheduler holds every trial (`waitLine`) and the memory ledger counts its server (`ledgerReading`).
 */
export class TemplateBuilds {
  #active: ActiveBuild | null = null;
  /** Keys not tried again in this daemon's life: a build that failed for its own reason, or one cut `TEMPLATE_BUILD_TRIES` times. */
  readonly #failed = new Set<string>();
  /** The cuts so far per key, one entry per try: builds cut by their bound and starts that found no port pair. */
  readonly #cuts = new Map<string, CutKind[]>();
  readonly #endListeners: (() => void)[] = [];
  #stopping = false;
  #pruned = false;
  #saidNoRoom = false;

  constructor(private readonly options: TemplateBuildDeps) {}

  /** The build that runs now, or null. */
  get active(): { readonly version: string; readonly key: string } | null {
    return this.#active;
  }

  /** Why trials wait, or null when no build runs. */
  waitLine(): string | null {
    const active = this.#active;
    if (!active) return null;
    const seconds = Math.round((this.options.now() - active.startedAt) / 1000);
    return `world template build of ${active.version} is running (${seconds} s so far); a trial starts when it ends`;
  }

  /** The build's server for the memory ledger (admission's `templateBuild`), or undefined when no build runs. */
  ledgerReading(): { readonly heapMb: number; readonly residentMb: number } | undefined {
    return this.#active ? { heapMb: BUILD_SERVER_HEAP_MB, residentMb: this.#active.residentMb } : undefined;
  }

  /** Reads the build server's resident size from its java pid; call before each scheduler sample. */
  async sampleResident(residentMbOf: (pid: number) => Promise<number>): Promise<void> {
    const active = this.#active;
    if (!active || active.pid === null) return;
    active.residentMb = await residentMbOf(active.pid).catch(() => 0);
  }

  /** `listener` runs each time a build ends, whatever its result: the trials it held may start. */
  onEnd(listener: () => void): void {
    this.#endListeners.push(listener);
  }

  /** Daemon start: removes the build leftovers of dead processes. The unused old templates wait for a known key (`startIfDue`). */
  pruneLeftovers(): void {
    this.#prune(new Set(), true);
  }

  /** At a sample: starts the next missing template's build when the daemon is idle and the ledger covers the build server. Resolves when the decision is made, not when the build ends. */
  async startIfDue(moment: BuildMoment): Promise<void> {
    if (this.#active || this.#stopping || !moment.idle()) return;
    const statuses = await this.options.templates.buildStatus();
    // The status came after a wait: a submission, a stop or another call may have come meanwhile.
    if (this.#active || this.#stopping || !moment.idle()) return;
    if (!this.#pruned && statuses.length > 0) {
      this.#pruned = true;
      this.#prune(new Set(statuses.map(status => status.key)), false);
    }
    const job = statuses.find(status => !status.present && !this.#failed.has(status.key));
    if (!job) return;
    if (roomAfterAdmissionMb(moment.ledgerMb, BUILD_SERVER_HEAP_MB, this.options.config) < 0) {
      this.#sayNoRoomOnce(moment.ledgerMb);
      return;
    }
    this.#saidNoRoom = false;
    this.#begin(job);
  }

  /** Daemon stop: the build server stops, the build ends (it cleans its temporary directories), and no build starts afterwards. */
  async stop(): Promise<void> {
    this.#stopping = true;
    const active = this.#active;
    if (!active) return;
    await active.stopServer?.().catch(() => undefined);
    await active.finished;
  }

  #sayNoRoomOnce(ledgerMb: number): void {
    if (this.#saidNoRoom) return;
    this.#saidNoRoom = true;
    this.options.log(`world template build waits: ${marginRefusalDetail(ledgerMb, BUILD_SERVER_HEAP_MB, "the build server", this.options.config)}`);
  }

  #prune(currentKeys: ReadonlySet<string>, tmpsOnly: boolean): void {
    try {
      const removed = pruneTemplates(this.options.config.templateDir, currentKeys, { tmpsOnly });
      if (removed.length) this.options.log(`world template prune: removed ${removed.join(", ")}`);
    } catch (error) {
      this.options.log(`world template prune failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #begin(job: TemplateBuildStatus): void {
    const active: ActiveBuild = { version: job.version, key: job.key, startedAt: this.options.now(), pid: null, residentMb: 0, stopServer: null, finished: Promise.resolve() };
    this.#active = active;
    active.finished = this.#run(job, active).catch(error => this.options.log(`world template build bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  async #run(job: TemplateBuildStatus, active: ActiveBuild): Promise<void> {
    const { config, log, ports } = this.options;
    let port: number;
    try {
      port = ports.lease();
    } catch (error) {
      this.#endNotStarted(job, error instanceof Error ? error.message : String(error));
      return;
    }
    log(`world template ${job.key}: building ${job.version} (nothing runs or waits, the memory ledger has room)`);
    let result: BuildResult;
    try {
      const buildOptions = { cacheDir: config.templateDir, version: job.version, boxes: job.boxes, boundMs: config.templateBuildBoundMs, log };
      result = await this.options.build(buildOptions, this.#registeringPorts(this.options.templatePorts(port), active));
    } catch (error) {
      result = { ok: false, reason: error instanceof Error ? error.message : String(error), bound: false };
    } finally {
      ports.release(port);
    }
    this.#end(job, result);
  }

  /** The build's ports, with its server registered like any server the daemon starts (pid file, port pair) and stoppable by the daemon's stop. */
  #registeringPorts(base: TemplatePorts, active: ActiveBuild): TemplatePorts {
    return {
      ...base,
      startServer: async (version, root, properties) => {
        if (this.#stopping) throw new Error("the daemon is stopping, no build server starts");
        const server = await base.startServer(version, root, properties);
        if (this.#stopping) {
          await server.stop().catch(() => undefined);
          throw new Error("the daemon is stopping, the build server was stopped");
        }
        return this.#registered(server, this.options.findJavaPid(root), root, active);
      },
    };
  }

  async #registered(server: TemplateServer, pid: number | null, root: string, active: ActiveBuild): Promise<TemplateServer> {
    try {
      if (pid !== null) await this.options.pidFile.add({ pid, root });
    } catch (error) {
      // The build never gets this server to stop: one that runs outside the pid file would outlive a killed daemon.
      await server.stop().catch(() => undefined);
      throw error;
    }
    active.pid = pid;
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => stopping ??= (async () => {
      try {
        await server.stop();
      } finally {
        if (pid !== null) await this.options.pidFile.remove(pid);
        active.pid = null;
        active.residentMb = 0;
        active.stopServer = null;
      }
    })();
    active.stopServer = stop;
    return { rcon: command => server.rcon(command), waitForLog: (text, boundMs) => server.waitForLog(text, boundMs), stop };
  }

  /** Counts a cut as one of the key's tries and logs it; the last try's cut is remembered like a failure. The count in the line is of one kind only when every try was of that kind. */
  #recordCut(job: TemplateBuildStatus, reason: string, kind: CutKind): void {
    const cuts = [...(this.#cuts.get(job.key) ?? []), kind];
    this.#cuts.set(job.key, cuts);
    const last = cuts.length >= TEMPLATE_BUILD_TRIES;
    if (last) this.#failed.add(job.key);
    const what = kind === "bound" ? "build cut by its bound" : "build not started";
    const count = !last ? "" : cuts.every(cut => cut === kind) ? ` ${cuts.length} times` : `, ${cuts.length} tries used (bound cuts and starts without a port pair)`;
    this.options.log(`world template ${job.key} ${what}${count}: ${reason} (${last ? "not tried again until the daemon restarts" : "tried again at the next idle sample"})`);
  }

  /** A build that could not start for want of a port pair: nothing ran, so the trials it would have held start now. */
  #endNotStarted(job: TemplateBuildStatus, reason: string): void {
    this.#recordCut(job, reason, "no-port");
    this.#finish();
  }

  #end(job: TemplateBuildStatus, built: BuildResult): void {
    const { log } = this.options;
    // The daemon finds a template by the key it computed from its own first server: a build stored under another key would be built again and again.
    const result = built.ok && basename(built.dir) !== job.key
      ? { ok: false as const, reason: `built under key ${basename(built.dir)}, the daemon computed ${job.key}`, bound: false }
      : built;
    if (result.ok) log(`world template ${job.key} ready: servers started from now on get it`);
    else if (result.bound) this.#recordCut(job, result.reason, "bound");
    else {
      this.#failed.add(job.key);
      log(`world template ${job.key} build failed: ${result.reason} (not tried again until the daemon restarts)`);
    }
    this.#finish();
  }

  #finish(): void {
    this.#active = null;
    for (const listener of this.#endListeners) {
      try {
        listener();
      } catch (error) {
        this.options.log(`world template build end listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/** The daemon's builds over the real build, `findJavaPid` and Mine Labs servers; the build server's own log lines go to the daemon log under `[template-build]`. */
export function createDaemonTemplateBuilds(options: {
  readonly config: ScenarioServerConfig;
  readonly log: (line: string) => void;
  readonly templates: LaneWorldTemplates;
  readonly ports: PortPairs;
  readonly pidFile: PidFile;
}): TemplateBuilds {
  const { log } = options;
  return new TemplateBuilds({
    ...options, now: () => performance.now(), findJavaPid: root => findJavaPid(root, procFs), build: buildTemplate,
    templatePorts: preferPort => realTemplatePorts({ preferPort, log: line => log(`[template-build] ${line}`) }),
  });
}

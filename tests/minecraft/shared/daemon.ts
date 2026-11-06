// The scenario daemon: listens on a unix socket, owns the server pool and the scheduler, samples the machine, exits when idle.
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Scenario } from "mine-labs";
import { ClientsAhead } from "./client-ahead.ts";
import { loadScenarioServerConfig, portBlockOf, type PortBlock, type ScenarioServerConfig } from "./config.ts";
import { sampleLine } from "./daemon-lines.ts";
import { serveSocket } from "./daemon-socket.ts";
import { GameruleDefaultsCache } from "./gamerule-defaults.ts";
import { LabsServerFactory } from "./labs-server.ts";
import { runLabsTrial } from "./labs-trial.ts";
import { putLshwStubOnPath } from "./lshw-stub.ts";
import { MachineProbe, residentMbOfPid } from "./machine-load.ts";
import { realMirrorPorts, ScenarioMirror, type MirrorPorts } from "./mirror.ts";
import { ModulesTrees, pruneModules } from "./mirror-modules.ts";
import { PortPairs } from "./port-block.ts";
import { ServerPool, type ServerFactory } from "./pool.ts";
import type { RunIo } from "./run-io.ts";
import { sampleOnce, type SamplerDeps } from "./sampler.ts";
import { Scheduler } from "./scheduler.ts";
import { createDaemonTemplateBuilds, type TemplateBuilds } from "./scheduler-template-build.ts";
import type { ScenarioServer } from "./scenario-server.ts";
import { PidFile, killLeftoverServers, procFs } from "./server-pids.ts";
import { installShutdownSignals } from "./shutdown-signals.ts";
import { rootSlug } from "./source-root.ts";
import { handleSubmit, type RunningSubmission } from "./submission-handler.ts";
import type { TrialRunner } from "./trial.ts";
import { LaneWorldTemplates } from "./world-template-use.ts";

export interface DaemonOptions {
  readonly socketPath: string;
  readonly config: ScenarioServerConfig;
  /** Servers' worlds, the pid file; `.tmp/scenario-server` of the checkout that started the daemon. */
  readonly stateDir: string;
  readonly portBlock: PortBlock;
  readonly log: (message: string) => void;
  readonly factory?: ServerFactory;
  readonly runTrial?: TrialRunner;
  readonly machine?: SamplerDeps["machine"];
  readonly residentMbOf?: SamplerDeps["residentMbOf"];
  readonly runIo?: RunIo;
  /** Boots the scenario clients ahead of their trials; by default only with the real trial runner (a test's runner never takes one). */
  readonly clientsAhead?: ClientsAhead;
  /** Starts each submission's clients from a snapshot of its worktree on ext4; by default only with the real trial runner (a test's runner runs no client, so it syncs nothing). */
  readonly mirror?: DaemonMirror;
  /** Builds a missing template world while nothing runs; by default only with the real server factory and `WORLD_TEMPLATE=1` (a test's fake factory starts no flat server to learn the key from). */
  readonly templateBuilds?: TemplateBuilds;
}

/** What the daemon asks of the scenario mirror: snapshots for its submissions, a prune at its start and end, and the end of the installs it started. */
export interface DaemonMirror extends Pick<ScenarioMirror, "acquire" | "prune"> {
  /** Resolves when no `node_modules` install of this daemon runs. */
  settled(): Promise<void>;
}

/** A tree of `node_modules` nobody linked and nobody used for this long is deleted (spec D4). */
const MODULES_UNUSED_MAX_AGE_MS = 7 * 86_400_000;

/**
 * The daemon's mirror: one `ModulesTrees` for the whole process (two in one process would share `<hash>.tmp-<pid>`), its snapshots under a directory
 * named by the socket, with the daemon's pid in it: a worker's daemon (`--socket`) prunes another's directory only once that pid is dead. `ports` replaces the real `run`, `mounts` and `now` (tests).
 */
export function createDaemonMirror(options: { readonly config: ScenarioServerConfig; readonly socketPath: string; readonly log: (message: string) => void; readonly ports?: Partial<Pick<MirrorPorts, "run" | "mounts" | "now">>; readonly slowSyncNoticeMs?: number }): DaemonMirror {
  const { config, log } = options;
  const trees = new ModulesTrees({ mirrorDir: config.mirrorDir, boundMs: config.modulesInstallBoundMs, log });
  const mirror = new ScenarioMirror(
    { mirrorDir: config.mirrorDir, daemonSlug: rootSlug(options.socketPath), enabled: config.mirror === 1, syncBoundMs: config.mirrorSyncBoundMs, slowSyncNoticeMs: options.slowSyncNoticeMs, log },
    {
      ...realMirrorPorts, ...options.ports,
      modulesFor: root => trees.modulesFor(root),
      pruneModules: linked => pruneModules(config.mirrorDir, linked, MODULES_UNUSED_MAX_AGE_MS),
    },
  );
  return { acquire: (cwd, signal, notify) => mirror.acquire(cwd, signal, notify), prune: () => mirror.prune(), settled: () => trees.settled() };
}

/** Before the daemon exits: a `node_modules` install in progress ends first (its bound is a few seconds), so the next daemon finds the tree; a failing prune is logged, never held against the stop. */
async function settleAndPruneMirror(mirror: DaemonMirror, log: (message: string) => void): Promise<void> {
  try {
    await mirror.settled();
    await mirror.prune();
  } catch (error) {
    log(`mirror prune at stop failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface Daemon {
  /** Resolves when the daemon has stopped every server and closed the socket. */
  readonly stopped: Promise<void>;
  stop(): Promise<void>;
}

const SHUTDOWN_DRAIN_POLL_MS = 50;

/** The pristine server a version's gamerule defaults are read from: one per version, replaced if it left the pool. */
function probeServers(pool: ServerPool, config: ScenarioServerConfig, now: () => number) {
  const probes = new Map<string, { readonly id: string; readonly ready: Promise<ScenarioServer> }>();
  return (version: string, example: Scenario): Promise<ScenarioServer> => {
    const known = probes.get(version);
    if (known && pool.get(known.id)) return known.ready;
    const managed = pool.startServer({ kind: "shared", key: `probe:${version}`, heapMb: config.sharedHeapMb, setup: [], scenario: example }, now());
    probes.set(version, { id: managed.id, ready: managed.ready });
    return managed.ready;
  };
}

/** The daemon's server factory and template builds (the real ones unless a test gave its own), after killing the java servers a dead daemon left. */
async function serverParts(options: DaemonOptions): Promise<{ readonly factory: ServerFactory; readonly templateBuilds: TemplateBuilds | undefined }> {
  const { config, log, socketPath } = options;
  // Before any server starts: the server JVMs of the lanes and of the template builds inherit this process's PATH.
  await putLshwStubOnPath(log);
  const serverRoot = join(options.stateDir, "servers");
  // Next to the socket, not in the checkout: a daemon started from another worktree still finds what a dead one left.
  const pidFile = new PidFile(`${socketPath}.pids`);
  await mkdir(serverRoot, { recursive: true });
  const leftovers = await killLeftoverServers(pidFile, procFs, pid => process.kill(pid, "SIGKILL"));
  if (leftovers.killed.length) log(`killed java servers left by a daemon that died: ${leftovers.killed.join(", ")}`);
  const ports = new PortPairs(options.portBlock);
  const templates = new LaneWorldTemplates({ config, log });
  const factory = options.factory ?? new LabsServerFactory({ serverRoot, ports, pidFile, config, log, templates });
  const templateBuilds = options.templateBuilds ?? (options.factory || config.worldTemplate !== 1 ? undefined : createDaemonTemplateBuilds({ config, log, templates, ports, pidFile }));
  templateBuilds?.pruneLeftovers();
  return { factory, templateBuilds };
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { config, log, socketPath } = options;
  const now = Date.now;
  const { factory, templateBuilds } = await serverParts(options);
  const pool = new ServerPool(factory, config, log);
  const clientsAhead = options.clientsAhead ?? (options.runTrial ? undefined : new ClientsAhead({ config, log, now }));
  const scheduler = new Scheduler({ pool, config, now, log, runTrial: options.runTrial ?? runLabsTrial, runIo: options.runIo, clientsAhead, templateBuilds });
  const mirror = options.mirror ?? (options.runTrial ? undefined : createDaemonMirror({ config, socketPath, log }));
  // Not awaited by the listen: a first prune over a large mirror must not delay the first submit.
  if (mirror) void mirror.prune().catch((error: unknown) => log(`mirror prune failed: ${error instanceof Error ? error.message : String(error)}`));
  const defaults = new GameruleDefaultsCache(probeServers(pool, config, now));
  const submissions = new Set<RunningSubmission>();
  const stopped = Promise.withResolvers<void>();
  let lastActivityAt = now();
  let stopRequested = false;
  let stopping: Promise<void> | undefined;
  let sampling = false;
  /** No trial runs, none is queued and no submission is being prepared: the moment a template build may start. */
  const trialsIdle = (): boolean => scheduler.runningCount === 0 && scheduler.queuedCount === 0 && submissions.size === 0;
  /** A running build keeps the daemon alive: its server and its chunks are minutes of work nobody asked to lose. */
  const idle = (): boolean => trialsIdle() && !templateBuilds?.active;
  const samplerDeps: SamplerDeps = {
    pool, scheduler, config, now, log, machine: options.machine ?? new MachineProbe(), residentMbOf: options.residentMbOf ?? residentMbOfPid,
  };

  const sample = async (): Promise<void> => {
    if (sampling) return;
    sampling = true;
    try {
      await templateBuilds?.sampleResident(samplerDeps.residentMbOf);
      await sampleOnce(samplerDeps);
      const report = scheduler.sampleReport();
      if (report) log(sampleLine(report));
      if (report) await templateBuilds?.startIfDue({ idle: trialsIdle, ledgerMb: report.ledgerMb });
    } catch (error) {
      log(`sample failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      sampling = false;
    }
    if (!idle()) lastActivityAt = now();
    else if (stopRequested || now() - lastActivityAt >= config.daemonIdleMs) void stop();
  };

  const socket = await serveSocket(socketPath, {
    submit: (message, send) => {
      const running = handleSubmit({ scheduler, defaults, config, send, mirror }, message);
      submissions.add(running);
      void running.finished.finally(() => submissions.delete(running));
      return running;
    },
    status: () => `${scheduler.runningCount} running, ${scheduler.queuedCount} queued, servers: ${pool.readings().map(reading => `${reading.id}:${reading.status}`).join(" ") || "none"}`,
    // A build is up to 180 s of work nobody waits for: a stop request ends it now, and no other starts.
    requestStop: () => { stopRequested = true; void templateBuilds?.stop(); },
    isStopping: () => stopRequested || stopping !== undefined,
    touch: () => { lastActivityAt = now(); },
  });
  const timer = setInterval(() => { void sample(); }, config.sampleEveryMs);
  void sample();
  log(`daemon listening on ${socketPath}, ports ${options.portBlock.first}-${options.portBlock.last}`);

  const stop = (): Promise<void> => stopping ??= (async () => {
    clearInterval(timer);
    scheduler.cancelAll("daemon stopping");
    const drainUntil = now() + 2 * config.restoreBoundMs + 1_000;
    while (scheduler.runningCount > 0 && now() < drainUntil) await new Promise(done => setTimeout(done, SHUTDOWN_DRAIN_POLL_MS));
    await templateBuilds?.stop();
    await pool.stopAll();
    if (mirror) await settleAndPruneMirror(mirror, log);
    await socket.close();
    log("daemon stopped");
    stopped.resolve();
  })();
  return { stopped: stopped.promise, stop };
}

/** `bun daemon.ts [--socket <path>] [--port <base>]`, started by `submit`. */
async function runDaemonCli(args: readonly string[]): Promise<void> {
  const option = (name: string): string | undefined => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const config = loadScenarioServerConfig({ ...process.env, ...(option("--socket") ? { MINE_AI_SCENARIO_SOCKET_PATH: option("--socket") } : {}) });
  const base = option("--port");
  const daemon = await startDaemon({
    socketPath: config.socketPath, config, stateDir: resolve(".tmp/scenario-server"), portBlock: portBlockOf(base === undefined ? undefined : Number(base)),
    log: message => console.log(`${new Date().toISOString()} ${message}`),
  });
  installShutdownSignals(async () => { await daemon.stop(); });
  await daemon.stopped;
  process.exit(0);
}

if (import.meta.main) await runDaemonCli(process.argv.slice(2));

// The scenario daemon: listens on a unix socket, owns the server pool and the scheduler, samples the machine, exits when idle.
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Scenario } from "mine-labs";
import { loadScenarioServerConfig, portBlockOf, type PortBlock, type ScenarioServerConfig } from "./config.ts";
import { sampleLine } from "./daemon-lines.ts";
import { serveSocket } from "./daemon-socket.ts";
import { GameruleDefaultsCache } from "./gamerule-defaults.ts";
import { LabsServerFactory } from "./labs-server.ts";
import { runLabsTrial } from "./labs-trial.ts";
import { MachineProbe, residentMbOfPid } from "./machine-load.ts";
import { PortPairs } from "./port-block.ts";
import { ServerPool, type ServerFactory } from "./pool.ts";
import type { RunIo } from "./run-io.ts";
import { sampleOnce, type SamplerDeps } from "./sampler.ts";
import { Scheduler } from "./scheduler.ts";
import type { ScenarioServer } from "./scenario-server.ts";
import { PidFile, killLeftoverServers, procFs } from "./server-pids.ts";
import { installShutdownSignals } from "./shutdown-signals.ts";
import { handleSubmit, type RunningSubmission } from "./submission-handler.ts";
import type { TrialRunner } from "./trial.ts";

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

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { config, log, socketPath } = options;
  const now = Date.now;
  const serverRoot = join(options.stateDir, "servers");
  // Next to the socket, not in the checkout: a daemon started from another worktree still finds what a dead one left.
  const pidFile = new PidFile(`${socketPath}.pids`);
  await mkdir(serverRoot, { recursive: true });
  const leftovers = await killLeftoverServers(pidFile, procFs, pid => process.kill(pid, "SIGKILL"));
  if (leftovers.killed.length) log(`killed java servers left by a daemon that died: ${leftovers.killed.join(", ")}`);

  const factory = options.factory ?? new LabsServerFactory({ serverRoot, ports: new PortPairs(options.portBlock), pidFile, config, log });
  const pool = new ServerPool(factory, config, log);
  const scheduler = new Scheduler({ pool, config, now, log, runTrial: options.runTrial ?? runLabsTrial, runIo: options.runIo });
  const defaults = new GameruleDefaultsCache(probeServers(pool, config, now));
  const submissions = new Set<RunningSubmission>();
  const stopped = Promise.withResolvers<void>();
  let lastActivityAt = now();
  let stopRequested = false;
  let stopping: Promise<void> | undefined;
  let sampling = false;
  const idle = (): boolean => scheduler.runningCount === 0 && scheduler.queuedCount === 0 && submissions.size === 0;
  const samplerDeps: SamplerDeps = {
    pool, scheduler, config, now, log, machine: options.machine ?? new MachineProbe(), residentMbOf: options.residentMbOf ?? residentMbOfPid,
  };

  const sample = async (): Promise<void> => {
    if (sampling) return;
    sampling = true;
    try {
      await sampleOnce(samplerDeps);
      const report = scheduler.sampleReport();
      if (report) log(sampleLine(report, pool.readings().map(reading => reading.msptP95)));
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
      const running = handleSubmit({ scheduler, defaults, config, send }, message);
      submissions.add(running);
      void running.finished.finally(() => submissions.delete(running));
      return running;
    },
    status: () => `${scheduler.runningCount} running, ${scheduler.queuedCount} queued, servers: ${pool.readings().map(reading => `${reading.id}:${reading.status}`).join(" ") || "none"}`,
    requestStop: () => { stopRequested = true; },
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
    await pool.stopAll();
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

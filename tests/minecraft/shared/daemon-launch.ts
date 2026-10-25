// Starting the daemon from `submit`: one daemon per socket, enforced by a non-blocking flock held for the daemon's life.
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { loadScenarioServerConfig } from "./config.ts";
import { daemonListens } from "./daemon-client.ts";
import { forwardedEnv } from "./submit-args.ts";

const DEFAULT_LOCK = "/tmp/mine-ai-scenario-server.lock";
const START_TIMEOUT_MS = 60_000;
const START_POLL_MS = 200;

export function daemonLockPath(socketPath: string): string {
  return socketPath === loadScenarioServerConfig({}).socketPath ? DEFAULT_LOCK : `${socketPath}.lock`;
}

/** `flock -n <lock> bun daemon.ts ...`: a second start finds the lock taken and exits at once. */
export function daemonCommand(daemonFile: string, socketPath: string | undefined, port: number | undefined, bun: string): string[] {
  const lock = daemonLockPath(socketPath ?? loadScenarioServerConfig({}).socketPath);
  return ["flock", "-n", lock, bun, daemonFile, ...(socketPath ? ["--socket", socketPath] : []), ...(port !== undefined ? ["--port", String(port)] : [])];
}

/** The daemon's environment: the submitter's, minus the variables meant for its own clients (each submission brings those itself). */
export function daemonEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const clientOnly = new Set(Object.keys(forwardedEnv(env)));
  return Object.fromEntries(Object.entries(env).filter(([name]) => !clientOnly.has(name)));
}

/** Connects to the daemon on `socketPath`, starting one (detached, logging to `<repo>/.tmp/scenario-server/daemon.log`) when none listens. */
export async function ensureDaemon(options: { readonly socketPath: string; readonly port: number | undefined; readonly daemonFile: string; readonly repoRoot: string }): Promise<void> {
  if (await daemonListens(options.socketPath)) return;
  const logDir = join(options.repoRoot, ".tmp", "scenario-server");
  mkdirSync(logDir, { recursive: true });
  const log = openSync(join(logDir, "daemon.log"), "a");
  const [program, ...args] = daemonCommand(options.daemonFile, options.socketPath, options.port, process.execPath);
  spawn(program!, args, { cwd: options.repoRoot, env: daemonEnv(process.env), detached: true, stdio: ["ignore", log, log] }).unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await daemonListens(options.socketPath)) return;
    await new Promise(resolve => setTimeout(resolve, START_POLL_MS));
  }
  throw new Error(`no daemon listens on ${options.socketPath} ${START_TIMEOUT_MS / 1000}s after it was started; see ${join(logDir, "daemon.log")}`);
}

// `bun submit.ts <yaml|dir>... [--repeat N] [--lanes N] [--lock] [--hold] [--isolated] [--out DIR] | --stop`: run scenarios on the shared server.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenarioServerConfig } from "./config.ts";
import { exchange } from "./daemon-client.ts";
import { ensureDaemon } from "./daemon-launch.ts";
import type { DaemonMessage } from "./protocol.ts";
import { formatMessage, forwardedEnv, parseSubmitArgs, type SubmitArgs } from "./submit-args.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const EXIT_INTERRUPTED = 130;

function print(message: DaemonMessage): void {
  for (const line of formatMessage(message)) console.log(line);
}

/** Today's path, `mine-labs run` with its own servers: the comparison and the fallback. */
function runIsolated(args: SubmitArgs): Promise<number> {
  const command = ["bunx", "--bun", "mine-labs", "run", ...args.paths, "--jobs", "2", "--repeat", String(args.repeat), "-o", args.out];
  return new Promise(done => spawn(command[0]!, command.slice(1), { stdio: "inherit", cwd: REPO_ROOT }).once("exit", code => done(code ?? 1)));
}

async function runOnDaemon(args: SubmitArgs): Promise<number> {
  const socketPath = args.socket ?? loadScenarioServerConfig().socketPath;
  await ensureDaemon({ socketPath, port: args.port, daemonFile: resolve(HERE, "daemon.ts"), repoRoot: REPO_ROOT });
  let exitCode = 1;
  const session = await exchange(socketPath, {
    type: "submit", paths: args.paths, out: args.out, repeat: args.repeat, lanes: args.lanes, lock: args.lock, hold: args.hold, env: forwardedEnv(process.env),
  }, message => {
    print(message);
    if (message.type === "done") exitCode = message.failed > 0 || message.cancelled > 0 ? 1 : 0;
  });
  let interrupted = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { interrupted = true; session.close(); });
  await session.closed;
  return interrupted ? EXIT_INTERRUPTED : exitCode;
}

async function stopDaemon(args: SubmitArgs): Promise<number> {
  const socketPath = args.socket ?? loadScenarioServerConfig().socketPath;
  try {
    const session = await exchange(socketPath, { type: "stop" }, print);
    await session.closed;
    return 0;
  } catch {
    console.log(`no daemon listens on ${socketPath}`);
    return 0;
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseSubmitArgs(argv, process.cwd());
  if (args.stop) return stopDaemon(args);
  if (args.isolated) return runIsolated(args);
  return runOnDaemon(args);
}

process.exit(await main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); return 2; }));

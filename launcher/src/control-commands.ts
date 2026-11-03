// `mine-ai stop | status | bot start|stop <id>`: the command-line side of the launcher's control endpoint.
import { UsageError, type CliContext } from "./cli-context.ts";
import { monotonicNow } from "./clocks.ts";
import { CONTROL_HEADER, findRunningLauncher, realLockDeps, type LauncherLock } from "./control.ts";
import { cleanupStale, type StaleReport } from "./processes.ts";
import type { StackStatus } from "./stack.ts";

/** A stop saves the world and unloads the model; the manifest's `serverStopMs` is inside this. */
const STOP_WAIT_MS = 180_000;
const POLL_MS = 500;
const PORT_WAIT_MS = 10_000;
const SHORT_REQUEST_TIMEOUT_MS = 5_000;
const NOT_RUNNING = "Mine AI is not running.";
/**
 * `stop` ends with this when a launcher is alive but will not stop (still starting, silent, or not finished in time). The installer
 * (`STOP_REFUSED_EXIT_CODE` in mine-ai.iss) cancels an update or skips the uninstaller's removals only on this code: exit 1 is also
 * what `runCli` gives a `stop` that throws and what Bun gives a bundle that fails to load, and those must not block a repairing update.
 */
export const STOP_REFUSED_EXIT_CODE = 3;

export interface ControlCommandDeps {
  findRunningLauncher(): Promise<LauncherLock | null>;
  cleanupStale(root: string): Promise<StaleReport>;
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export function realControlCommandDeps(root: string): ControlCommandDeps {
  return {
    findRunningLauncher: () => findRunningLauncher(root, realLockDeps),
    cleanupStale: (staleRoot) => cleanupStale(staleRoot),
    fetch,
    now: monotonicNow,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

const controlUrl = (launcher: LauncherLock, path: string): string => `http://127.0.0.1:${launcher.controlPort}${path}`;

/** A bot start waits for its host's health (the manifest allows it `hostHealthMs`), so only the short requests have a timeout. */
async function post(launcher: LauncherLock, path: string, deps: ControlCommandDeps, timeoutMs?: number): Promise<{ ok: boolean; message: string }> {
  const response = await deps.fetch(controlUrl(launcher, path), { method: "POST", headers: { [CONTROL_HEADER]: "1" }, ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}) });
  return (await response.json()) as { ok: boolean; message: string };
}

const STARTING = Symbol("starting");

/**
 * The live launcher once it has published its control port (a lock younger than that has none yet), null when none
 * runs, `STARTING` when the port is still missing after `PORT_WAIT_MS`.
 */
async function findLauncherWithPort(deps: ControlCommandDeps): Promise<LauncherLock | null | typeof STARTING> {
  const deadline = deps.now() + PORT_WAIT_MS;
  for (;;) {
    const launcher = await deps.findRunningLauncher();
    if (launcher === null || launcher.controlPort !== null) return launcher;
    if (deps.now() >= deadline) return STARTING;
    await deps.sleep(POLL_MS);
  }
}

const STILL_STARTING = "Mine AI is still starting; try again in a few seconds.";

/** Stops the running launcher and waits for it to finish; with none running, ends what a crashed one left (so an update can replace the files). */
export async function runStopCommand(context: CliContext, deps: ControlCommandDeps): Promise<number> {
  const launcher = await findLauncherWithPort(deps);
  if (launcher === STARTING) {
    context.out(STILL_STARTING);
    return STOP_REFUSED_EXIT_CODE;
  }
  if (launcher === null) {
    const report = await deps.cleanupStale(context.root);
    report.killed.forEach((record) => context.out(`Ended ${record.name} (pid ${record.pid}), left running by an earlier Mine AI.`));
    const silent = [...new Set(report.launcherStillRunning.map((record) => record.parentPid))];
    if (silent.length > 0) {
      const left = report.launcherStillRunning.map((record) => `${record.name} (pid ${record.pid})`).join(", ");
      context.out(`Mine AI's launcher (pid ${silent.join(", ")}) is still running but not answering, so it was left alone: ${left}. Wait a minute and run stop again; if it stays silent, end that process (pid ${silent.join(", ")}) in Task Manager, then run stop once more to end what it left.`);
      return STOP_REFUSED_EXIT_CODE;
    }
    context.out(NOT_RUNNING);
    return 0;
  }
  await post(launcher, "/stop", deps, SHORT_REQUEST_TIMEOUT_MS);
  const deadline = deps.now() + STOP_WAIT_MS;
  while (deps.now() < deadline) {
    if ((await deps.findRunningLauncher()) === null) {
      context.out("Mine AI stopped.");
      return 0;
    }
    await deps.sleep(POLL_MS);
  }
  context.out(`Mine AI did not finish stopping within ${STOP_WAIT_MS / 1_000} s. End the bun.exe and java.exe of Mine AI in Task Manager (ollama.exe and llama-server.exe too, unless you run Ollama yourself), then try again.`);
  return STOP_REFUSED_EXIT_CODE;
}

/** One screen: phase, model, where to join, each bot. Exit 1 when Mine AI is not running. */
export async function runStatusCommand(context: CliContext, deps: ControlCommandDeps): Promise<number> {
  const launcher = await findLauncherWithPort(deps);
  if (launcher === STARTING) {
    context.out(STILL_STARTING);
    return 1;
  }
  if (launcher === null) {
    context.out(NOT_RUNNING);
    return 1;
  }
  const status = (await (await deps.fetch(controlUrl(launcher, "/status"), { signal: AbortSignal.timeout(SHORT_REQUEST_TIMEOUT_MS) })).json()) as StackStatus;
  context.out(`Mine AI is ${status.phase}.`);
  if (status.problem) context.out(`Problem: ${status.problem}`);
  context.out(`Model: ${status.llm.model} (${status.llm.kind})`);
  context.out(`Server: ${status.join ?? "none set"}`);
  for (const bot of status.bots) context.out(`Bot ${bot.username} (${bot.id}): ${bot.status}, host port ${bot.hostPort}`);
  if (status.bots.length === 0) context.out("No bot is running.");
  return 0;
}

/** `bot start <id>` / `bot stop <id>`: the hook the in-game spawn commands will call. */
export async function runBotCommand(args: readonly string[], context: CliContext, deps: ControlCommandDeps): Promise<number> {
  const [action, id] = args;
  if ((action !== "start" && action !== "stop") || !id) throw new UsageError("bot needs start or stop and a persona id: mine-ai bot start <persona id>.");
  const launcher = await findLauncherWithPort(deps);
  if (launcher === STARTING) {
    context.out(STILL_STARTING);
    return 1;
  }
  if (launcher === null) {
    context.out(`${NOT_RUNNING} Open it first with \`mine-ai console\`.`);
    return 1;
  }
  const answer = await post(launcher, `/bots/${encodeURIComponent(id)}/${action}`, deps);
  context.out(answer.message);
  return answer.ok ? 0 : 1;
}

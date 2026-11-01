// `mine-ai start`: the background launcher. It owns the stack, serves the control endpoint, and stops the stack in
// order when the last console goes away, `stop` is asked, or the process is told to end (spec D3).
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CliContext } from "./cli-context.ts";
import { acquireLauncherLock, releaseLauncherLock, setLockControlPort, startControlServer, realLockDeps, type ControlHandlers, type ControlServer, type LockDeps } from "./control.ts";
import { attachKillOnClose } from "./job-object.ts";
import type { Manifest } from "./manifest.ts";
import { Children, cleanupStale, type StaleReport } from "./processes.ts";
import { loadSettings, type Settings } from "./settings.ts";
import { bringUpStack, createStack, describeStack, realStackDeps, startBot, stopBot, stopStack, type ChildRunner, type StackDeps, type StackState } from "./stack.ts";
import { checkUpdate, type AvailableUpdate } from "./update-check.ts";

/** After a start that failed, the launcher stays this long so a console opened a moment ago can still read why. */
const FAILED_START_LINGER_MS = 15_000;

/** How long a launcher started by a console waits for that console to attach (it attaches within a second of the lock appearing). */
const CONSOLE_ATTACH_GRACE_MS = 60_000;

export interface StartOptions {
  /** Started by `mine-ai console`: stop if no console ever attaches. */
  readonly expectConsole?: boolean;
}

export interface StartDeps {
  lock: LockDeps & { ownPid: number };
  cleanupStale(root: string): Promise<StaleReport>;
  /** Puts the launcher in the kill-on-close job object; the warning text when Windows refuses, else null. */
  guardChildren(): string | null;
  createChildren(root: string): ChildRunner;
  stackDeps(say: (line: string) => void, root: string): StackDeps;
  checkUpdate(manifest: Manifest, settings: Settings): Promise<AvailableUpdate | null>;
  sleep(ms: number): Promise<void>;
  /** Calls `handler` with the signal's name on SIGINT, SIGTERM, SIGBREAK or SIGHUP; returns the function that removes the listeners. */
  onSignal(handler: (signal: string) => void): () => void;
}

/** What the first stop line says for each signal. A signal not listed is named as it is. */
const SIGNAL_REASONS: Readonly<Record<string, string>> = {
  SIGINT: "Ctrl+C",
  SIGBREAK: "Ctrl+Break",
  // 2026-10-31: Windows sends CTRL_CLOSE_EVENT when the console window is closed; Node-style runtimes deliver it as SIGHUP (not measured on Bun: re-check H1f-b).
  SIGHUP: "its window was closed",
  SIGTERM: "asked to end",
};

export function realStartDeps(): StartDeps {
  return {
    lock: { ...realLockDeps, ownPid: process.pid },
    cleanupStale: (root) => cleanupStale(root),
    guardChildren: guardWithJobObject,
    createChildren: (root) => new Children(root),
    stackDeps: realStackDeps,
    checkUpdate: (manifest, settings) => checkUpdate(manifest.version, manifest.release.latestUrl, fetch, settings.checkUpdates),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onSignal: (handler) => {
      const signals = ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const;
      const listeners = signals.map((signal) => [signal, () => handler(signal)] as const);
      for (const [signal, listener] of listeners) process.on(signal, listener);
      return () => listeners.forEach(([signal, listener]) => process.off(signal, listener));
    },
  };
}

/** `attachKillOnClose` throws with the Win32 error when Windows refuses; the launcher goes on without the safety net and says so. */
export function guardWithJobObject(): string | null {
  try {
    attachKillOnClose();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

function launcherLog(root: string): (line: string) => void {
  const file = join(root, "logs", "launcher.log");
  mkdirSync(join(root, "logs"), { recursive: true });
  return (line) => appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
}

function describeLeftovers(report: StaleReport): string[] {
  return [
    ...report.killed.map((record) => `Ended ${record.name} (pid ${record.pid}), left running by an earlier Mine AI that did not close properly.`),
    ...report.failed.map(({ record, error }) => `Could not end ${record.name} (pid ${record.pid}): ${error}. End ${record.image}.exe in Task Manager.`),
  ];
}

function updateLine(update: AvailableUpdate): string {
  return `Mine AI ${update.latest} is available${update.url ? `: ${update.url}` : ""}. Run the new installer to update; your worlds, bots and settings are kept.`;
}

/** Runs the launcher until the stack has stopped. Exit code 0 after a normal stop, 1 when the stack could not start. */
export async function runStartCommand(context: CliContext, deps: StartDeps = realStartDeps(), options: StartOptions = {}): Promise<number> {
  const manifest = context.loadManifest();
  let settings: Settings;
  try {
    settings = loadSettings(context.root, manifest);
  } catch (error) {
    context.err((error as Error).message);
    return 1;
  }
  const lock = await acquireLauncherLock(context.root, deps.lock);
  if (lock.kind === "running") {
    context.out("Mine AI is already running. Open its console with `mine-ai console`, or stop it with `mine-ai stop`.");
    return 0;
  }
  try {
    return await runLauncher(context, manifest, settings, deps, options);
  } finally {
    releaseLauncherLock(context.root, deps.lock.ownPid);
  }
}

async function runLauncher(context: CliContext, manifest: Manifest, settings: Settings, deps: StartDeps, options: StartOptions): Promise<number> {
  const writeLog = launcherLog(context.root);
  let control: ControlServer | undefined;
  const say = (line: string): void => {
    writeLog(line);
    context.out(line);
    control?.publish(line);
  };
  // Only after the lock is ours: this ends every child a crashed launcher left, which would include a live launcher's.
  describeLeftovers(await deps.cleanupStale(context.root)).forEach(say);
  const warning = deps.guardChildren();
  if (warning) say(`Warning: ${warning}. If Mine AI is killed from Task Manager, its bots, server and Ollama are not ended with it: end them by hand.`);
  const stack = createStack(settings, manifest, deps.createChildren(context.root), context.root, deps.stackDeps(say, context.root));
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => (finish = resolve));
  let stopping: Promise<void> | null = null;
  const beginStop = (reason: string): void => void (stopping ??= stopStack(stack, reason).finally(finish));
  control = await startControlServer({ startPort: settings.controlPort, handlers: controlHandlers(stack, beginStop) });
  setLockControlPort(context.root, control.port);
  const removeSignalHandler = deps.onSignal((signal) => beginStop(SIGNAL_REASONS[signal] ?? signal));
  if (options.expectConsole) void stopIfNoConsoleAttaches(control, deps, say, beginStop);
  void startServices(stack, manifest, settings, deps, say, beginStop);
  await finished;
  removeSignalHandler();
  await control.close();
  return stack.problem === null ? 0 : 1;
}

/** A launcher the console started has no stop trigger until a console attaches: without one it would run headless for good. */
async function stopIfNoConsoleAttaches(control: ControlServer, deps: StartDeps, say: (line: string) => void, beginStop: BeginStop): Promise<void> {
  await deps.sleep(CONSOLE_ATTACH_GRACE_MS);
  if (control.hasConsoleAttached()) return;
  say("No console attached, so Mine AI stops. Open it again from the Start menu.");
  beginStop("no console attached");
}

/** Starts the one ordered stop (later calls change nothing); `reason` heads its first line in the log. */
type BeginStop = (reason: string) => void;

function controlHandlers(stack: StackState, beginStop: BeginStop): ControlHandlers {
  return {
    status: () => describeStack(stack),
    startBot: (id) => startBot(stack, id),
    stopBot: (id) => stopBot(stack, id),
    stop: async () => beginStop("mine-ai stop"),
    onLastStreamClosed: () => beginStop("the last Mine AI window was closed"),
  };
}

/** Brings the stack up, then looks for an update; a stack that failed lingers for a console, then stops. */
async function startServices(stack: StackState, manifest: Manifest, settings: Settings, deps: StartDeps, say: (line: string) => void, beginStop: BeginStop): Promise<void> {
  try {
    await bringUpStack(stack);
  } catch (error) {
    stack.problem = `Mine AI could not start: ${(error as Error).message}`;
    stack.phase = "failed";
    say(stack.problem);
  }
  if (stack.problem !== null) {
    await deps.sleep(FAILED_START_LINGER_MS);
    beginStop("the start failed");
    return;
  }
  const update = await deps.checkUpdate(manifest, settings);
  if (update) say(updateLine(update));
}

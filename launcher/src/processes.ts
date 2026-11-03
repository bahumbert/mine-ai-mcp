import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { monotonicNow } from "./clocks.ts";
import { listProcesses, normalizeImageName, type ProcessInfo, type ProcessLister } from "./process-list.ts";

/** What the launcher needs of a started process; `node:child_process`'s `ChildProcess` fits it, and tests supply their own. */
export interface SpawnedProcess {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}
export type SpawnProcess = (cmd: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;
export type KillPid = (pid: number) => void;

const defaultSpawn: SpawnProcess = (cmd, args, options) => nodeSpawn(cmd, [...args], options);

/** Ends a process by pid (TerminateProcess on Windows, which does not touch its children); one already gone is no error. */
export const killProcess: KillPid = (pid) => {
  try {
    process.kill(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};

export interface ChildrenDeps {
  readonly spawn?: SpawnProcess;
  /** Default `process.platform`. */
  readonly platform?: NodeJS.Platform | undefined;
}

export interface SpawnChildOptions {
  /** Added to this process's environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** Every stdout and stderr line is appended here with a timestamp. */
  readonly logFile: string;
  /** `"pipe"` keeps the child's stdin open (the Minecraft server's console); otherwise it is closed. */
  readonly stdin?: "pipe";
  readonly onLine?: (line: string, stream: "stdout" | "stderr") => void;
}

export interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Set when the process could not start (executable missing): there is then no exit code. */
  readonly error?: string;
}

export interface Child {
  readonly name: string;
  /** Undefined when the process could not start; `exited` then holds the error. */
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly exited: Promise<ChildExit>;
  isRunning(): boolean;
}

export interface StopOptions {
  /** The polite way out (the server's `stop` line, a `/stop` request); the child is killed if it does not end within `timeoutMs`. */
  readonly graceful?: () => Promise<void>;
  readonly timeoutMs: number;
}

/** How `stop` ended a child: it was not running, it exited before any kill (the graceful step worked: `ended` holds how it exited), or `kill()` was sent. */
export type StopResult = "not-running" | "killed" | { readonly ended: ChildExit };

/** What `children.json` holds for each child still running; `image` is a `normalizeImageName` key. */
export interface ChildRecord {
  readonly pid: number;
  /** The launcher's pid when it started the child. A pid and an image alone are reused after a reboot (a player's own `ollama.exe`); a child of a launcher that no longer exists is not. */
  readonly parentPid: number;
  readonly image: string;
  readonly name: string;
}

export const DEFAULT_STOP_TIMEOUT_MS = 10_000;
/** How long `stop` waits for the exit event after a kill. */
const KILL_EXIT_WAIT_MS = 5_000;
/** The image names `cleanupStale` and the runner cleanup know: the Ollama server and the runner it starts per model. */
const OLLAMA_IMAGE = "ollama";
const OLLAMA_RUNNER_IMAGE = "llama-server";
const TIMED_OUT = Symbol("timed out");

export const childrenFile = (root: string): string => join(root, "run", "children.json");

function writeRecords(root: string, records: readonly ChildRecord[]): void {
  const file = childrenFile(root);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(records));
  renameSync(temporary, file);
}

function readRecords(root: string): ChildRecord[] | null {
  const file = childrenFile(root);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ChildRecord => typeof entry?.pid === "number" && typeof entry.parentPid === "number" && typeof entry.image === "string" && typeof entry.name === "string");
  } catch {
    return [];
  }
}

/** `promise`'s value, or `TIMED_OUT` once `ms` passed; the timer never outlives the call. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), Math.max(ms, 0))))]);
  } finally {
    clearTimeout(timer);
  }
}

function appendLog(logFile: string, text: string): void {
  appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);
}

/** Sends each line of the child's output to its log file and to `onLine`; a throwing `onLine` is logged, never fatal. */
function followOutput(stream: Readable | null, which: "stdout" | "stderr", options: SpawnChildOptions): void {
  if (!stream) return;
  createInterface({ input: stream }).on("line", (line) => {
    appendLog(options.logFile, which === "stderr" ? `[stderr] ${line}` : line);
    try {
      options.onLine?.(line, which);
    } catch (error) {
      appendLog(options.logFile, `[launcher] onLine failed: ${(error as Error).message}`);
    }
  });
}

interface RunningChild {
  readonly name: string;
  readonly image: string;
  readonly pid: number;
  readonly process: SpawnedProcess;
  readonly exited: Promise<ChildExit>;
}

/**
 * The processes the launcher started, none of them reached by a terminal's Ctrl+C, none showing a window: on Windows
 * each gets a console of its own with no window (probe `window-chain.ts` with `PROBE_WITH_CONSOLE`, Bun 1.4.2: Ctrl+C
 * sent on the launcher's console reached only the launcher; a child given no console at all opens a visible window for
 * every console program it starts, which Ollama's runners are likely to do: unmeasured until re-check H1b);
 * elsewhere its own process group (`detached`). Its output goes to a log file and its pid to
 * `<root>/run/children.json` so a later launcher can clean up after a crash. One `Children` per data root, and
 * `cleanupStale` runs before its first `spawn`: each write replaces the file with this instance's children, and
 * `cleanupStale` empties it.
 */
export class Children {
  private readonly root: string;
  private readonly spawnProcess: SpawnProcess;
  private readonly platform: NodeJS.Platform;
  /** Insertion order is start order. */
  private readonly running = new Map<string, RunningChild>();

  constructor(root: string, deps: ChildrenDeps = {}) {
    this.root = root;
    this.spawnProcess = deps.spawn ?? defaultSpawn;
    this.platform = deps.platform ?? process.platform;
  }

  /** Starts `cmd`; throws when `name` is still running. A start that fails (missing executable) shows in `exited`, not as a throw. */
  spawn(name: string, cmd: string, args: readonly string[], options: SpawnChildOptions): Child {
    const existing = this.running.get(name);
    if (existing) throw new Error(`Child "${name}" is already running (pid ${existing.pid}).`);
    mkdirSync(dirname(options.logFile), { recursive: true });
    const child = this.spawnProcess(cmd, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: this.platform !== "win32",
      windowsHide: true,
      stdio: [options.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
    });
    // Writing the stop line to a server that already ended must not crash the launcher: `exited` tells what happened.
    child.stdin?.on("error", () => {});
    followOutput(child.stdout, "stdout", options);
    followOutput(child.stderr, "stderr", options);
    const image = normalizeImageName(cmd);
    let running: RunningChild | undefined;
    const exited = new Promise<ChildExit>((resolve) => {
      const finish = (exit: ChildExit): void => {
        const ended = running !== undefined && this.running.get(name) === running;
        if (ended) this.running.delete(name);
        resolve(exit);
        if (ended) this.saveRecords(options.logFile);
      };
      child.once("exit", (code, signal) => finish({ code, signal }));
      child.once("error", (error) => {
        if (child.pid !== undefined) return appendLog(options.logFile, `[launcher] ${name}: ${error.message}`);
        appendLog(options.logFile, `[launcher] ${name} did not start: ${error.message}`);
        finish({ code: null, signal: null, error: error.message });
      });
    });
    if (child.pid !== undefined) {
      running = { name, image, pid: child.pid, process: child, exited };
      this.running.set(name, running);
      this.saveRecords(options.logFile);
    }
    return { name, pid: child.pid, stdin: child.stdin, exited, isRunning: () => running !== undefined && this.running.get(name) === running };
  }

  /** Ends `name`: the graceful step first when given, a kill if it is still running after `timeoutMs`. Unknown or ended names are ignored (`not-running`). */
  async stop(name: string, options: StopOptions): Promise<StopResult> {
    const child = this.running.get(name);
    if (!child) return "not-running";
    const deadline = monotonicNow() + options.timeoutMs;
    if (options.graceful) {
      const asked = await within(Promise.resolve().then(options.graceful).then(() => true, () => false), options.timeoutMs);
      const exit = asked === true ? await within(child.exited, deadline - monotonicNow()) : TIMED_OUT;
      if (exit !== TIMED_OUT) return { ended: exit };
    }
    try {
      child.process.kill();
    } catch {
      // Already gone: the exit event settles `exited`.
    }
    await within(child.exited, KILL_EXIT_WAIT_MS);
    return "killed";
  }

  /**
   * Stops the names in `order` one after the other, then every other running child, last started first, all with the
   * same `options`. A child that needs its own graceful step (the server's `stop` line) is stopped with `stop` first.
   */
  async stopAll(order: readonly string[], options: StopOptions = { timeoutMs: DEFAULT_STOP_TIMEOUT_MS }): Promise<void> {
    const others = [...this.running.keys()].filter((name) => !order.includes(name)).reverse();
    for (const name of [...order, ...others]) await this.stop(name, options);
  }

  /**
   * Writes `children.json`. A failure (a file another program holds open, a full disk) goes to the child's log and
   * never throws: it comes from an exit event, where a throw would end the launcher with the world unsaved.
   */
  private saveRecords(logFile: string): void {
    const records = [...this.running.values()].map(({ pid, image, name }) => ({ pid, parentPid: process.pid, image, name }));
    try {
      writeRecords(this.root, records);
    } catch (error) {
      appendLog(logFile, `[launcher] could not write ${childrenFile(this.root)}: ${(error as Error).message}. A crash now would leave these children running until the next start cleans them by hand.`);
    }
  }
}

/**
 * The `llama-server` processes whose parent pid is `ollamaPid` and whose parent no longer runs: the runners a killed
 * `ollama serve` leaves behind (4 of 4 kills, facts `packaging.md`). A parent still in `processes` is skipped, except
 * the pids in `endedParents` (killed a moment ago, the snapshot is older): a reused pid must not make us kill another
 * program's runner.
 */
export function runnersLeftBy(ollamaPid: number, processes: readonly ProcessInfo[], endedParents: ReadonlySet<number> = new Set()): ProcessInfo[] {
  const parentRuns = !endedParents.has(ollamaPid) && processes.some((entry) => entry.pid === ollamaPid);
  if (parentRuns) return [];
  return processes.filter((entry) => entry.parentPid === ollamaPid && normalizeImageName(entry.image) === OLLAMA_RUNNER_IMAGE);
}

export interface StaleReport {
  readonly killed: readonly ChildRecord[];
  readonly failed: readonly { readonly record: ChildRecord; readonly error: string }[];
  /** Records left alone because the launcher that started them still runs (it may only be slow to answer `/status`). */
  readonly launcherStillRunning: readonly ChildRecord[];
}

/** True when `record`'s pid runs now with the recorded image, started by the recorded launcher. */
function childRunsAsRecorded(record: ChildRecord, processes: readonly ProcessInfo[]): boolean {
  return processes.some((entry) => entry.pid === record.pid && entry.parentPid === record.parentPid && normalizeImageName(entry.image) === record.image);
}

/** True when `childRunsAsRecorded` and `record` is neither this process nor its parent. */
function isStillOurs(record: ChildRecord, processes: readonly ProcessInfo[]): boolean {
  if (record.pid === process.pid || record.pid === process.ppid) return false;
  return childRunsAsRecorded(record, processes);
}

/**
 * True when the recorded launcher's pid runs now with this process's own image (`mine-ai` starts the launcher from the
 * program it runs in): a launcher that is slow to answer `/status` still counts, and so does a suspended one. A pid
 * another program took after a crash or a reboot does not.
 */
function launcherStillRuns(record: ChildRecord, processes: readonly ProcessInfo[]): boolean {
  const launcherImage = normalizeImageName(process.execPath);
  return processes.some((entry) => entry.pid === record.parentPid && normalizeImageName(entry.image) === launcherImage);
}

function tryKill(kill: KillPid, record: ChildRecord, report: { killed: ChildRecord[]; failed: { record: ChildRecord; error: string }[] }): boolean {
  try {
    kill(record.pid);
    report.killed.push(record);
    return true;
  } catch (error) {
    report.failed.push({ record, error: (error as Error).message });
    return false;
  }
}

/**
 * Kills what an earlier launcher left running (it crashed past its job object, or was started without one): each pid in
 * `children.json` whose image and starting launcher (`parentPid`) still match the recorded ones, then the `llama-server`
 * runners left by a recorded Ollama. A pid now used by another program is left, the player's own `ollama.exe` included,
 * and so is this process and its parent. The children of a launcher that still runs are left too, and stay recorded
 * while they run: the lock and `/status` can call a slow or suspended launcher gone, the process list cannot. Empties
 * the file of the rest; no file, nothing to do.
 */
export async function cleanupStale(root: string, list: ProcessLister = listProcesses, kill: KillPid = killProcess): Promise<StaleReport> {
  const recorded = readRecords(root);
  const report: { killed: ChildRecord[]; failed: { record: ChildRecord; error: string }[]; launcherStillRunning: ChildRecord[] } = { killed: [], failed: [], launcherStillRunning: [] };
  if (recorded === null) return report;
  const processes = await list();
  const records = recorded.filter((record) => !launcherStillRuns(record, processes));
  report.launcherStillRunning.push(...recorded.filter((record) => launcherStillRuns(record, processes) && childRunsAsRecorded(record, processes)));
  const endedParents = new Set<number>();
  for (const record of records) {
    if (isStillOurs(record, processes) && tryKill(kill, record, report)) endedParents.add(record.pid);
  }
  for (const record of records.filter((entry) => entry.image === OLLAMA_IMAGE)) {
    for (const runner of runnersLeftBy(record.pid, processes, endedParents)) {
      tryKill(kill, { pid: runner.pid, parentPid: runner.parentPid, image: OLLAMA_RUNNER_IMAGE, name: `${OLLAMA_RUNNER_IMAGE} of ${record.name}` }, report);
    }
  }
  writeRecords(root, report.launcherStillRunning);
  return report;
}

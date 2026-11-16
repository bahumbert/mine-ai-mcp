/**
 * `bun run test:fast`: the unit suite of `bun run test` (the same test paths of `PROJECTS` in `scripts/check.ts`, the
 * projects present in this checkout), with no typecheck, split over several `bun test` processes (default
 * `min(12, floor(parallelism / 2))`, 12 being the audit's best measured on 24 threads, `test-audit.md:101`; `--shards N`
 * overrides). Its pass count compares one to one with a plain `bun test` junit report. Arguments after `--` go to every
 * shard's `bun test` (write `bun run test:fast --shards 2 -- -t name`: `bun run` takes the first `--` itself; a `-t`
 * run passes when some shard ran a match and fails when none did). Each run keeps its folder `.tmp/test-fast/run-<id>/`
 * (shard reports and logs) and reads and rewrites `.tmp/test-fast/times.json`, the seconds each file took in the last
 * run, to plan the next run's shards; a `-t` run leaves it as it was (its skipped cases would time every file at ~0 s).
 * One run at a time per machine: a run queues for the unit slot (`flock` on `MINE_AI_TEST_SLOT_LOCK`, else
 * `~/.cache/mine-ai/test-fast.lock`) and says whom it waits for; `--no-slot` skips the queue.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { PROJECTS } from "./check.js";
import { DEFAULT_TEST_TIMEOUT_MS } from "./test-limit.js";

export interface JunitCase {
  readonly file: string;
  readonly name: string;
  readonly time: number;
  readonly failed: boolean;
}

export interface JunitReport {
  readonly tests: number;
  readonly failures: number;
  readonly skipped: number;
  readonly cases: readonly JunitCase[];
}

export interface ShardResult {
  readonly exit: number;
  readonly given: number;
  readonly report: JunitReport | null;
  readonly logFile: string;
  readonly logTail: string;
}

const TEST_FILE = /(\.test|_test|\.spec|_spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/u;
const MONITOR_LINK = ".agent/monitor/";

/** The test files Bun would run under `testPaths` (relative to `root`), as `./` paths in the spelling given. */
export function testFiles(root: string, testPaths: readonly string[]): string[] {
  const found: string[] = [];
  for (const testPath of testPaths) collectTestFiles(root, testPath, found);
  return found.sort();
}

function collectTestFiles(root: string, relDir: string, found: string[]): void {
  const dir = join(root, relDir);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const rel = join(relDir, entry.name);
    if (entry.isDirectory()) collectTestFiles(root, rel, found);
    else if (TEST_FILE.test(entry.name)) found.push(`./${rel}`);
  }
}

/** The key `bun test` was given for a junit `file` attribute: `.agent/monitor/x` is `./monitor/x` (a linked folder). */
export function junitFileKey(file: string): string {
  if (file.startsWith(MONITOR_LINK)) return `./monitor/${file.slice(MONITOR_LINK.length)}`;
  return file.startsWith("./") ? file : `./${file}`;
}

/** Seconds per file: the sum of its cases' times. */
export function fileTimes(cases: readonly { readonly file: string; readonly time: number }[]): Record<string, number> {
  const times: Record<string, number> = {};
  for (const testCase of cases) times[testCase.file] = (times[testCase.file] ?? 0) + testCase.time;
  return times;
}

/**
 * Greedy: longest weight first, each onto the lightest shard (ties: lowest index). A file's weight is its time when
 * timed, else its bytes times the median seconds per byte of the timed files, else its bytes.
 */
export function planShards(
  files: readonly { readonly file: string; readonly bytes: number }[],
  times: Readonly<Record<string, number>>,
  shards: number,
): string[][] {
  const count = Math.min(shards, files.length);
  if (count < 1) return [];
  const perByte = median(
    files
      .filter((item) => Object.hasOwn(times, item.file) && item.bytes > 0)
      .map((item) => times[item.file] / item.bytes),
  );
  const weigh = (item: { readonly file: string; readonly bytes: number }): number => {
    if (Object.hasOwn(times, item.file)) return times[item.file];
    return perByte === undefined ? item.bytes : item.bytes * perByte;
  };
  const ordered = files
    .map((item, index) => ({ file: item.file, weight: weigh(item), index }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  const bins: string[][] = Array.from({ length: count }, () => []);
  const loads: number[] = Array.from({ length: count }, () => 0);
  for (const item of ordered) {
    let lightest = 0;
    for (let i = 1; i < count; i++) if (loads[i] < loads[lightest]) lightest = i;
    bins[lightest].push(item.file);
    loads[lightest] += item.weight;
  }
  return bins.filter((bin) => bin.length > 0);
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Totals from the root `<testsuites>` attributes; each case with its `./` key, seconds and failed flag. */
export function readJunit(xml: string): JunitReport {
  const root = /<testsuites\b([^>]*)>/u.exec(xml);
  const totals = root === null ? {} : attributes(root[1]);
  const cases: JunitCase[] = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu)) {
    const attrs = attributes(match[1]);
    cases.push({
      file: junitFileKey(attrs.file ?? ""),
      name: unescapeXml(attrs.name ?? ""),
      time: Number(attrs.time ?? "0"),
      failed: /<(failure|error)\b/u.test(match[2] ?? ""),
    });
  }
  return {
    tests: Number(totals.tests ?? "0"),
    failures: Number(totals.failures ?? "0"),
    skipped: Number(totals.skipped ?? "0"),
    cases,
  };
}

function attributes(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of text.matchAll(/([\w:-]+)="([^"]*)"/gu)) found[match[1]] = match[2];
  return found;
}

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/gu, (whole, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return XML_ENTITIES[entity] ?? whole;
  });
}

/**
 * The summary of the shards: the first line counts the tests of the reports; then each failed case as
 * `(fail) <file> > <name>` and each shard that did not run clean. `ok` is false on any of those.
 */
export function summaryLines(
  shards: readonly ShardResult[],
  wallMs: number,
  load: number,
  filtered = false,
  slotWaitS?: number,
): { lines: string[]; ok: boolean } {
  const problems: string[] = [];
  let ok = true;
  let tests = 0;
  let failures = 0;
  let skipped = 0;
  let slowest = 0;
  shards.forEach((shard, index) => {
    if (shard.report === null) {
      ok = false;
      problems.push(`shard ${index}: no report (exit ${shard.exit})`, ...shard.logTail.split("\n").filter(Boolean));
      return;
    }
    const { report } = shard;
    tests += report.tests;
    failures += report.failures;
    skipped += report.skipped;
    slowest = Math.max(slowest, report.cases.reduce((sum, testCase) => sum + testCase.time, 0));
    if (shard.exit !== 0) {
      ok = false;
      problems.push(`shard ${index}: exit ${shard.exit} (log ${shard.logFile})`);
    }
    if (shard.given > 0 && report.tests === 0) {
      ok = false;
      problems.push(`shard ${index}: report with no test (log ${shard.logFile})`);
    }
    if (report.failures > 0 && !report.cases.some((testCase) => testCase.failed)) {
      ok = false;
      problems.push(`shard ${index}: report counts ${report.failures} failures, none named (log ${shard.logFile})`);
    }
    for (const testCase of report.cases) {
      if (testCase.failed) {
        ok = false;
        problems.push(`(fail) ${testCase.file} > ${testCase.name}`);
      }
    }
  });
  const pass = tests - failures - skipped;
  if (filtered && ok && pass === 0) {
    ok = false;
    problems.push("no test matched the filter (every case skipped)");
  }
  const waited = slotWaitS === undefined ? "" : `, slot wait ${slotWaitS.toFixed(1)} s`;
  const summary =
    `test:fast: ${tests} tests, ${pass} pass, ${failures} fail, ${skipped} skip in ${(wallMs / 1000).toFixed(1)} s ` +
    `(${shards.length} shards, slowest ${slowest.toFixed(1)} s, load ${load.toFixed(2)}${waited})`;
  return { lines: [summary, ...problems], ok };
}

/** `min(12, floor(parallelism / 2))`, at least 1. */
export function defaultShardCount(parallelism: number): number {
  return Math.max(1, Math.min(12, Math.floor(parallelism / 2)));
}

const RUNS_DIR = ".tmp/test-fast";
const TIMES_FILE = `${RUNS_DIR}/times.json`;
const LOG_TAIL_LINES = 40;

/**
 * `--shards N` (a whole number of 1 or more) and `--no-slot` before `--`; the arguments after `--` go to every shard's
 * `bun test`. `slot` is false with `--no-slot`: the run does not queue for the unit slot.
 */
export function parseArgs(
  argv: readonly string[],
  parallelism: number,
): { shards: number; passThrough: string[]; slot: boolean } {
  const dash = argv.indexOf("--");
  const before = dash < 0 ? argv : argv.slice(0, dash);
  const passThrough = dash < 0 ? [] : argv.slice(dash + 1);
  const slot = !before.includes("--no-slot");
  const own = before.filter((arg) => arg !== "--no-slot");
  const at = own.indexOf("--shards");
  if (at < 0) {
    if (own.length > 0) throw new Error(`test:fast: unknown argument ${own[0]} (use --shards N, then -- for bun test)`);
    return { shards: defaultShardCount(parallelism), passThrough, slot };
  }
  const value = Number(own[at + 1]);
  if (own.length !== 2 || !Number.isInteger(value) || value < 1) {
    throw new Error(`test:fast: --shards takes a whole number of 1 or more, got "${own[at + 1] ?? ""}"`);
  }
  return { shards: value, passThrough, slot };
}

/**
 * The unit slot: one `test:fast` at a time on this machine, so ten started at once queue instead of starving each
 * other. The lock is `MINE_AI_TEST_SLOT_LOCK` when set, else under the home's cache folder.
 */
export function slotLockPath(env: NodeJS.ProcessEnv, home: string): string {
  return env.MINE_AI_TEST_SLOT_LOCK || join(home, ".cache/mine-ai/test-fast.lock");
}

/** A run queues for the slot unless `--no-slot` was given or it already runs in the slot (`MINE_AI_TEST_SLOT_HELD=1`). */
export function needsSlot(slot: boolean, env: NodeJS.ProcessEnv): boolean {
  return slot && env.MINE_AI_TEST_SLOT_HELD !== "1";
}

const FLOCK_BUSY = 75;

/**
 * A clock all processes read alike (`performance.timeOrigin` is each process's start on the wall clock; `hrtime` is
 * relative to its own process start, so a child's reading would not compare with its parent's), in nanoseconds.
 */
function slotClockNs(): bigint {
  return BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
}

interface Finished {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Runs `argv` in its own process group, with `stdio` inherited; a SIGINT or SIGTERM this process gets goes to the whole
 * group (the flock and its command, the command's shards).
 */
function runGroup(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<Finished> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { env, stdio: "inherit", detached: true });
    const forward = (signal: NodeJS.Signals) => (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // the group has already exited
      }
    };
    const onInterrupt = forward("SIGINT");
    const onTerminate = forward("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    const stop = (): void => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    child.once("error", (error) => {
      stop();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      stop();
      resolve({ code, signal });
    });
  });
}

/** Whether a pid is running (signal 0: nothing is sent). `EPERM` means it runs under another user. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * The holder's line of `<lock>.holder` (`pid <p>, <root>, since <since>`), or `unknown` when the file is missing,
 * unreadable, or names a pid that is no longer running.
 */
function holderOf(lock: string): string {
  try {
    const holder = JSON.parse(readFileSync(`${lock}.holder`, "utf8")) as { pid?: unknown; root?: unknown; since?: unknown };
    if (typeof holder.pid !== "number" || typeof holder.root !== "string" || typeof holder.since !== "string") return "unknown";
    if (!pidAlive(holder.pid)) return "unknown";
    return `pid ${holder.pid}, ${holder.root}, since ${holder.since}`;
  } catch {
    return "unknown";
  }
}

/**
 * Runs `command` in the unit slot and returns its exit. A probe takes the lock without running anything: busy (75)
 * says `waiting for the unit slot, held by <holder>` and the run then queues on the lock with a blocking `flock`. The
 * command runs under that `flock`, so its own exit (even 75) is its result, never taken for a busy lock. Without
 * `flock` the command runs with no slot.
 */
export async function runInSlot(
  command: readonly string[],
  lock: string,
  env: NodeJS.ProcessEnv,
  say: (line: string) => void,
): Promise<number> {
  const flock = Bun.which("flock", { PATH: env.PATH ?? "" });
  if (flock === null) {
    say("test:fast: no flock here, running without the unit slot");
    const alone = await runGroup(command, { ...env, MINE_AI_TEST_SLOT_HELD: "1" });
    return alone.code ?? 1;
  }
  try {
    mkdirSync(dirname(lock), { recursive: true });
  } catch (error) {
    say(`test:fast: cannot make the unit slot folder ${dirname(lock)}: ${(error as Error).message}`);
    return 1;
  }
  const probe = await runGroup([flock, "--nonblock", "--conflict-exit-code", String(FLOCK_BUSY), lock, "true"], env);
  if (probe.code === FLOCK_BUSY) say(`test:fast: waiting for the unit slot, held by ${holderOf(lock)}`);
  else if (probe.code !== 0) {
    say(`test:fast: flock failed (exit ${probe.code ?? probe.signal ?? "unknown"})`);
    return 1;
  }
  const queued: NodeJS.ProcessEnv = {
    ...env,
    MINE_AI_TEST_SLOT_HELD: "1",
    MINE_AI_TEST_SLOT_ASKED_NS: slotClockNs().toString(),
    MINE_AI_TEST_SLOT_PARENT: String(process.pid),
  };
  const run = await runGroup([flock, lock, ...command], queued);
  return run.code ?? 1;
}

/** Whether the run that asked for the slot still lives. */
function parentAlive(pid: string | undefined): boolean {
  return pidAlive(Number(pid));
}

/**
 * The holder file the other queued runs read: written in temp then renamed, so a reader never sees half of it. It only
 * names the run for the others, so a write that fails (no folder, a read-only home) does not fail the run.
 */
export function writeHolder(lock: string, root: string): void {
  try {
    mkdirSync(dirname(lock), { recursive: true });
    const temp = `${lock}.holder.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ pid: process.pid, root, since: new Date().toISOString() })}\n`);
    renameSync(temp, `${lock}.holder`);
  } catch {
    // advisory: the waiting runs say `unknown` for the holder
  }
}

/** Removes the holder file when this run wrote it, so a later waiter does not name a run that is gone. */
export function releaseHolder(lock: string): void {
  try {
    const holder = JSON.parse(readFileSync(`${lock}.holder`, "utf8")) as { pid?: unknown };
    if (holder.pid === process.pid) unlinkSync(`${lock}.holder`);
  } catch {
    // no holder file, or not readable: nothing of ours to remove
  }
}

/** Seconds this run waited for the slot, from the asking run's clock reading in the environment; undefined outside a slot. */
function slotWaitSeconds(env: NodeJS.ProcessEnv): number | undefined {
  if (env.MINE_AI_TEST_SLOT_ASKED_NS === undefined) return undefined;
  return Number(slotClockNs() - BigInt(env.MINE_AI_TEST_SLOT_ASKED_NS)) / 1e9;
}

/** Whether the arguments for `bun test` hold a test-name filter: `-t name`, `-t=name`, `-tname` (Bun reads all three), `--test-name-pattern name` or `=name`. */
export function isFiltered(passThrough: readonly string[]): boolean {
  return passThrough.some((arg) => /^(-t|--test-name-pattern(=|$))/u.test(arg));
}

/**
 * The arguments after `--`, as each shard's `bun test` gets them. A filtered run adds `--pass-with-no-tests`: Bun 1.4.2
 * exits 1 for a process whose files hold no match, and most shards hold none (`summaryLines` fails the run when no
 * shard matched).
 */
export function shardArguments(passThrough: readonly string[]): string[] {
  // Bun 1.4.2 resets the preload's limit after the first file; the CLI default persists across files (2026-11-16).
  const args = ["--timeout", String(DEFAULT_TEST_TIMEOUT_MS), ...passThrough];
  return isFiltered(passThrough) ? [...args, "--pass-with-no-tests"] : args;
}

/**
 * The times to keep after a run. A filtered run times only the cases it ran: every other case is skipped at ~0 s, so
 * its times would plan the next run on one shard; it leaves the old times.
 */
export function nextTimes(
  old: Record<string, number>,
  cases: readonly { readonly file: string; readonly time: number }[],
  filtered: boolean,
): Record<string, number> {
  return filtered ? old : fileTimes(cases);
}

function readTimes(path: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return {};
  }
}

function writeTimes(path: string, times: Record<string, number>): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(times, null, 2)}\n`);
  renameSync(temp, path);
}

function logTail(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").split("\n").slice(-LOG_TAIL_LINES).join("\n");
}

/** One run: the shards in parallel, each a `bun test` with a junit report, then the summary and the times. */
export async function main(argv: readonly string[]): Promise<number> {
  const root = join(import.meta.dir, "..");
  const options = parseArgs(argv, os.availableParallelism());
  const lock = slotLockPath(process.env, os.homedir());
  if (needsSlot(options.slot, process.env)) {
    return runInSlot([process.execPath, import.meta.path, ...argv], lock, process.env, console.log);
  }
  if (process.env.MINE_AI_TEST_SLOT_HELD === "1") {
    if (!parentAlive(process.env.MINE_AI_TEST_SLOT_PARENT)) {
      console.log("test:fast: the run that asked for the slot is gone, nothing run");
      return 0;
    }
    writeHolder(lock, root);
    process.once("exit", () => releaseHolder(lock));
  }
  const slotWait = slotWaitSeconds(process.env);
  const present = PROJECTS.filter((project) => existsSync(join(root, project.dir)));
  const files = testFiles(root, present.map((project) => project.tests));
  if (files.length === 0) {
    console.log("test:fast: no test file under the projects present");
    return 1;
  }
  const sized = files.map((file) => ({ file, bytes: statSync(join(root, file)).size }));
  const oldTimes = readTimes(join(root, TIMES_FILE));
  const filtered = isFiltered(options.passThrough);
  const plan = planShards(sized, oldTimes, options.shards);
  mkdirSync(join(root, RUNS_DIR), { recursive: true });
  const runDir = mkdtempSync(join(root, RUNS_DIR, "run-"));
  const load = os.loadavg()[0];
  const started = performance.now();
  const procs = plan.map((bin, index) => {
    const log = openSync(join(runDir, `shard-${index}.log`), "w");
    const report = join(runDir, `shard-${index}.xml`);
    const proc = Bun.spawn(
      [process.execPath, "test", ...bin, "--reporter=junit", `--reporter-outfile=${report}`, ...shardArguments(options.passThrough)],
      { cwd: root, stdout: log, stderr: log },
    );
    return { proc, log };
  });
  const exits = await Promise.all(procs.map(({ proc }) => proc.exited));
  for (const { log } of procs) closeSync(log);
  const wallMs = performance.now() - started;
  const shards: ShardResult[] = plan.map((bin, index) => {
    const report = join(runDir, `shard-${index}.xml`);
    const log = join(runDir, `shard-${index}.log`);
    return {
      exit: exits[index],
      given: bin.length,
      report: existsSync(report) ? readJunit(readFileSync(report, "utf8")) : null,
      logFile: log,
      logTail: logTail(log),
    };
  });
  const { lines, ok } = summaryLines(shards, wallMs, load, filtered, slotWait);
  for (const line of lines) console.log(line);
  console.log(`test:fast: run folder ${runDir}`);
  writeTimes(join(root, TIMES_FILE), nextTimes(oldTimes, shards.flatMap((shard) => shard.report?.cases ?? []), filtered));
  return ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

/**
 * `bun run test:fast`: the unit suite of `bun run test` (the same test paths of `PROJECTS` in `scripts/check.ts`, the
 * projects present in this checkout), with no typecheck, split over several `bun test` processes (default
 * `min(12, floor(parallelism / 2))`, 12 being the audit's best measured on 24 threads, `test-audit.md:101`; `--shards N`
 * overrides). Its pass count compares one to one with a plain `bun test` junit report. Arguments after `--` go to every
 * shard's `bun test` (write `bun run test:fast --shards 2 -- -t name`: `bun run` takes the first `--` itself; a `-t`
 * run passes when some shard ran a match and fails when none did). Each run keeps its folder `.tmp/test-fast/run-<id>/`
 * (shard reports and logs) and reads and rewrites `.tmp/test-fast/times.json`, the seconds each file took in the last
 * run, to plan the next run's shards; a `-t` run leaves it as it was (its skipped cases would time every file at ~0 s).
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
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { PROJECTS } from "./check.js";

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
  const summary =
    `test:fast: ${tests} tests, ${pass} pass, ${failures} fail, ${skipped} skip in ${(wallMs / 1000).toFixed(1)} s ` +
    `(${shards.length} shards, slowest ${slowest.toFixed(1)} s, load ${load.toFixed(2)})`;
  return { lines: [summary, ...problems], ok };
}

/** `min(12, floor(parallelism / 2))`, at least 1. */
export function defaultShardCount(parallelism: number): number {
  return Math.max(1, Math.min(12, Math.floor(parallelism / 2)));
}

const RUNS_DIR = ".tmp/test-fast";
const TIMES_FILE = `${RUNS_DIR}/times.json`;
const LOG_TAIL_LINES = 40;

/** `--shards N` (a whole number of 1 or more) before `--`; the arguments after `--` go to every shard's `bun test`. */
export function parseArgs(argv: readonly string[], parallelism: number): { shards: number; passThrough: string[] } {
  const dash = argv.indexOf("--");
  const own = dash < 0 ? argv : argv.slice(0, dash);
  const passThrough = dash < 0 ? [] : argv.slice(dash + 1);
  const at = own.indexOf("--shards");
  if (at < 0) {
    if (own.length > 0) throw new Error(`test:fast: unknown argument ${own[0]} (use --shards N, then -- for bun test)`);
    return { shards: defaultShardCount(parallelism), passThrough };
  }
  const value = Number(own[at + 1]);
  if (own.length !== 2 || !Number.isInteger(value) || value < 1) {
    throw new Error(`test:fast: --shards takes a whole number of 1 or more, got "${own[at + 1] ?? ""}"`);
  }
  return { shards: value, passThrough };
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
  return isFiltered(passThrough) ? [...passThrough, "--pass-with-no-tests"] : [...passThrough];
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
  const { lines, ok } = summaryLines(shards, wallMs, load, filtered);
  for (const line of lines) console.log(line);
  console.log(`test:fast: run folder ${runDir}`);
  writeTimes(join(root, TIMES_FILE), nextTimes(oldTimes, shards.flatMap((shard) => shard.report?.cases ?? []), filtered));
  return ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

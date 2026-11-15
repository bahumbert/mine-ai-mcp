import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultShardCount,
  fileTimes,
  isFiltered,
  junitFileKey,
  main,
  nextTimes,
  needsSlot,
  parseArgs,
  planShards,
  readJunit,
  releaseHolder,
  runInSlot,
  shardArguments,
  slotLockPath,
  summaryLines,
  testFiles,
  writeHolder,
} from "./test-fast.js";

const roots: string[] = [];
const holders: { flock: { kill(signal: NodeJS.Signals): void }; pid: number }[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  for (const holder of holders) {
    holder.flock.kill("SIGKILL");
    try {
      process.kill(holder.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

function tree(files: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "test-fast-"));
  roots.push(root);
  for (const file of files) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  return root;
}

const JUNIT_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" assertions="3" failures="2" skipped="1" time="0.5">
  <testsuite name="a.test.ts" file="a.test.ts" tests="3" assertions="2" failures="1" skipped="1" time="0.3" hostname="PC">
    <testcase name="passes &amp; &lt;x&gt;" classname="" time="0.2" file="a.test.ts" line="2" assertions="1" />
    <testcase name="fails here" classname="" time="0.1" file="a.test.ts" line="3" assertions="1">
      <failure type="AssertionError" message="expect(received).toBe(expected)">AssertionError: boom</failure>
    </testcase>
    <testcase name="skipped one" classname="" time="0" file="a.test.ts" line="4" assertions="0">
      <skipped />
    </testcase>
  </testsuite>
  <testsuite name="s.test.ts" file=".agent/monitor/s.test.ts" tests="1" assertions="0" failures="1" skipped="0" time="0.2" hostname="PC">
    <testcase name="errors out" classname="" time="0.2" file=".agent/monitor/s.test.ts" line="1" assertions="0">
      <error type="Error" message="boom" />
    </testcase>
  </testsuite>
</testsuites>
`;

function shard(exit: number, given: number, report: ReturnType<typeof readJunit> | null, logTail = "") {
  return { exit, given, report, logFile: "shard.log", logTail };
}

test("testFiles finds the test files of a path, sorted, as ./ paths in the path's spelling", () => {
  const root = tree([
    "src/a.test.ts",
    "src/b_test.js",
    "src/c.spec.mts",
    "src/d_spec.tsx",
    "src/e.ts",
    "src/f.test.txt",
    "src/node_modules/x/g.test.ts",
  ]);
  expect(testFiles(root, ["./src"])).toEqual([
    "./src/a.test.ts",
    "./src/b_test.js",
    "./src/c.spec.mts",
    "./src/d_spec.tsx",
  ]);
});

test("testFiles keeps the spelling of a linked path (links are not resolved)", () => {
  const root = tree(["real/a.test.ts"]);
  symlinkSync(join(root, "real"), join(root, "link"));
  expect(testFiles(root, ["./link"])).toEqual(["./link/a.test.ts"]);
});

test("junitFileKey maps a junit file name to the key bun test was given", () => {
  expect(junitFileKey("src/a.test.ts")).toBe("./src/a.test.ts");
  expect(junitFileKey("./src/a.test.ts")).toBe("./src/a.test.ts");
  expect(junitFileKey(".agent/monitor/src/s.test.ts")).toBe("./monitor/src/s.test.ts");
});

test("planShards puts the longest file first on the lightest shard", () => {
  const files = [
    { file: "a", bytes: 1 },
    { file: "b", bytes: 1 },
    { file: "c", bytes: 1 },
    { file: "d", bytes: 1 },
  ];
  expect(planShards(files, { a: 10, b: 6, c: 4, d: 2 }, 2)).toEqual([
    ["a", "d"],
    ["b", "c"],
  ]);
});

test("planShards weighs an untimed file at its bytes times the median seconds per byte", () => {
  // t: 1 s per 100 bytes, x: 2.5 s per 250 bytes, so the median is 0.01 s per byte and u (200 bytes) weighs 2.
  // Weighed by its raw 200 bytes it would sit alone and the result would differ.
  const files = [
    { file: "t", bytes: 100 },
    { file: "u", bytes: 200 },
    { file: "x", bytes: 250 },
  ];
  const shards = planShards(files, { t: 1, x: 2.5 }, 2).map((s) => [...s].sort());
  expect(shards.sort()).toEqual([["t", "u"], ["x"]]);
});

test("planShards weighs files by bytes when no file has a time", () => {
  const files = [
    { file: "a", bytes: 10 },
    { file: "b", bytes: 30 },
    { file: "c", bytes: 20 },
  ];
  expect(planShards(files, {}, 2)).toEqual([["b"], ["c", "a"]]);
});

test("planShards caps the shard count at the file count", () => {
  const files = [
    { file: "a", bytes: 1 },
    { file: "b", bytes: 1 },
  ];
  expect(planShards(files, {}, 3)).toHaveLength(2);
});

test("times read back from a junit report steer a second plan", () => {
  const report = readJunit(JUNIT_SAMPLE);
  const times = fileTimes(report.cases);
  const files = [
    { file: "./a.test.ts", bytes: 100 },
    { file: "./monitor/s.test.ts", bytes: 100 },
    { file: "./c.test.ts", bytes: 100 },
  ];
  const timed = { ...times, "./c.test.ts": 0.2, "./monitor/s.test.ts": 0.05 };
  // a: 0.3 s (two cases), monitor/s: 0.05 s, c: 0.2 s, as the report's keys name them.
  expect(planShards(files, timed, 2)).toEqual([["./a.test.ts"], ["./c.test.ts", "./monitor/s.test.ts"]]);
  expect(planShards(files, {}, 2)).toEqual([["./a.test.ts", "./c.test.ts"], ["./monitor/s.test.ts"]]);
});

test("readJunit gives the totals of the root element and each case with its ./ key and failed flag", () => {
  const report = readJunit(JUNIT_SAMPLE);
  expect(report.tests).toBe(4);
  expect(report.failures).toBe(2);
  expect(report.skipped).toBe(1);
  expect(report.cases).toEqual([
    { file: "./a.test.ts", name: "passes & <x>", time: 0.2, failed: false },
    { file: "./a.test.ts", name: "fails here", time: 0.1, failed: true },
    { file: "./a.test.ts", name: "skipped one", time: 0, failed: false },
    { file: "./monitor/s.test.ts", name: "errors out", time: 0.2, failed: true },
  ]);
});

test("summaryLines: two green shards are ok, with the summary line", () => {
  const green = readJunit(
    '<testsuites name="bun test" tests="3" assertions="3" failures="0" skipped="1" time="0.3">' +
      '<testsuite name="a.test.ts" file="a.test.ts">' +
      '<testcase name="one" classname="" time="0.2" file="a.test.ts" />' +
      '<testcase name="two" classname="" time="0.1" file="a.test.ts" />' +
      '<testcase name="three" classname="" time="0" file="a.test.ts"><skipped /></testcase>' +
      "</testsuite></testsuites>",
  );
  const result = summaryLines([shard(0, 2, green), shard(0, 2, green)], 12_300, 6.25);
  expect(result.ok).toBe(true);
  expect(result.lines[0]).toMatch(
    /^test:fast: \d+ tests, \d+ pass, 0 fail, \d+ skip in [\d.]+ s \(2 shards, slowest [\d.]+ s, load [\d.]+\)$/u,
  );
});

test("summaryLines: a shard that exits 1 with a failed case is not ok and names the case", () => {
  const report = readJunit(JUNIT_SAMPLE);
  const result = summaryLines([shard(1, 3, report)], 1000, 1);
  expect(result.ok).toBe(false);
  expect(result.lines).toContain("(fail) ./a.test.ts > fails here");
  expect(result.lines).toContain("shard 0: exit 1 (log shard.log)");
});

test("summaryLines: a shard that exits 1 with only green cases is not ok and names its log", () => {
  const green = readJunit(
    '<testsuites name="bun test" tests="1" assertions="1" failures="0" skipped="0" time="0.1">' +
      '<testsuite name="a.test.ts" file="a.test.ts"><testcase name="one" classname="" time="0.1" file="a.test.ts" /></testsuite>' +
      "</testsuites>",
  );
  const result = summaryLines([shard(1, 1, green)], 1000, 1);
  expect(result.ok).toBe(false);
  expect(result.lines).toContain("shard 0: exit 1 (log shard.log)");
});

test("summaryLines: a report that counts failures, none of them named, is not ok and names its log", () => {
  const unnamed = readJunit(
    '<testsuites name="bun test" tests="1" assertions="0" failures="1" skipped="0" time="0.1">' +
      '<testsuite name="a.test.ts" file="a.test.ts"><testcase name="one" classname="" time="0.1" file="a.test.ts" /></testsuite>' +
      "</testsuites>",
  );
  const result = summaryLines([shard(0, 1, unnamed)], 1000, 1);
  expect(result.ok).toBe(false);
  expect(result.lines).toContain("shard 0: report counts 1 failures, none named (log shard.log)");
});

test("summaryLines: a shard with no report is not ok, and with exit 1 shows its log tail", () => {
  const failed = summaryLines([shard(1, 3, null, "line one\nSegmentation fault")], 1000, 1);
  expect(failed.ok).toBe(false);
  expect(failed.lines).toContain("shard 0: no report (exit 1)");
  expect(failed.lines).toContain("Segmentation fault");
  expect(summaryLines([shard(0, 3, null)], 1000, 1).ok).toBe(false);
});

test("summaryLines: a report with no test for a shard that had files is not ok", () => {
  const empty = readJunit('<testsuites name="bun test" tests="0" failures="0" skipped="0" time="0"></testsuites>');
  const result = summaryLines([shard(0, 5, empty)], 1000, 1);
  expect(result.ok).toBe(false);
  expect(result.lines).toContain("shard 0: report with no test (log shard.log)");
});

const NO_MATCH_REPORT =
  '<testsuites name="bun test" tests="2" assertions="0" failures="0" skipped="2" time="0.1">' +
  '<testsuite name="a.test.ts" file="a.test.ts">' +
  '<testcase name="one" classname="" time="0" file="a.test.ts"><skipped /></testcase>' +
  '<testcase name="two" classname="" time="0" file="a.test.ts"><skipped /></testcase>' +
  "</testsuite></testsuites>";

test("a run with a test-name filter in any form Bun reads adds --pass-with-no-tests (a shard with no match exits 0, not 1), others do not", () => {
  const filtered = [["-t", "name"], ["-t=name"], ["-tname"], ["--test-name-pattern", "name"], ["--test-name-pattern=name"]];
  for (const args of filtered) {
    expect(isFiltered(args)).toBe(true);
    expect(shardArguments(args)).toEqual([...args, "--pass-with-no-tests"]);
  }
  for (const args of [["--timeout", "5000"], []]) {
    expect(isFiltered(args)).toBe(false);
    expect(shardArguments(args)).toEqual(args);
  }
});

test("summaryLines: a filtered run is ok when one shard ran its matches and the others matched nothing", () => {
  const ran = readJunit(
    '<testsuites name="bun test" tests="2" assertions="1" failures="0" skipped="1" time="0.1">' +
      '<testsuite name="a.test.ts" file="a.test.ts">' +
      '<testcase name="one" classname="" time="0.1" file="a.test.ts" />' +
      '<testcase name="two" classname="" time="0" file="a.test.ts"><skipped /></testcase>' +
      "</testsuite></testsuites>",
  );
  const result = summaryLines([shard(0, 1, ran), shard(0, 1, readJunit(NO_MATCH_REPORT))], 1000, 1, true);
  expect(result.ok).toBe(true);
});

test("summaryLines: a filtered run that no shard matched is not ok and says so", () => {
  const none = readJunit(NO_MATCH_REPORT);
  const result = summaryLines([shard(0, 1, none), shard(0, 1, none)], 1000, 1, true);
  expect(result.ok).toBe(false);
  expect(result.lines).toContain("no test matched the filter (every case skipped)");
  expect(summaryLines([shard(0, 1, none)], 1000, 1).ok).toBe(true);
});

test("a filtered run leaves the old times, so the plan from them is the plan of the run before it", () => {
  const files = ["a", "b", "c", "d", "e", "f"].map((file) => ({ file, bytes: 10 }));
  const old = { a: 9, b: 8, c: 3, d: 2, e: 1, f: 1 };
  const zero = files.map(({ file }) => ({ file, time: 0 }));
  const after = nextTimes(old, zero, true);
  expect(after).toEqual(old);
  expect(planShards(files, after, 3)).toEqual(planShards(files, old, 3));
  // the fault: the zero times of the filtered run put every file on one shard
  expect(planShards(files, nextTimes(old, zero, false), 3).map((bin) => bin.length)).toEqual([6]);
});

test("defaultShardCount is half the parallelism, at most 12, at least 1", () => {
  expect(defaultShardCount(24)).toBe(12);
  expect(defaultShardCount(8)).toBe(4);
  expect(defaultShardCount(1)).toBe(1);
});

test("parseArgs: default shard count, --shards N, and the arguments after -- for bun test", () => {
  expect(parseArgs([], 24)).toEqual({ shards: 12, passThrough: [], slot: true });
  expect(parseArgs(["--shards", "3"], 24)).toEqual({ shards: 3, passThrough: [], slot: true });
  expect(parseArgs(["--shards", "2", "--", "--timeout", "5000"], 8)).toEqual({
    shards: 2,
    passThrough: ["--timeout", "5000"],
    slot: true,
  });
});

test("parseArgs refuses a shard count that is not a whole number of 1 or more, and an unknown argument", () => {
  expect(() => parseArgs(["--shards", "0"], 8)).toThrow("--shards takes a whole number of 1 or more");
  expect(() => parseArgs(["--shards", "1.5"], 8)).toThrow("--shards takes a whole number of 1 or more");
  expect(() => parseArgs(["--bogus"], 8)).toThrow("unknown argument --bogus");
  expect(() => parseArgs(["--shards"], 8)).toThrow("--shards takes a whole number of 1 or more");
  expect(() => parseArgs(["--shards", "3", "extra"], 8)).toThrow("--shards takes a whole number of 1 or more");
});

function slotLock(): string {
  const dir = mkdtempSync(join(tmpdir(), "test-fast-slot-"));
  roots.push(dir);
  return join(dir, "unit.lock");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(20);
  }
}

/** A holder of `lock` as a real `flock` whose command is `sleep` (the pid in the pid file, `exec` replaces `sh`). */
async function holdLock(lock: string): Promise<{ flock: { kill(signal: NodeJS.Signals): void }; pid: number }> {
  const pidFile = join(dirname(lock), `holder-${holders.length}.pid`);
  const flock = Bun.spawn(["flock", lock, "sh", "-c", `echo $$ > ${pidFile}; exec sleep 30`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", "the holder's pid");
  const holder = { flock, pid: Number(readFileSync(pidFile, "utf8").trim()) };
  holders.push(holder);
  return holder;
}

test("slotLockPath takes the env override, else the cache folder under the home given", () => {
  expect(slotLockPath({ MINE_AI_TEST_SLOT_LOCK: "/x/y.lock" }, "/home/u")).toBe("/x/y.lock");
  expect(slotLockPath({}, "/home/u")).toBe("/home/u/.cache/mine-ai/test-fast.lock");
});

test("parseArgs(--no-slot) turns the slot off, in any order with --shards, and after -- it goes to bun test", () => {
  expect(parseArgs(["--no-slot"], 8)).toEqual({ shards: 4, passThrough: [], slot: false });
  expect(parseArgs(["--shards", "3", "--no-slot"], 8)).toEqual({ shards: 3, passThrough: [], slot: false });
  expect(parseArgs(["--no-slot", "--shards", "3"], 8)).toEqual({ shards: 3, passThrough: [], slot: false });
  expect(parseArgs(["--", "--no-slot"], 8)).toEqual({ shards: 4, passThrough: ["--no-slot"], slot: true });
});

test("needsSlot: a run asks for the slot unless it is off or the run already holds it", () => {
  expect(needsSlot(true, {})).toBe(true);
  expect(needsSlot(true, { MINE_AI_TEST_SLOT_HELD: "1" })).toBe(false);
  expect(needsSlot(false, {})).toBe(false);
});

test("runInSlot on a free lock returns the command's exit with no waiting line", async () => {
  const lines: string[] = [];
  const code = await runInSlot(["sh", "-c", "exit 3"], slotLock(), { PATH: process.env.PATH }, (line) => lines.push(line));
  expect(code).toBe(3);
  expect(lines).toEqual([]);
});

test("runInSlot on a held lock says who holds it, then runs once the holder is gone", async () => {
  const lock = slotLock();
  const holder = await holdLock(lock);
  writeFileSync(`${lock}.holder`, JSON.stringify({ pid: holder.pid, root: "/work/tsan", since: "2026-11-15T09:00:00.000Z" }));
  const lines: string[] = [];
  const run = runInSlot(["true"], lock, { PATH: process.env.PATH }, (line) => lines.push(line));
  await delay(300);
  process.kill(holder.pid, "SIGTERM");
  const outcome = await Promise.race([run, delay(5000).then(() => "timed out" as const)]);
  expect(outcome).toBe(0);
  expect(lines).toEqual([
    `test:fast: waiting for the unit slot, held by pid ${holder.pid}, /work/tsan, since 2026-11-15T09:00:00.000Z`,
  ]);
});

test("runInSlot on a held lock with no holder file says the holder is unknown", async () => {
  const lock = slotLock();
  const holder = await holdLock(lock);
  const lines: string[] = [];
  const run = runInSlot(["true"], lock, { PATH: process.env.PATH }, (line) => lines.push(line));
  await delay(300);
  process.kill(holder.pid, "SIGTERM");
  expect(await run).toBe(0);
  expect(lines).toEqual(["test:fast: waiting for the unit slot, held by unknown"]);
});

test("a queued run starts when its holder's command is SIGKILLed", async () => {
  const lock = slotLock();
  const holder = await holdLock(lock);
  const run = runInSlot(["true"], lock, { PATH: process.env.PATH }, () => {});
  await delay(300);
  process.kill(holder.pid, "SIGKILL");
  expect(await Promise.race([run, delay(5000).then(() => "timed out" as const)])).toBe(0);
});

test("a queued run waits while the holder's flock is killed but its command lives, and starts once the command dies", async () => {
  const lock = slotLock();
  const holder = await holdLock(lock);
  holder.flock.kill("SIGKILL");
  const run = runInSlot(["true"], lock, { PATH: process.env.PATH }, () => {});
  const early = await Promise.race([run.then(() => "finished" as const), delay(1000).then(() => "still waiting" as const)]);
  expect(early).toBe("still waiting");
  process.kill(holder.pid, "SIGKILL");
  expect(await Promise.race([run, delay(5000).then(() => "timed out" as const)])).toBe(0);
});

test("without flock the command runs with no slot, and says so", async () => {
  const lines: string[] = [];
  const env = { ...process.env, PATH: "/nonexistent" };
  expect(await runInSlot(["/bin/sh", "-c", "exit 0"], slotLock(), env, (line) => lines.push(line))).toBe(0);
  expect(lines).toEqual(["test:fast: no flock here, running without the unit slot"]);
});

test("a command that exits 75 is its own exit, read once: it is not taken for a busy lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "test-fast-count-"));
  roots.push(dir);
  const counter = join(dir, "runs");
  const code = await runInSlot(["sh", "-c", `echo run >> ${counter}; exit 75`], slotLock(), { PATH: process.env.PATH }, () => {});
  expect(code).toBe(75);
  expect(readFileSync(counter, "utf8")).toBe("run\n");
});

test("a lock folder that cannot be made is a failed run (1), never 0", async () => {
  const code = await runInSlot(["true"], "/proc/x/lock", { PATH: process.env.PATH }, () => {});
  expect(code).toBe(1);
});

test("main with the slot held by a parent that is gone runs nothing and returns 0", async () => {
  const gone = Bun.spawn([process.execPath, "-e", "0"], { stdout: "ignore", stderr: "ignore" });
  await gone.exited;
  const runsDir = join(import.meta.dir, "..", ".tmp", "test-fast");
  const runsBefore = existsSync(runsDir) ? readdirSync(runsDir).filter((name) => name.startsWith("run-")) : [];
  const saved = { HELD: process.env.MINE_AI_TEST_SLOT_HELD, PARENT: process.env.MINE_AI_TEST_SLOT_PARENT };
  const lines: string[] = [];
  const log = console.log;
  process.env.MINE_AI_TEST_SLOT_HELD = "1";
  process.env.MINE_AI_TEST_SLOT_PARENT = String(gone.pid);
  console.log = (...parts: unknown[]) => lines.push(parts.join(" "));
  try {
    expect(await main(["--shards", "1"])).toBe(0);
  } finally {
    console.log = log;
    for (const [key, value] of Object.entries({ MINE_AI_TEST_SLOT_HELD: saved.HELD, MINE_AI_TEST_SLOT_PARENT: saved.PARENT })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  expect(lines).toEqual(["test:fast: the run that asked for the slot is gone, nothing run"]);
  const runsAfter = existsSync(runsDir) ? readdirSync(runsDir).filter((name) => name.startsWith("run-")) : [];
  expect(runsAfter).toEqual(runsBefore);
});

test("summaryLines adds the slot wait to its first line when given", () => {
  const green = readJunit(
    '<testsuites name="bun test" tests="1" assertions="1" failures="0" skipped="0" time="0.1">' +
      '<testsuite name="a.test.ts" file="a.test.ts"><testcase name="one" classname="" time="0.1" file="a.test.ts" /></testsuite>' +
      "</testsuites>",
  );
  const result = summaryLines([shard(0, 1, green)], 1000, 1, false, 12.34);
  expect(result.lines[0]).toMatch(/, slot wait 12\.3 s\)$/u);
});

async function exitedPid(): Promise<number> {
  const gone = Bun.spawn([process.execPath, "-e", "0"], { stdout: "ignore", stderr: "ignore" });
  await gone.exited;
  return gone.pid;
}

test("writeHolder names this run in a folder that does not exist yet, and a holder that cannot be written does not throw", () => {
  const lock = join(mkdtempSync(join(tmpdir(), "test-fast-holder-")), "nested", "unit.lock");
  roots.push(dirname(dirname(lock)));
  writeHolder(lock, "/work/tsan");
  const holder = JSON.parse(readFileSync(`${lock}.holder`, "utf8")) as { pid: number; root: string; since: string };
  expect(holder.pid).toBe(process.pid);
  expect(holder.root).toBe("/work/tsan");
  expect(() => writeHolder("/proc/x/unit.lock", "/work/tsan")).not.toThrow();
});

test("releaseHolder removes the holder file only when this run wrote it", () => {
  const lock = slotLock();
  writeHolder(lock, "/work/tsan");
  releaseHolder(lock);
  expect(existsSync(`${lock}.holder`)).toBe(false);
  writeFileSync(`${lock}.holder`, JSON.stringify({ pid: 1, root: "/other", since: "2026-11-15T09:00:00.000Z" }));
  releaseHolder(lock);
  expect(existsSync(`${lock}.holder`)).toBe(true);
});

test("runInSlot: a holder file naming an exited pid says the holder is unknown", async () => {
  const lock = slotLock();
  const holder = await holdLock(lock);
  writeFileSync(`${lock}.holder`, JSON.stringify({ pid: await exitedPid(), root: "/work/tsan", since: "2026-11-15T09:00:00.000Z" }));
  const lines: string[] = [];
  const run = runInSlot(["true"], lock, { PATH: process.env.PATH }, (line) => lines.push(line));
  await delay(300);
  process.kill(holder.pid, "SIGTERM");
  expect(await run).toBe(0);
  expect(lines).toEqual(["test:fast: waiting for the unit slot, held by unknown"]);
});

test("a SIGTERM to the run ends its command's group, and the run returns 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "test-fast-signal-"));
  roots.push(dir);
  const pidFile = join(dir, "command.pid");
  const run = runInSlot(["sh", "-c", `echo $$ > ${pidFile}; exec sleep 30`], slotLock(), { PATH: process.env.PATH }, () => {});
  await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", "the command's pid");
  const commandPid = Number(readFileSync(pidFile, "utf8").trim());
  process.kill(process.pid, "SIGTERM");
  expect(await Promise.race([run, delay(5000).then(() => "timed out" as const)])).toBe(1);
  expect(() => process.kill(commandPid, 0)).toThrow();
});

test("a queued run whose parent is SIGKILLed: its waiter takes the slot when the holder ends, and that run does nothing and frees the lock", async () => {
  const lock = slotLock();
  const holder = await holdLock(lock);
  const log = join(dirname(lock), "helper.log");
  const modulePath = join(import.meta.dir, "test-fast.ts");
  const script = [
    `import { runInSlot } from ${JSON.stringify(modulePath)};`,
    `await runInSlot([process.execPath, ${JSON.stringify(modulePath)}, "--shards", "1"], ${JSON.stringify(lock)}, process.env, console.log);`,
  ].join("\n");
  const fd = openSync(log, "w");
  const helper = Bun.spawn([process.execPath, "-e", script], { stdout: fd, stderr: fd, env: process.env });
  await waitUntil(() => existsSync(log) && readFileSync(log, "utf8").includes("waiting for the unit slot"), "the helper to queue");
  helper.kill("SIGKILL");
  await helper.exited;
  process.kill(holder.pid, "SIGKILL");
  await waitUntil(
    () => readFileSync(log, "utf8").includes("the run that asked for the slot is gone, nothing run"),
    "the queued run to take the slot",
    10_000,
  );
  await waitUntil(
    () => Bun.spawnSync(["flock", "--nonblock", lock, "true"]).exitCode === 0,
    "the slot to be free again",
    10_000,
  );
});

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultShardCount,
  fileTimes,
  junitFileKey,
  parseArgs,
  planShards,
  readJunit,
  summaryLines,
  testFiles,
} from "./test-fast.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
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

test("defaultShardCount is half the parallelism, at most 12, at least 1", () => {
  expect(defaultShardCount(24)).toBe(12);
  expect(defaultShardCount(8)).toBe(4);
  expect(defaultShardCount(1)).toBe(1);
});

test("parseArgs: default shard count, --shards N, and the arguments after -- for bun test", () => {
  expect(parseArgs([], 24)).toEqual({ shards: 12, passThrough: [] });
  expect(parseArgs(["--shards", "3"], 24)).toEqual({ shards: 3, passThrough: [] });
  expect(parseArgs(["--shards", "2", "--", "--timeout", "5000"], 8)).toEqual({
    shards: 2,
    passThrough: ["--timeout", "5000"],
  });
});

test("parseArgs refuses a shard count that is not a whole number of 1 or more, and an unknown argument", () => {
  expect(() => parseArgs(["--shards", "0"], 8)).toThrow("--shards takes a whole number of 1 or more");
  expect(() => parseArgs(["--shards", "1.5"], 8)).toThrow("--shards takes a whole number of 1 or more");
  expect(() => parseArgs(["--bogus"], 8)).toThrow("unknown argument --bogus");
  expect(() => parseArgs(["--shards"], 8)).toThrow("--shards takes a whole number of 1 or more");
  expect(() => parseArgs(["--shards", "3", "extra"], 8)).toThrow("--shards takes a whole number of 1 or more");
});

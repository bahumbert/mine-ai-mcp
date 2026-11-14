import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Bun does not stop a test's body at its 5 s limit: it fails the test, starts the next one and lets the body run on
 * (quiet-machine plan Q7: a first test slow on a loaded machine installed its clock after its own limit, and the tests
 * after it read "fake clock already installed"). Only a child `bun test` can time a test out without failing this one,
 * and it runs at the top level, outside the 5 s of any body here (it takes about a second).
 */
const clockModule = fileURLToPath(new URL("./fake-clock.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "fake-clock-timeout-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Runs `source` as a child `bun test` and returns its junit report (written to `<fixtureName>.xml`). Bun 1.4.2 prints no
 * `(pass)` line under `CLAUDECODE=1`, so a test reads the report, which no environment variable changes.
 */
function childReport(fixtureName: string, source: string): string {
  const fixture = join(dir, fixtureName);
  const reportFile = join(dir, `${fixtureName}.xml`);
  writeFileSync(fixture, source);
  const child = spawnSync(process.execPath, ["test", fixture, "--reporter=junit", `--reporter-outfile=${reportFile}`], {
    cwd: dir,
    encoding: "utf8",
  });
  if (!existsSync(reportFile)) throw new Error(`the child bun test wrote no junit report (exit ${child.status}):\n${child.stdout}\n${child.stderr}`);
  return readFileSync(reportFile, "utf8");
}

/** Each case's name -> passed: a `<failure>` or `<error>` child marks a failed case. */
function casesOf(report: string): Map<string, boolean> {
  const cases = new Map<string, boolean>();
  for (const match of report.matchAll(/<testcase name="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/gu)) {
    const body = match[2] ?? "";
    cases.set(decodeXmlText(match[1] ?? ""), !/<(?:failure|error)\b/u.test(body));
  }
  return cases;
}

/** The case name -> passed of a child `bun test` run on `source` (see `childReport`). */
function childRun(fixtureName: string, source: string): Map<string, boolean> {
  return casesOf(childReport(fixtureName, source));
}

function decodeXmlText(text: string): string {
  return text.replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, "&");
}

test("a test that passes its time limit and installs its clock late does not block the tests after it", () => {
  const cases = childRun(
    "timed-out.test.ts",
    `
  import test from "node:test";
  import { createFakeClock } from ${JSON.stringify(clockModule)};
  const realSetTimeout = setTimeout;
  const realWait = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));
  test("slow before it installs, then waits on its clock", { timeout: 200 }, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    await realWait(500);
    using _installed = clock.install();
    await new Promise(() => undefined);
  });
  test("next test installs its own clock", async () => {
    const clock = createFakeClock({ mode: "mocked" });
    await realWait(500);
    using _installed = clock.install();
  });
  `,
  );
  assert.equal(cases.get("slow before it installs, then waits on its clock"), false, "the child's first test timed out");
  assert.equal(cases.get("next test installs its own clock"), true);
  assert.equal(cases.size, 2);
});

test("a clock never disposed fails its own test and leaves the next one clean", () => {
  const report = childReport(
    "never-disposed.test.ts",
    `
  import test from "node:test";
  import { createFakeClock } from ${JSON.stringify(clockModule)};
  test("installs and returns without disposing", () => {
    const clock = createFakeClock({ mode: "mocked" });
    clock.install();
  });
  test("the test after it installs its own clock", () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
  });
  `,
  );
  const cases = casesOf(report);
  assert.equal(cases.get("installs and returns without disposing"), false);
  assert.equal(cases.get("the test after it installs its own clock"), true);
  assert.match(report, /fake clock left installed/u);
});

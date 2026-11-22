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
/** The child runs in a temp dir, outside `bunfig.toml`: it loads the test start cleanup itself, and not `test-limit.ts`, which would override its `--timeout`. */
const testStartCleanupPreload = fileURLToPath(new URL("../../../scripts/test-clock-cleanup.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "fake-clock-timeout-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A fixture file of a child run: its file name in the temp dir, then its source. */
type Fixture = readonly [name: string, source: string];

// limit: a child `bun test` of these fixtures takes 1.24-1.47 s alone and 1.26-1.52 s beside a running `bun run test:fast` (load 21-32; 5 runs alone, 3 loaded; 2026-11-18); 5 x the worst 1.52 s, rounded up to a second. A test's own limit cannot stop a child stuck in a module body, so `spawnSync` kills it.
const CHILD_WATCHDOG_MS = 8_000;

/**
 * Runs `fixtures` as one child `bun test` and returns its junit report (written to `<first fixture name>.xml`). Bun 1.4.2
 * prints no `(pass)` line under `CLAUDECODE=1`, so a test reads the report, which no environment variable changes. A child
 * still running after `watchdogMs` is killed and fails the caller with its output, so a hung fixture never hangs the suite.
 */
function childReport(fixtures: readonly Fixture[], extraArgs: readonly string[] = [], watchdogMs: number = CHILD_WATCHDOG_MS): string {
  const files = fixtures.map(([name, source]) => {
    const file = join(dir, name);
    writeFileSync(file, source);
    return file;
  });
  const reportFile = join(dir, `${fixtures[0]?.[0] ?? "child"}.xml`);
  const child = spawnSync(process.execPath, ["test", ...files, ...extraArgs, "--reporter=junit", `--reporter-outfile=${reportFile}`], {
    cwd: dir,
    encoding: "utf8",
    timeout: watchdogMs,
    killSignal: "SIGKILL",
  });
  if ((child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || child.signal !== null) {
    throw new Error(`the child bun test passed its ${watchdogMs} ms watchdog:\n${child.stdout}\n${child.stderr}`);
  }
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

/** The case name -> passed of a child `bun test` run on `fixtures` (see `childReport`). */
function childRun(fixtures: readonly Fixture[], extraArgs: readonly string[] = []): Map<string, boolean> {
  return casesOf(childReport(fixtures, extraArgs));
}

function decodeXmlText(text: string): string {
  return text.replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, "&");
}

test("a test that passes its time limit and installs its clock late does not block the tests after it", () => {
  const cases = childRun([[
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
  ]]);
  assert.equal(cases.get("slow before it installs, then waits on its clock"), false, "the child's first test timed out");
  assert.equal(cases.get("next test installs its own clock"), true);
  assert.equal(cases.size, 2);
});

test("a test that passes its time limit with its clock installed leaves the next tests a clean clock", () => {
  // The child's limit is Bun's native one (the CLI `--timeout`, as the preload's `setDefaultTimeout` sets it), not a test's own `{ timeout }`.
  const cases = childRun([[
    "installed-then-timed-out.test.ts",
    `
  import test from "node:test";
  import { createFakeClock } from ${JSON.stringify(clockModule)};
  const realSetTimeout = setTimeout;
  const realWait = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));
  test("installs, then passes its limit on a real wait", async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    await realWait(500);
  });
  test("next test installs no clock and waits on a real timer", async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  test("next test installs its own clock", () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
  });
  test("a third test installs its own clock", () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
  });
  `,
  ]], ["--timeout", "200", "--preload", testStartCleanupPreload]);
  assert.equal(cases.get("installs, then passes its limit on a real wait"), false, "the child's first test passed its limit");
  assert.equal(cases.get("next test installs no clock and waits on a real timer"), true);
  assert.equal(cases.get("next test installs its own clock"), true);
  assert.equal(cases.get("a third test installs its own clock"), true);
  assert.equal(cases.size, 4);
});

test("bunfig.toml preloads the test start cleanup, or the fake clock is never restored in a real run", () => {
  assert.match(readFileSync(fileURLToPath(new URL("../../../bunfig.toml", import.meta.url)), "utf8"), /"\.\/scripts\/test-clock-cleanup\.ts"/u);
});

test("a clock never disposed fails its own test and leaves the next one clean", () => {
  const report = childReport([[
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
  ]]);
  const cases = casesOf(report);
  assert.equal(cases.get("installs and returns without disposing"), false);
  assert.equal(cases.get("the test after it installs its own clock"), true);
  assert.match(report, /fake clock left installed/u);
});

test("a child bun test that hangs fails the parent within its watchdog", () => {
  assert.throws(() => childReport([["hangs.test.ts", "for (;;) {}"]], [], 1_000), /passed its 1000 ms watchdog/u);
});

/**
 * A child run of the orphan-pump shape (C1, spec `2026-11-18-unit-reds`): test A has its own 200 ms limit and awaits a pump
 * that needs about 600 ms real (120 slices of 5 ms spin), so it is still running when A times out and would hit its `maxMs`
 * during B. The child has no `--timeout`: only A is short, B's 1 s real wait is inside the child's 5 s. B counts the slices
 * that ran during its wait; C installs its own clock after both.
 */
const pumpFixtureHeader = `
  import assert from "node:assert/strict";
  import test from "node:test";
  import { createFakeClock } from ${JSON.stringify(clockModule)};
  const realSetTimeout = setTimeout;
  const realWait = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));
  const spin = (ms: number) => { const end = Bun.nanoseconds() + ms * 1e6; while (Bun.nanoseconds() < end); };
  let slices = 0;
  const pumpClock = (mode: "mocked" | "manual") => {
    const clock = createFakeClock({ mode });
    clock.onSlice("physics", () => { slices += 1; spin(5); });
    return clock;
  };
`;

const pumpFixtureFollowers = `
  test("B waits a real second and no slice runs in it", async () => {
    const at = slices;
    await realWait(1_000);
    assert.ok(slices - at <= 1, slices - at + " slices ran during B");
  });
  test("C installs its own clock and settles", async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    assert.equal(await clock.settle(Promise.resolve(1), 1), 1);
  });
`;

/** The fixture file of `a-body` as test A (its own 200 ms limit), followed by B and C. */
function pumpFixture(aBody: string): string {
  return `${pumpFixtureHeader}
  test("A pumps past its own limit", { timeout: 200 }, async () => {
    ${aBody}
  });
  ${pumpFixtureFollowers}`;
}

const preloadCleanup: readonly string[] = ["--preload", testStartCleanupPreload];

for (const pump of [
  {
    name: "a timed-out mocked settle stops pumping and leaves the next tests green",
    body: `const clock = pumpClock("mocked"); using _installed = clock.install(); await clock.settle(new Promise(() => undefined), 6_000);`,
  },
  {
    name: "a timed-out manual settle stops pumping and leaves the next tests green",
    body: `const clock = pumpClock("manual"); await clock.settle(new Promise(() => undefined), 6_000);`,
  },
  {
    name: "a timed-out while loop over advance stops at its next await",
    body: `const clock = pumpClock("mocked"); using _installed = clock.install(); for (;;) await clock.advance(50);`,
  },
]) {
  test(pump.name, () => {
    const cases = childRun([["pump.test.ts", pumpFixture(pump.body)]], preloadCleanup);
    assert.equal(cases.get("A pumps past its own limit"), false, "A timed out on its own limit");
    assert.equal(cases.get("B waits a real second and no slice runs in it"), true);
    assert.equal(cases.get("C installs its own clock and settles"), true);
    assert.equal(cases.size, 3);
  });
}

test("an advance that finds the mock Date replaced under it retires its clock", () => {
  // The signal of Bun's reset of the mock timers between files (probe 2026-11-18, spec D1): `globalThis.Date` is no longer the mock's. The fixture puts the real Date back by hand, the one thing of that reset a test can do without `mock.timers`; A's own 200 ms limit is the time its advance has to finish.
  const cases = childRun([[
    "mock-date-replaced.test.ts",
    `
  import assert from "node:assert/strict";
  import test from "node:test";
  import { createFakeClock } from ${JSON.stringify(clockModule)};
  const realDate = globalThis.Date;
  let advanceOutcome = "still running";
  test("A replaces the mock Date under a running advance", { timeout: 200 }, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    globalThis.Date = realDate;
    clock.advance(50).then(() => { advanceOutcome = "advanced"; }, (error: Error) => { advanceOutcome = "threw: " + error.message; });
    await new Promise(() => undefined);
  });
  test("B sees the advance neither finish nor throw", () => {
    assert.equal(advanceOutcome, "still running");
  });
  test("C installs its own clock and settles", async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    assert.equal(await clock.settle(Promise.resolve(1), 1), 1);
  });
  `,
  ]], preloadCleanup);
  assert.equal(cases.get("A replaces the mock Date under a running advance"), false, "A timed out on its own limit");
  assert.equal(cases.get("B sees the advance neither finish nor throw"), true);
  assert.equal(cases.get("C installs its own clock and settles"), true);
  assert.equal(cases.size, 3);
});

test("a timed-out last test of a file leaves the next file's tests all run and green", () => {
  // File 2 awaits real time at its top level, as a module with slow imports does: Bun resets the mock timers between files in that gap, before file 2's first test starts the preload.
  const firstFile = `${pumpFixtureHeader}
  test("passes first", () => {});
  test("A pumps past its own limit", { timeout: 200 }, async () => {
    const clock = pumpClock("mocked");
    using _installed = clock.install();
    await clock.settle(new Promise(() => undefined), 6_000);
  });`;
  const secondFile = `
  import test from "node:test";
  const realSetTimeout = setTimeout;
  const realWait = (ms: number) => new Promise((resolve) => realSetTimeout(resolve, ms));
  await realWait(300);
  for (const n of [1, 2, 3]) test("second file test " + n, async () => { await realWait(300); });
  `;
  const cases = childRun([["first-file.test.ts", firstFile], ["second-file.test.ts", secondFile]], preloadCleanup);
  assert.equal(cases.get("passes first"), true);
  assert.equal(cases.get("A pumps past its own limit"), false, "A timed out on its own limit");
  for (const n of [1, 2, 3]) assert.equal(cases.get(`second file test ${n}`), true, `second file test ${n}`);
  assert.equal(cases.size, 5);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Bun does not stop a test's body at its 5 s limit: it fails the test, starts the next one and lets the body run on
 * (quiet-machine plan Q7: a first test slow on a loaded machine installed its clock after its own limit, and the tests
 * after it read "fake clock already installed"). Only a child `bun test` can time a test out without failing this one,
 * and it runs at the top level, outside the 5 s of any body here (it takes about a second).
 */
const clockModule = fileURLToPath(new URL("./fake-clock.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "fake-clock-timeout-"));
writeFileSync(
  join(dir, "timed-out.test.ts"),
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
const child = spawnSync(process.execPath, ["test", join(dir, "timed-out.test.ts")], { cwd: dir, encoding: "utf8" });
rmSync(dir, { recursive: true, force: true });
const report = `${child.stdout}\n${child.stderr}`;

test("a test that passes its time limit and installs its clock late does not block the tests after it", () => {
  assert.match(report, /\(fail\) slow before it installs/u, "the child's first test timed out");
  assert.match(report, /\(pass\) next test installs its own clock/u, report);
});

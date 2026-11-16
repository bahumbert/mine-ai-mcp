import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { isWritableDirectory, TEST_TMPFS_DIRECTORY, useTmpfsForTests } from "./test-tmpfs.js";

/** A machine with a writable `/dev/shm` (Linux, WSL2) runs the tests' temporary folders there; the skip names that machine condition (T9). */
const hasWritableTmpfs = isWritableDirectory(TEST_TMPFS_DIRECTORY);
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PROBE_TEST_SOURCE = (reportFile: string): string =>
  `import { test } from "bun:test";\nimport { writeFileSync } from "node:fs";\nimport { tmpdir } from "node:os";\n` +
  `test("reports its tmpdir", () => { writeFileSync(${JSON.stringify(reportFile)}, tmpdir()); });\n`;

/**
 * The `tmpdir()` a child `bun test` reports, run from the repository root so its `bunfig.toml` preload applies. The
 * child gets this process's environment without `TMPDIR`, plus `tmpdirEnv` as `TMPDIR` when given. Its answer comes
 * through a file the probe writes, not its console output (T11). Measured 2026-11-16: about 0.3 s per child.
 */
function childTmpdir(tmpdirEnv: string | undefined): string {
  const sandbox = mkdtempSync(path.join(tmpdir(), "test-tmpfs-child-"));
  try {
    const probe = path.join(sandbox, "probe.test.ts");
    const report = path.join(sandbox, "tmpdir.txt");
    writeFileSync(probe, PROBE_TEST_SOURCE(report));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key !== "TMPDIR" && value !== undefined) env[key] = value;
    }
    if (tmpdirEnv !== undefined) env.TMPDIR = tmpdirEnv;
    const run = Bun.spawnSync([process.execPath, "test", probe], { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    if (run.exitCode !== 0) throw new Error(`child bun test exited ${run.exitCode}: ${run.stderr.toString()}`);
    return readFileSync(report, "utf8");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test.skipIf(!hasWritableTmpfs)("a child bun test with the repository's preload and no TMPDIR gets this user's folder on /dev/shm", () => {
  expect(childTmpdir(undefined)).toBe(path.join(TEST_TMPFS_DIRECTORY, `mine-ai-tests-${process.getuid?.()}`));
});

test("a child bun test with its own TMPDIR keeps it", () => {
  const own = mkdtempSync(path.join(tmpdir(), "test-tmpfs-own-"));
  try {
    expect(childTmpdir(own)).toBe(own);
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
});

test("a TMPDIR the environment already sets is left as it is", () => {
  const env: Record<string, string | undefined> = { TMPDIR: "/some/where" };
  expect(useTmpfsForTests(env)).toBeUndefined();
  expect(env.TMPDIR).toBe("/some/where");
});

test.skipIf(!hasWritableTmpfs)("an unset TMPDIR becomes this user's 0700 folder on /dev/shm", () => {
  const env: Record<string, string | undefined> = {};
  const folder = useTmpfsForTests(env);
  expect(folder).toBe(path.join(TEST_TMPFS_DIRECTORY, `mine-ai-tests-${process.getuid?.()}`));
  expect(env.TMPDIR).toBe(folder);
  expect(statSync(folder!).mode & 0o777).toBe(0o700);
});

test("without a writable directory the TMPDIR stays unset", () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "test-tmpfs-"));
  try {
    const plainFile = path.join(sandbox, "not-a-folder");
    writeFileSync(plainFile, "");
    const env: Record<string, string | undefined> = {};
    expect(useTmpfsForTests(env, { directory: path.join(sandbox, "missing"), uid: 4242 })).toBeUndefined();
    expect(useTmpfsForTests(env, { directory: plainFile, uid: 4242 })).toBeUndefined();
    expect(env.TMPDIR).toBeUndefined();
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a real folder of this user where the user's folder should be is used", () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "test-tmpfs-"));
  try {
    const uid = process.getuid?.() ?? 0;
    mkdirSync(path.join(sandbox, `mine-ai-tests-${uid}`), { mode: 0o700 });
    const env: Record<string, string | undefined> = {};
    expect(useTmpfsForTests(env, { directory: sandbox, uid })).toBe(path.join(sandbox, `mine-ai-tests-${uid}`));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a symlink where the user's folder should be is not followed, and its target is left alone", () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "test-tmpfs-"));
  try {
    const uid = process.getuid?.() ?? 0;
    const elsewhere = path.join(sandbox, "elsewhere");
    const shared = path.join(sandbox, "shared");
    mkdirSync(elsewhere);
    chmodSync(elsewhere, 0o755);
    mkdirSync(shared);
    symlinkSync(elsewhere, path.join(shared, `mine-ai-tests-${uid}`));
    const env: Record<string, string | undefined> = {};
    expect(useTmpfsForTests(env, { directory: shared, uid })).toBeUndefined();
    expect(env.TMPDIR).toBeUndefined();
    expect(statSync(elsewhere).mode & 0o777).toBe(0o755);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

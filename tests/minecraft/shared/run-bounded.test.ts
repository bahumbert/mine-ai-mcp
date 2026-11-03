import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBounded } from "./run-bounded.ts";

async function withTemp(body: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "run-bounded-"));
  try { await body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Whether the process still exists (signal 0 only checks). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, boundMs: number): Promise<boolean> {
  const deadline = performance.now() + boundMs;
  while (isAlive(pid) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  return !isAlive(pid);
}

test("runBounded returns the exit code and the tail of stderr", async () => withTemp(async dir => {
  const result = await runBounded("sh", ["-c", "echo line-one >&2; echo line-two >&2; exit 3"], { cwd: dir, boundMs: 5_000 });
  assert.equal(result.code, 3);
  assert.equal(result.timedOut ?? false, false);
  assert.match(result.stderrTail, /line-two/u);
}));

test("runBounded kills a child that outlives its bound and says so", async () => withTemp(async dir => {
  const started = performance.now();
  const result = await runBounded("sleep", ["30"], { cwd: dir, boundMs: 150 });
  assert.equal(result.timedOut, true);
  assert.ok(performance.now() - started < 5_000, "the child was killed at the bound, not waited for");
}));

test("runBounded settles at the bound even when a grandchild of the child still holds its stderr", async () => withTemp(async dir => {
  const started = performance.now();
  const result = await runBounded("sh", ["-c", "sleep 6; true"], { cwd: dir, boundMs: 150 });
  assert.equal(result.timedOut, true);
  assert.ok(performance.now() - started < 2_000, "the whole process group was killed at the bound");
}));

test("runBounded on a command that does not exist answers a failure, not a rejection", async () => withTemp(async dir => {
  const result = await runBounded("mine-ai-no-such-command", [], { cwd: dir, boundMs: 1_000 });
  assert.notEqual(result.code, 0);
  assert.match(result.stderrTail, /mine-ai-no-such-command/u, "the failure names the command the daemon log must show");
}));

test("an abort kills the child's whole group (a grandchild sleep 60 too) and answers aborted", async () => withTemp(async dir => {
  const pidFile = join(dir, "grandchild.pid");
  const controller = new AbortController();
  const running = runBounded("sh", ["-c", `sleep 60 & echo $! > ${pidFile}; wait`], { cwd: dir, boundMs: 30_000, signal: controller.signal });
  const deadline = performance.now() + 5_000;
  let grandchild = 0;
  while (grandchild === 0 && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
    try { grandchild = Number(readFileSync(pidFile, "utf8").trim()) || 0; } catch { /* not written yet */ }
  }
  assert.ok(grandchild > 0, "the grandchild started");
  const started = performance.now();
  controller.abort();
  const result = await running;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut ?? false, false);
  assert.ok(performance.now() - started < 2_000, "the abort settled at once, not at the bound");
  assert.ok(await waitUntilGone(grandchild, 2_000), "the grandchild is gone with its group");
}));

test("an already aborted signal spawns nothing and answers aborted at once", async () => withTemp(async dir => {
  const marker = join(dir, "ran");
  const controller = new AbortController();
  controller.abort();
  const result = await runBounded("sh", ["-c", `echo ran > ${marker}`], { cwd: dir, boundMs: 5_000, signal: controller.signal });
  assert.equal(result.aborted, true);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => readFileSync(marker), /ENOENT/u, "the command never started");
}));

test("a child that ended by itself leaves no abort listener on the signal", async () => withTemp(async dir => {
  const controller = new AbortController();
  const result = await runBounded("sh", ["-c", "exit 0"], { cwd: dir, boundMs: 5_000, signal: controller.signal });
  assert.equal(result.code, 0);
  assert.equal(result.aborted, undefined);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0, "the abort listener is removed when the child ends");
}));

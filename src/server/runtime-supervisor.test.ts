import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { RUNTIME_RESTART_WINDOW_MS } from "./runtime-liveness.js";
import { startMcpSupervisor } from "./runtime-supervisor.js";

const executable = process.execPath;
const args = [...process.execArgv, fileURLToPath(new URL("../test-support/wedged-runtime.ts", import.meta.url))];

/**
 * A supervisor over the wedged-runtime fixture, with its own incident
 * directory, closed and removed when the test finishes. `launch` replaces the
 * child command, for the case where the runtime cannot start at all.
 */
async function supervised(
  t: TestContext,
  instanceId: string,
  launch?: (directory: string) => { executable: string; args: string[] },
  deadlines?: { startupMs: number; unresponsiveMs: number },
  restartWindowMs = 0, // The older tests look at the failed state, so they run without a restart.
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `mcp-watchdog-${instanceId}-`));
  const child = launch?.(directory) ?? { executable, args };
  const supervisor = await startMcpSupervisor({
    ...child,
    host: "127.0.0.1",
    port: 0,
    instanceId,
    source: { kind: "unavailable", reason: "test fixture" },
    incidents: { directory, retention: { days: 1, maxBytes: 1024 * 1024 } },
    deadlines,
    restartWindowMs,
  });
  t.after(async () => {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  });
  const address = supervisor.server.address();
  assert.ok(address && typeof address !== "string");
  return { supervisor, url: `http://127.0.0.1:${address.port}` };
}

/** Every test acts only once the runtime is answering for itself. */
async function whenHealthy(url: string): Promise<void> {
  while (!(await fetch(`${url}/health`)).ok) await delay(20);
}

test(
  "a shared scheduling pause gets a fresh liveness window when the supervisor resumes",
  { timeout: 15_000 },
  async (t) => {
    const { url } = await supervised(t, "observer-stall");
    await whenHealthy(url);
    await delay(350);
    assert.equal(await (await fetch(`${url}/pause`)).text(), "accepted");
    // Pause both loops, with the child resuming half a second later. The
    // supervisor cannot diagnose a child-only hang during its own blind gap.
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);
        resolve();
      }, 100),
    );
    await delay(1000);

    assert.equal((await fetch(`${url}/health`)).status, 200);
    const diagnostics = await (await fetch(`${url}/diagnostics/runtime`)).json();
    assert.ok(
      diagnostics.heartbeatAgeMs < 1000,
      "Fresh child heartbeats must resume after the supervisor can observe them.",
    );
  },
);

test(
  "retains active request and restored phase after the client and entry event are gone",
  { timeout: 40_000 },
  async (t) => {
    const { url } = await supervised(t, "attribution");
    await whenHealthy(url);
    assert.equal(await (await fetch(`${url}/background`)).text(), "accepted");
    await delay(350);
    const diagnostics = await (await fetch(`${url}/diagnostics/runtime`)).json();
    assert.equal(diagnostics.activity.active[0].owner.requestId, 812);
    assert.ok(diagnostics.heartbeat.memory.rss > 0);

    // Outlast the liveness window so the supervisor declares the failure itself.
    await delay(21_500);

    assert.equal((await fetch(`${url}/health`)).status, 503);
    const status = await (await fetch(`${url}/health`)).json();
    const reference = status.runtime.failure.incident;
    assert.equal(status.runtime.failure.actionId, "background-action-812");
    assert.equal(status.runtime.failure.activity.active[0].owner.requestId, 812);
    assert.equal(reference.requestId, 812);
    const records = (await readFile(reference.artifact.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records[0].requestId, 812);
    assert.ok(!records.some((row) => row.kind === "execution"), "The original transitions have aged out.");
    const failure = records.find((row) => row.kind === "runtime_failure");
    assert.equal(failure.activity.active.length, 1);
    assert.equal(failure.activity.active[0].owner.operation, "navigate");
    assert.equal(failure.activity.active[0].activePhase, "route", "Nested return must restore the outer phase.");
    assert.ok(
      failure.pending.every(
        (entry: { tool: string | null; path: string }) => entry.tool === null && entry.path === "/health",
      ),
    );
  },
);

for (const fault of ["hang", "microtask", "sse-hang", "crash"] as const) {
  test(`supervisor returns a saved failure when the runtime ${fault}s`, { timeout: 20_000 }, async (t) => {
    const { url } = await supervised(t, fault);
    await whenHealthy(url);

    const response = await fetch(`${url}/${fault}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 73, method: "tools/call", params: { name: fault } }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, "MCP errors must remain protocol responses, not transport errors.");
    assert.match(body, fault === "crash" ? /RUNTIME_EXITED/ : /RUNTIME_UNRESPONSIVE/);
    assert.match(body, /"id":73/);

    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 503);
    const status = await health.json();
    assert.equal(status.runtime.state, "failed");
    assert.ok(Number.isFinite(Date.parse(status.runtime.failure.observedAt)));
    assert.match(status.runtime.failure.message, /runtime has been stopped and requires a restart/);
    assert.equal(status.runtime.failure.incident.artifact.kind, "written");
    const incident = await readFile(status.runtime.failure.incident.artifact.path, "utf8");
    assert.match(incident, /runtime_failure/);
    assert.match(incident, /"tool":"(?:hang|microtask|sse-hang|crash)"/);
    if (fault !== "crash") assert.match(incident, /fault_injection/);

    const subsequent = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 74, method: "tools/list" }),
    });
    assert.equal(subsequent.status, 200);
    assert.match(await subsequent.text(), /"id":74/);
  });
}

test("a long operation with a live event loop is not timed out", { timeout: 15_000 }, async (t) => {
  const { supervisor, url } = await supervised(t, "healthy");
  await whenHealthy(url);

  const cancellation = new AbortController();
  const cancelled = fetch(`${url}/slow`, { signal: cancellation.signal });
  await delay(50);
  cancellation.abort();
  await assert.rejects(cancelled);

  assert.equal((await fetch(`${url}/health`)).status, 200, "Client cancellation must not kill a healthy runtime.");
  assert.equal(await (await fetch(`${url}/slow`)).text(), "finished");
  assert.equal((await fetch(`${url}/health`)).status, 200);
  await supervisor.close();
  assert.ok(supervisor.child.exitCode !== null || supervisor.child.signalCode !== null, "close must reap its runtime.");
});

test("a runtime launch failure stays observable and can be closed", { timeout: 5000 }, async (t) => {
  const { supervisor, url } = await supervised(t, "launch-failure", (directory) => ({
    executable: path.join(directory, "missing-runtime-executable"),
    args: [],
  }));

  let body: string;
  do {
    await delay(20);
    body = await (await fetch(`${url}/health`)).text();
  } while (!body.includes('"state":"failed"'));
  assert.match(body, /RUNTIME_EXITED/);

  await Promise.all([supervisor.close(), supervisor.close()]);
});

const slowStart = (blockMs: number) => (): { executable: string; args: string[] } => ({
  executable,
  args: [...process.execArgv, fileURLToPath(new URL("../test-support/slow-start-runtime.ts", import.meta.url)), String(blockMs)],
});

test("a runtime silent before ready for longer than the heartbeat deadline is not killed", { timeout: 15_000 }, async (t) => {
  // Live 2026-10-11: a host was killed at start while its module graph loaded.
  const { url } = await supervised(t, "slow-start", slowStart(1_500), { startupMs: 4_000, unresponsiveMs: 1_000 });
  await whenHealthy(url);
  assert.equal((await fetch(`${url}/health`)).status, 200);
});

test("a runtime silent past the startup deadline before ready is killed as unresponsive", { timeout: 15_000 }, async (t) => {
  const { url } = await supervised(t, "stuck-start", slowStart(8_000), { startupMs: 2_000, unresponsiveMs: 1_000 });
  let body: string;
  do {
    await delay(100);
    body = await (await fetch(`${url}/health`)).text();
  } while (!body.includes('"state":"failed"'));
  assert.match(body, /RUNTIME_UNRESPONSIVE/);
});

const mcpCall = (url: string, id: number, tool: string) =>
  fetch(`${url}/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool } }),
  });
const fastDeadlines = { startupMs: 10_000, unresponsiveMs: 1_000 };
const stateOf = async (url: string): Promise<string> => (await (await fetch(`${url}/diagnostics/runtime`)).json()).state;

test("a runtime killed as unresponsive is started again and answers", { timeout: 25_000 }, async (t) => {
  const { url } = await supervised(t, "restart", undefined, fastDeadlines, RUNTIME_RESTART_WINDOW_MS);
  await whenHealthy(url);
  assert.match(await (await mcpCall(url, 90, "hang")).text(), /RUNTIME_UNRESPONSIVE/, "the call that met the hang is answered with the failure");
  while ((await fetch(`${url}/health`)).status !== 200) await delay(50);
  assert.equal(await stateOf(url), "ready");
});

test("a second failure inside the restart window stays down and says it restarted before", { timeout: 25_000 }, async (t) => {
  const { url } = await supervised(t, "restart-twice", undefined, fastDeadlines, RUNTIME_RESTART_WINDOW_MS);
  await whenHealthy(url);
  await mcpCall(url, 91, "hang");
  while ((await fetch(`${url}/health`)).status !== 200) await delay(50);
  assert.match(await (await mcpCall(url, 92, "hang")).text(), /RUNTIME_UNRESPONSIVE/);
  await delay(1_500);
  const health = await fetch(`${url}/health`);
  assert.equal(health.status, 503);
  const status = await health.json();
  assert.equal(status.runtime.state, "failed");
  assert.match(await readFile(status.runtime.failure.incident.artifact.path, "utf8"), /runtime_restarted/);
  const afterwards = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 93, method: "tools/list" }),
  });
  assert.match(await afterwards.text(), /RUNTIME_UNRESPONSIVE/);
});

test("a supervisor stopped during a restart leaves no runtime behind", { timeout: 25_000 }, async (t) => {
  const { supervisor, url } = await supervised(t, "restart-stop", undefined, fastDeadlines, RUNTIME_RESTART_WINDOW_MS);
  await whenHealthy(url);
  await mcpCall(url, 95, "hang");
  const restarted = supervisor.child;
  await supervisor.close();
  assert.ok(restarted.exitCode !== null || restarted.signalCode !== null, "close must reap the restarted runtime");
});

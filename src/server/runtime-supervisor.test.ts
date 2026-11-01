import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test, { type TestContext } from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { blockThread } from "../test-support/block-thread.js";
import { RUNTIME_RESTART_WINDOW_MS } from "./runtime-liveness.js";
import { INCIDENT_HISTORY_MS } from "../diagnostics/incident-recorder.js";
import { startMcpSupervisor, type McpSupervisorOptions } from "./runtime-supervisor.js";

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
  deadlines?: McpSupervisorOptions["deadlines"],
  restartWindowMs = 0, // The older tests look at the failed state, so they run without a restart.
  incidentHistoryMs?: number,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `mcp-watchdog-${instanceId}-`));
  const child = launch?.(directory) ?? { executable, args };
  // The child's own property descriptors, so a launch with a getter is read again at every start, as a real option is.
  const options = Object.defineProperties(
    {
      host: "127.0.0.1",
      port: 0,
      instanceId,
      source: { kind: "unavailable", reason: "test fixture" },
      incidents: { directory, retention: { days: 1, maxBytes: 1024 * 1024 } },
      deadlines,
      restartWindowMs,
      incidentHistoryMs,
    },
    Object.getOwnPropertyDescriptors(child),
  ) as McpSupervisorOptions;
  const supervisor = await startMcpSupervisor(options);
  t.after(async () => {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  });
  const address = supervisor.server.address();
  assert.ok(address && typeof address !== "string");
  return { supervisor, url: `http://127.0.0.1:${address.port}`, directory };
}

/** The wedged runtime with child-side waits shortened (`--pause-ms=<ms>`, `--slow-ms=<ms>`). */
const wedgedWith = (...waits: string[]) => (): { executable: string; args: string[] } => ({ executable, args: [...args, ...waits] });

/** Deadlines short enough for a test: a hang is declared after one second of silence instead of five. */
const fastDeadlines = { startupMs: 10_000, unresponsiveMs: 1_000 };

/** Every test acts only once the runtime is answering for itself. */
async function whenHealthy(url: string): Promise<void> {
  while (!(await fetch(`${url}/health`)).ok) await delay(20);
}

/**
 * Waits for the supervisor's `failed` state and returns its `/health` answer. A 503 alone is not enough: it also covers
 * `failing`, where the failure and its incident are not saved yet. The wait is bounded by the test's own timeout.
 */
async function whenFailed(url: string, pollMs = 100) {
  while (true) {
    const response = await fetch(`${url}/health`);
    const status = await response.json();
    if (status.runtime?.state === "failed") return { httpStatus: response.status, status };
    await delay(pollMs);
  }
}

/**
 * The diagnostics once the runtime has reported an active scope and a heartbeat: it sends them on its own timers (the
 * heartbeat every 250 ms), so a fixed wait can read them too early. Bounded by the test's own timeout.
 */
async function whenReported(url: string) {
  while (true) {
    const diagnostics = await (await fetch(`${url}/diagnostics/runtime`)).json();
    if (diagnostics.heartbeat && diagnostics.activity?.active.length) return diagnostics;
    await delay(50);
  }
}

/** Heartbeats the supervisor read in its first moments after its own pause were sent before the runtime paused: stale. */
const STALE_HEARTBEAT_WINDOW_MS = 250;

/**
 * The runtime's diagnostics once it has sent a heartbeat that the supervisor received after `staleBefore` (a
 * `performance.now()` reading: the supervisor runs in the test's process), or once the supervisor has declared it
 * `failed` (it then ignores the runtime's messages for good, so no heartbeat would come). A heartbeat sent before the
 * runtime's pause is drained at the supervisor's resume and must not count as the runtime being back; a fixed wait
 * reads too early or accepts it. Bounded by the test's own timeout.
 */
async function whenHeartbeatReceivedAfter(url: string, staleBefore: number) {
  while (true) {
    const diagnostics = await (await fetch(`${url}/diagnostics/runtime`)).json();
    const receivedAt = performance.now() - diagnostics.heartbeatAgeMs;
    if (diagnostics.state === "failed" || (diagnostics.heartbeat && receivedAt > staleBefore)) return diagnostics;
    await delay(50);
  }
}

/** The supervisor pauses itself for `SUPERVISOR_PAUSE_MS`, starting `SUPERVISOR_PAUSE_DELAY_MS` after the runtime's `/pause` was accepted (the runtime's own pause starts 100 ms after it). */
const SUPERVISOR_PAUSE_MS = 2_500;
const SUPERVISOR_PAUSE_DELAY_MS = 100;
/** The liveness deadline of the two pause tests below. */
const PAUSE_TEST_UNRESPONSIVE_MS = 1_500;

/**
 * The runtime pauses `pauseMs` from its `/pause` and the supervisor itself 2.5 s from 100 ms later, so the supervisor
 * resumes `pauseMs` - 2.6 s before the runtime does. Returns the diagnostics once the runtime is back or failed. Both
 * pauses are on the monotonic clock (`blockThread`): a wall-clock pause is stretched ~2 s by WSL's clock steps and made
 * this test fail once in ~70 runs (2026-10-30).
 */
async function pauseBothLoopsUntilRuntimeBack(url: string) {
  assert.equal(await (await fetch(`${url}/pause`)).text(), "accepted");
  await new Promise<void>((resolve) =>
    setTimeout(() => {
      blockThread(SUPERVISOR_PAUSE_MS);
      resolve();
    }, SUPERVISOR_PAUSE_DELAY_MS),
  );
  return whenHeartbeatReceivedAfter(url, performance.now() + STALE_HEARTBEAT_WINDOW_MS);
}

test(
  "a shared scheduling pause gets a fresh liveness window when the supervisor resumes",
  { timeout: 15_000 },
  async (t) => {
    // The child pauses 3 s, the supervisor 2.5 s: past its 1.5 s deadline, so it sees its own blind gap. The child
    // resumes half a second after it, inside the fresh 1.5 s window. The supervisor cannot diagnose a child-only hang
    // during its own blind gap.
    const { url } = await supervised(t, "observer-stall", wedgedWith("--pause-ms=3000"), { startupMs: 10_000, unresponsiveMs: PAUSE_TEST_UNRESPONSIVE_MS });
    await whenHealthy(url);

    const diagnostics = await pauseBothLoopsUntilRuntimeBack(url);

    assert.equal(diagnostics.state, "ready", "The supervisor must not blame the child for its own blind gap.");
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.ok(
      diagnostics.heartbeatAgeMs < 1000,
      "Fresh child heartbeats must resume after the supervisor can observe them.",
    );
  },
);

test(
  "a runtime still paused when the fresh liveness window after the supervisor's blind gap ends is declared hung",
  { timeout: 15_000 },
  async (t) => {
    // The child pauses 5 s: 2.4 s after the supervisor resumes, past the fresh 1.5 s window.
    const { url } = await supervised(t, "observer-stall-hang", wedgedWith("--pause-ms=5000"), { startupMs: 10_000, unresponsiveMs: PAUSE_TEST_UNRESPONSIVE_MS });
    await whenHealthy(url);

    const pausedAt = performance.now();
    const diagnostics = await pauseBothLoopsUntilRuntimeBack(url);
    const failedSeenAfterMs = performance.now() - pausedAt;

    assert.equal(diagnostics.state, "failed");
    const { runtime } = await (await fetch(`${url}/health`)).json();
    assert.equal(runtime.failure.code, "RUNTIME_UNRESPONSIVE");
    // Timed here, not read from the message ("absent for N ms" counts from the last heartbeat the supervisor holds, and
    // one drained at its resume is as late as the resume itself): the failure may come no sooner than the supervisor's
    // own pause plus the fresh window after it, whichever heartbeat it holds.
    const freshWindowEndsMs = SUPERVISOR_PAUSE_DELAY_MS + SUPERVISOR_PAUSE_MS + PAUSE_TEST_UNRESPONSIVE_MS;
    assert.ok(failedSeenAfterMs >= freshWindowEndsMs, `Declared after the fresh window (${freshWindowEndsMs} ms after the pause), not at the first tick: failed seen after ${Math.round(failedSeenAfterMs)} ms.`);
  },
);

/** The attribution test's incident ring age, short so the rows age out in seconds; the child waits it too (`--history-ms`). */
const SHORT_HISTORY_MS = 3_000;

test(
  "retains active request and restored phase after the client and entry event are gone",
  { timeout: 15_000 },
  async (t) => {
    const { url } = await supervised(
      t,
      "attribution",
      wedgedWith(`--history-ms=${SHORT_HISTORY_MS}`),
      fastDeadlines,
      0,
      SHORT_HISTORY_MS,
    );
    await whenHealthy(url);
    assert.equal(await (await fetch(`${url}/background`)).text(), "accepted");
    const diagnostics = await whenReported(url);
    assert.equal(diagnostics.activity.active[0].owner.requestId, 812);
    assert.ok(diagnostics.heartbeat.memory.rss > 0);

    // The runtime wedges on its own timer, after the ring's age; the supervisor then declares the failure itself.
    const { httpStatus, status } = await whenFailed(url);

    assert.equal(httpStatus, 503);
    const reference = status.runtime.failure.incident;
    assert.equal(status.runtime.failure.actionId, "background-action-812");
    assert.equal(status.runtime.failure.activity.active[0].owner.requestId, 812);
    assert.equal(reference.requestId, 812);
    const records = (await readFile(reference.artifact.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records[0].requestId, 812);
    assert.equal(records[0].history.durationMs, SHORT_HISTORY_MS, "The option reaches the supervisor's ring.");
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
  test(`supervisor returns a saved failure when the runtime ${fault}s`, { timeout: 8_000 }, async (t) => {
    const { url } = await supervised(t, fault, undefined, fastDeadlines);
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
    assert.equal(
      JSON.parse(incident.split("\n")[0]).history.durationMs,
      INCIDENT_HISTORY_MS,
      "Without the option the ring keeps production's age.",
    );
    assert.equal(INCIDENT_HISTORY_MS, 20_000);
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

test("a long operation with a live event loop is not timed out", { timeout: 8_000 }, async (t) => {
  // The operation (2 s) outlasts the silence deadline (1 s).
  const { supervisor, url } = await supervised(t, "healthy", wedgedWith("--slow-ms=2000"), fastDeadlines);
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

  const { status } = await whenFailed(url, 20);
  assert.match(JSON.stringify(status), /RUNTIME_EXITED/);

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
  const { status } = await whenFailed(url);
  assert.match(JSON.stringify(status), /RUNTIME_UNRESPONSIVE/);
});

const mcpCall = (url: string, id: number, tool: string) =>
  fetch(`${url}/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool } }),
  });
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

/** A runtime that reports ready on a port nobody serves and then ignores SIGTERM, as a runtime whose own close hangs. */
const sigtermIgnoringRuntime = (): { executable: string; args: string[] } => ({
  executable,
  args: ["-e", 'process.on("SIGTERM", () => {}); process.once("disconnect", () => process.exit(0)); process.send({ kind: "ready", port: 1 }); setInterval(() => {}, 1_000);'],
});

test("a runtime that ignores SIGTERM is killed once the kill grace has passed", { timeout: 8_000 }, async (t) => {
  const { supervisor, url } = await supervised(t, "kill-grace", sigtermIgnoringRuntime, { startupMs: 60_000, unresponsiveMs: 60_000, killGraceMs: 200 });
  while ((await stateOf(url)) !== "ready") await delay(20);
  const closing = performance.now();
  await supervisor.close();
  const closedAfterMs = performance.now() - closing;
  assert.ok(closedAfterMs < 2_000, `close took ${Math.round(closedAfterMs)} ms with a 200 ms kill grace`);
});

test("the watchdog judges the runtime only on its own ticks, every heartbeatMs", { timeout: 8_000 }, async (t) => {
  const started = performance.now(); // Before the supervisor starts: its first tick comes 3 s later at the earliest.
  // A watchdog interval past the silence deadline: a gap of one interval is the watchdog's own rhythm, not a blind gap.
  const { url } = await supervised(t, "heartbeat-interval", undefined, { startupMs: 10_000, unresponsiveMs: 500, heartbeatMs: 3_000 });
  await whenHealthy(url);
  assert.match(await (await mcpCall(url, 98, "hang")).text(), /RUNTIME_UNRESPONSIVE/);
  const declaredAfterMs = performance.now() - started;
  assert.ok(declaredAfterMs >= 2_950, `the hang was declared ${Math.round(declaredAfterMs)} ms after start, before the first 3 s tick`);
});

test("a supervisor stopped during a restart leaves no runtime behind", { timeout: 25_000 }, async (t) => {
  const { supervisor, url } = await supervised(t, "restart-stop", undefined, fastDeadlines, RUNTIME_RESTART_WINDOW_MS);
  await whenHealthy(url);
  await mcpCall(url, 95, "hang");
  const restarted = supervisor.child;
  await supervisor.close();
  assert.ok(restarted.exitCode !== null || restarted.signalCode !== null, "close must reap the restarted runtime");
});

const faultingRuntime = (...mode: string[]) => (): { executable: string; args: string[] } => ({
  executable,
  args: [...process.execArgv, fileURLToPath(new URL("../test-support/faulting-runtime.ts", import.meta.url)), ...mode],
});
const aFault = (message: string) => ({ kind: "unhandled_rejection" as const, message, stack: null, observedAt: new Date().toISOString(), repeats: 0 });

type IncidentRecord = Record<string, any>;
/** The records of each incident file in the directory that holds a `process_fault` record, waited for up to 5 s. */
async function processFaultIncidents(directory: string, wanted = 1): Promise<IncidentRecord[][]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const incidents: IncidentRecord[][] = [];
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      const records: IncidentRecord[] = (await readFile(path.join(directory, name), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      if (records.some((row) => row.kind === "process_fault")) incidents.push(records);
    }
    if (incidents.length >= wanted || Date.now() > deadline) return incidents;
    await delay(50);
  }
}

test("a fault message from the runtime records a process_fault incident", { timeout: 15_000 }, async (t) => {
  const { url, directory } = await supervised(t, "fault-ready", faultingRuntime());
  await whenHealthy(url);
  await fetch(`${url}/fault`);

  const [incident] = await processFaultIncidents(directory);
  assert.ok(incident, "an incident with a process_fault record was written");
  const record = incident.find((row) => row.kind === "process_fault")!;
  assert.equal(record.fault.message, "raised while ready");
  assert.equal(record.origin, "runtime");
  assert.equal((await fetch(`${url}/health`)).status, 200, "a fault is recorded, the runtime keeps serving");
  assert.equal(await stateOf(url), "ready");
});

test("a fault while an action runs names that request in the incident", { timeout: 15_000 }, async (t) => {
  const { url, directory } = await supervised(t, "fault-request", faultingRuntime());
  await whenHealthy(url);
  await fetch(`${url}/fault-during-request`);

  const [incident] = await processFaultIncidents(directory);
  assert.equal(incident?.[0]?.requestId, 812);
});

test("a fault reported before the runtime is ready is recorded without a request", { timeout: 15_000 }, async (t) => {
  const { url, directory } = await supervised(t, "fault-start", faultingRuntime("before-ready"));
  await whenHealthy(url);

  const [incident] = await processFaultIncidents(directory);
  assert.equal(incident?.[0]?.requestId, null);
  assert.equal(incident?.find((row) => row.kind === "process_fault")?.fault.message, "raised before ready");
  assert.equal(await stateOf(url), "ready");
});

test("two distinct faults are both recorded", { timeout: 15_000 }, async (t) => {
  const { url, directory } = await supervised(t, "fault-twice", faultingRuntime());
  await whenHealthy(url);
  await fetch(`${url}/fault-twice`);

  await delay(500);
  const messages = (await processFaultIncidents(directory)).flat().filter((row) => row.kind === "process_fault").map((row) => row.fault.message);
  assert.ok(messages.includes("first distinct fault"), `recorded: ${messages.join(", ")}`);
});

test("a fault reported by the supervisor's own process is recorded as such", { timeout: 15_000 }, async (t) => {
  const { supervisor, url, directory } = await supervised(t, "fault-own", faultingRuntime());
  await whenHealthy(url);
  supervisor.reportProcessFault(aFault("host promise rejected"));

  const [incident] = await processFaultIncidents(directory);
  const record = incident?.find((row) => row.kind === "process_fault");
  assert.equal(record?.origin, "supervisor");
  assert.equal(record?.fault.message, "host promise rejected");
});

test("a fault reported after the supervisor closed writes no new incident", { timeout: 15_000 }, async (t) => {
  const { supervisor, url, directory } = await supervised(t, "fault-closed", faultingRuntime());
  await whenHealthy(url);
  await supervisor.close();
  const before = (await readdir(directory).catch(() => [] as string[])).length;
  assert.doesNotThrow(() => supervisor.reportProcessFault(aFault("late")));
  await delay(300);
  assert.equal((await readdir(directory).catch(() => [] as string[])).length, before);
});

test("a restart whose spawn throws leaves the supervisor failed with RUNTIME_RESTART_FAILED, not failing", { timeout: 25_000 }, async (t) => {
  let starts = 0;
  const { url } = await supervised(
    t,
    "restart-spawn-throws",
    () => ({
      // The first start is the wedged runtime; the restart gets an executable Node refuses to spawn (it throws, it does not emit).
      get executable() { return starts++ === 0 ? executable : (42 as unknown as string); },
      args,
    }),
    fastDeadlines,
    RUNTIME_RESTART_WINDOW_MS,
  );
  await whenHealthy(url);
  assert.match(await (await mcpCall(url, 96, "hang")).text(), /RUNTIME_UNRESPONSIVE/, "the call that met the hang is answered with the failure");

  let body: string;
  do {
    await delay(50);
    body = await (await fetch(`${url}/health`)).text();
  } while (body.includes('"state":"failing"') || body.includes('"state":"starting"'));
  assert.match(body, /"state":"failed"/);
  assert.match(body, /RUNTIME_RESTART_FAILED/);
  const afterwards = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 97, method: "tools/list" }),
  });
  assert.match(await afterwards.text(), /RUNTIME_RESTART_FAILED/, "later calls get the restart failure, not a hang");
});

test("the chat command routes answer 403 to a request whose Host is not local, even with the control header", { timeout: 15_000 }, async (t) => {
  const { url } = await supervised(t, "chat-commands-host");
  const status = (path: string, method: string, host: string) =>
    new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${url}${path}`, { method, headers: { host, "x-mine-ai-control": "1" } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      request.end();
    });

  assert.equal(await status("/chat-commands", "GET", "evil.example"), 403);
  assert.equal(await status("/chat-commands/whisper", "POST", "evil.example:25575"), 403);
});

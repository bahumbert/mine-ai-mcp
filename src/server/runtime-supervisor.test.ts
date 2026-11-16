import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test, { type TestContext } from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_RESTART_WINDOW_MS } from "./runtime-liveness.js";
import { INCIDENT_HISTORY_MS } from "../diagnostics/incident-recorder.js";
import { startMcpSupervisor, type McpSupervisorOptions } from "./runtime-supervisor.js";
import { createFakeRuntimeChild } from "../test-support/fake-runtime-child.js";
import { createFakeClock } from "../test-support/fake-bot/fake-clock.js";
import { sleepMs } from "../utils/wall-timers.js";

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
  seams: Partial<Pick<McpSupervisorOptions, "clock" | "spawnRuntime">> = {},
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
      ...seams,
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

/** Deadlines short enough for a test: a hang is declared after one second of silence instead of five. */
const fastDeadlines = { startupMs: 10_000, unresponsiveMs: 1_000 };

/** Real HTTP and incident writes, but explicit child liveness and watchdog time; only ring ageing needs real time. */
async function fakeSupervised(
  t: TestContext,
  instanceId: string,
  options: { deadlines?: McpSupervisorOptions["deadlines"]; restartWindowMs?: number; historyMs?: number; slowMs?: number; realTime?: boolean; startReady?: boolean } = {},
) {
  const clock = createFakeClock({ mode: "manual" });
  const children: ReturnType<typeof createFakeRuntimeChild>[] = [];
  const spawnRuntime = () => {
    const child = createFakeRuntimeChild({ ...options, clock: options.realTime ? undefined : clock });
    children.push(child);
    if (children.length > 1) setImmediate(() => { void child.ready(); });
    return child;
  };
  const result = await supervised(t, instanceId, undefined, options.deadlines ?? fastDeadlines,
    options.restartWindowMs ?? 0, options.historyMs, { clock: options.realTime ? undefined : clock, spawnRuntime });
  t.after(async () => { await Promise.all(children.map((child) => child.close())); });
  const fake = children[0]!;
  if (options.startReady !== false) await fake.ready();
  if (options.realTime) {
    const beat = setInterval(() => fake.beat(), 250);
    t.after(() => clearInterval(beat));
  }
  return { ...result, clock, fake, children };
}

/** Every test acts only once the runtime is answering for itself. */
async function whenHealthy(url: string): Promise<void> {
  while (!(await fetch(`${url}/health`)).ok) await sleepMs(20);
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
    await sleepMs(pollMs);
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
    await sleepMs(50);
  }
}

/** The original shared-pause case's 2.5 s blind gap and 100 ms offset, now advanced explicitly. */
const SUPERVISOR_PAUSE_MS = 2_500;
const SUPERVISOR_PAUSE_DELAY_MS = 100;
/** The liveness deadline of the two pause tests below. */
const PAUSE_TEST_UNRESPONSIVE_MS = 1_500;

/**
 * One late watchdog tick models the supervisor's blind gap. A child resumes either within or past the fresh window.
 */
async function pauseBothLoopsUntilRuntimeBack(runtime: Awaited<ReturnType<typeof fakeSupervised>>, pauseMs: number) {
  const { clock, fake, url } = runtime;
  const heartbeatMs = 250;
  const blindGap = heartbeatMs + SUPERVISOR_PAUSE_MS;
  await clock.advance(blindGap, blindGap);
  assert.equal(await stateOf(url), "ready", "a late tick starts a fresh window");
  const paused = await (await fetch(`${url}/diagnostics/runtime`)).json();
  assert.equal(paused.heartbeatAgeMs, blindGap);
  if (pauseMs - blindGap >= PAUSE_TEST_UNRESPONSIVE_MS) {
    await clock.advance(PAUSE_TEST_UNRESPONSIVE_MS - 1);
    assert.equal(await stateOf(url), "ready", "the entire fresh liveness window must elapse before failure");
    await clock.advance(1);
    await whenFailed(url);
  } else {
    await clock.advance(pauseMs - blindGap);
    fake.beat();
  }
  return (await fetch(`${url}/diagnostics/runtime`)).json();
}

test(
  "a shared scheduling pause gets a fresh liveness window when the supervisor resumes",
  async (t) => {
    // The child pauses 3 s, the supervisor 2.5 s: past its 1.5 s deadline, so it sees its own blind gap. The child
    // resumes half a second after it, inside the fresh 1.5 s window. The supervisor cannot diagnose a child-only hang
    // during its own blind gap.
    const runtime = await fakeSupervised(t, "observer-stall", { deadlines: { startupMs: 10_000, unresponsiveMs: PAUSE_TEST_UNRESPONSIVE_MS } });
    const { url } = runtime;
    await whenHealthy(url);

    const diagnostics = await pauseBothLoopsUntilRuntimeBack(runtime, 3_000);

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
  async (t) => {
    // The child pauses 5 s: 2.4 s after the supervisor resumes, past the fresh 1.5 s window.
    const runtime = await fakeSupervised(t, "observer-stall-hang", { deadlines: { startupMs: 10_000, unresponsiveMs: PAUSE_TEST_UNRESPONSIVE_MS } });
    const { url, clock } = runtime;
    await whenHealthy(url);

    const pausedAt = clock.now();
    const diagnostics = await pauseBothLoopsUntilRuntimeBack(runtime, 5_000);
    const failedSeenAfterMs = clock.now() - pausedAt;

    assert.equal(diagnostics.state, "failed");
    const { runtime: failedRuntime } = await (await fetch(`${url}/health`)).json();
    assert.equal(failedRuntime.failure.code, "RUNTIME_UNRESPONSIVE");
    const records = await readFile(failedRuntime.failure.incident.artifact.path, "utf8");
    const resumed = records.trim().split("\n").map((line) => JSON.parse(line)).find((row) => row.kind === "supervisor_observation_resumed");
    assert.equal(resumed.supervisorTickDelayMs, SUPERVISOR_PAUSE_MS);
    assert.equal(resumed.heartbeatAgeMs, 250 + SUPERVISOR_PAUSE_MS);
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
  async (t) => {
    const { url } = await fakeSupervised(t, "attribution", { realTime: true, historyMs: SHORT_HISTORY_MS });
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
  test(`supervisor returns a saved failure when the runtime ${fault}s`, async (t) => {
    const { url, fake, clock } = await fakeSupervised(t, fault);
    await whenHealthy(url);

    const request = fetch(`${url}/${fault}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 73, method: "tools/call", params: { name: fault } }),
    });
    await fake.arrived(`/${fault}`);
    if (fault !== "crash") await clock.advance(1_250);
    await whenFailed(url);
    const response = await request;
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

test("a long operation with a live event loop is not timed out", async (t) => {
  // The operation (2 s) outlasts the silence deadline (1 s).
  const { supervisor, url, fake, clock } = await fakeSupervised(t, "healthy", { slowMs: 2_000 });
  await whenHealthy(url);

  const cancellation = new AbortController();
  const cancelled = fetch(`${url}/slow`, { signal: cancellation.signal });
  await fake.arrived("/slow");
  cancellation.abort();
  await assert.rejects(cancelled);

  assert.equal((await fetch(`${url}/health`)).status, 200, "Client cancellation must not kill a healthy runtime.");
  // The forwarded request is present before watchdog time moves beyond its liveness deadline.
  const finished = fetch(`${url}/slow`);
  await fake.arrived("/slow");
  const removeBeat = clock.every(() => fake.beat(), 250);
  await clock.advance(2_000);
  removeBeat();
  assert.equal(await (await finished).text(), "finished");
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

test("a runtime silent before ready for longer than the heartbeat deadline is not killed", async (t) => {
  // Live 2026-10-11: a host was killed at start while its module graph loaded.
  const { url, clock, fake } = await fakeSupervised(t, "slow-start", { startReady: false, deadlines: { startupMs: 4_000, unresponsiveMs: 1_000 } });
  await clock.advance(1_500);
  assert.equal(await stateOf(url), "starting");
  await fake.ready();
  await whenHealthy(url);
  assert.equal((await fetch(`${url}/health`)).status, 200);
});

test("a runtime silent past the startup deadline before ready is killed as unresponsive", async (t) => {
  const { url, clock } = await fakeSupervised(t, "stuck-start", { startReady: false, deadlines: { startupMs: 2_000, unresponsiveMs: 1_000 } });
  await clock.advance(2_000);
  const { status } = await whenFailed(url);
  assert.match(JSON.stringify(status), /RUNTIME_UNRESPONSIVE/);
});

test("a ready runtime's heartbeat deadline counts from ready, not from the silence before it", async (t) => {
  // The silence before ready (1.5 s) is past the 1 s heartbeat deadline, so the last heartbeat the supervisor holds is
  // from its own start. Kept, it would declare the runtime hung at the first watchdog tick after ready.
  const { supervisor, url, clock, fake } = await fakeSupervised(t, "ready-clock", { startReady: false, deadlines: { ...fastDeadlines, heartbeatMs: 1 } });
  await clock.advance(1_500);
  await fake.ready();
  await clock.advance(500);
  assert.equal(await stateOf(url), "ready", "Half the heartbeat deadline after ready the runtime is still ready: the clock starts at ready.");
  await clock.advance(499);
  assert.equal(await stateOf(url), "ready");
  await clock.advance(2);
  const { status } = await whenFailed(url);
  assert.match(JSON.stringify(status), /RUNTIME_UNRESPONSIVE/);
  assert.deepEqual(fake.kills, ["SIGKILL"]);
  await supervisor.close();
  assert.equal(clock.pendingTimers(), 0);
});

const mcpCall = (url: string, id: number, tool: string) =>
  fetch(`${url}/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool } }),
  });
const stateOf = async (url: string): Promise<string> => (await (await fetch(`${url}/diagnostics/runtime`)).json()).state;

test("a heartbeat at 900 ms resets the window", async (t) => {
  const clock = createFakeClock({ mode: "manual" });
  const fake = createFakeRuntimeChild();
  const { url } = await supervised(t, "fake-beat", undefined, fastDeadlines, 0, undefined, { clock, spawnRuntime: () => fake });
  t.after(() => fake.close());
  await fake.ready();
  await clock.advance(900);
  fake.beat();
  await clock.advance(999);
  assert.equal(await stateOf(url), "ready");
});

test("a runtime killed as unresponsive is started again and answers", { timeout: 25_000 }, async (t) => {
  const { url } = await supervised(t, "restart", undefined, fastDeadlines, RUNTIME_RESTART_WINDOW_MS);
  await whenHealthy(url);
  assert.match(await (await mcpCall(url, 90, "hang")).text(), /RUNTIME_UNRESPONSIVE/, "the call that met the hang is answered with the failure");
  while ((await fetch(`${url}/health`)).status !== 200) await sleepMs(50);
  assert.equal(await stateOf(url), "ready");
});

test("a second failure inside the restart window stays down and says it restarted before", async (t) => {
  const { url, clock, fake, children } = await fakeSupervised(t, "restart-twice", { restartWindowMs: RUNTIME_RESTART_WINDOW_MS });
  await whenHealthy(url);
  const first = mcpCall(url, 91, "hang");
  await fake.arrived("/hang");
  await clock.advance(1_250);
  await first;
  while ((await fetch(`${url}/health`)).status !== 200) await sleepMs(50);
  const second = mcpCall(url, 92, "hang");
  await children.at(-1)!.arrived("/hang");
  await clock.advance(1_250);
  assert.match(await (await second).text(), /RUNTIME_UNRESPONSIVE/);
  await whenFailed(url);
  await clock.advance(1_500);
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
  while ((await stateOf(url)) !== "ready") await sleepMs(20);
  const closing = performance.now();
  await supervisor.close();
  const closedAfterMs = performance.now() - closing;
  assert.ok(closedAfterMs < 2_000, `close took ${Math.round(closedAfterMs)} ms with a 200 ms kill grace`);
});

test("the watchdog judges the runtime only on its own ticks, every heartbeatMs", async (t) => {
  // A watchdog interval past the silence deadline: a gap of one interval is the watchdog's own rhythm, not a blind gap.
  const { url, clock, fake } = await fakeSupervised(t, "heartbeat-interval", { deadlines: { startupMs: 10_000, unresponsiveMs: 500, heartbeatMs: 3_000 } });
  const started = clock.now();
  await whenHealthy(url);
  const request = mcpCall(url, 98, "hang");
  await fake.arrived("/hang");
  await clock.advance(2_999);
  assert.equal(await stateOf(url), "ready");
  await clock.advance(1);
  await whenFailed(url);
  assert.match(await (await request).text(), /RUNTIME_UNRESPONSIVE/);
  const declaredAfterMs = clock.now() - started;
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

const aFault = (message: string) => ({ kind: "unhandled_rejection" as const, message, stack: null, observedAt: new Date().toISOString(), repeats: 0 });

type IncidentRecord = Record<string, any>;
/** The records of each incident file in the directory that holds a `process_fault` record, waited for up to 5 s. */
async function processFaultIncidents(directory: string, wanted = 1): Promise<IncidentRecord[][]> {
  const deadline = performance.now() + 5_000;
  for (;;) {
    const incidents: IncidentRecord[][] = [];
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      const records: IncidentRecord[] = (await readFile(path.join(directory, name), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      if (records.some((row) => row.kind === "process_fault")) incidents.push(records);
    }
    if (incidents.length >= wanted || performance.now() > deadline) return incidents;
    await sleepMs(50);
  }
}

test("a fault message from the runtime records a process_fault incident", async (t) => {
  const { url, directory } = await fakeSupervised(t, "fault-ready");
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

test("a fault while an action runs names that request in the incident", async (t) => {
  const { url, directory } = await fakeSupervised(t, "fault-request");
  await whenHealthy(url);
  await fetch(`${url}/fault-during-request`);

  const [incident] = await processFaultIncidents(directory);
  assert.equal(incident?.[0]?.requestId, 812);
});

test("a fault reported before the runtime is ready is recorded without a request", async (t) => {
  const { url, directory, fake } = await fakeSupervised(t, "fault-start", { startReady: false });
  fake.fault(aFault("raised before ready"));
  await fake.ready();
  await whenHealthy(url);

  const [incident] = await processFaultIncidents(directory);
  assert.equal(incident?.[0]?.requestId, null);
  assert.equal(incident?.find((row) => row.kind === "process_fault")?.fault.message, "raised before ready");
  assert.equal(await stateOf(url), "ready");
});

test("two distinct faults are both recorded", async (t) => {
  const { url, directory, clock } = await fakeSupervised(t, "fault-twice");
  await whenHealthy(url);
  await fetch(`${url}/fault-twice`);

  await clock.advance(500);
  const messages = (await processFaultIncidents(directory, 2)).flat().filter((row) => row.kind === "process_fault").map((row) => row.fault.message);
  assert.ok(messages.includes("first distinct fault"), `recorded: ${messages.join(", ")}`);
  assert.ok(messages.includes("second distinct fault"), `recorded: ${messages.join(", ")}`);
});

test("a fault reported by the supervisor's own process is recorded as such", async (t) => {
  const { supervisor, url, directory } = await fakeSupervised(t, "fault-own");
  await whenHealthy(url);
  supervisor.reportProcessFault(aFault("host promise rejected"));

  const [incident] = await processFaultIncidents(directory);
  const record = incident?.find((row) => row.kind === "process_fault");
  assert.equal(record?.origin, "supervisor");
  assert.equal(record?.fault.message, "host promise rejected");
});

test("a fault reported after the supervisor closed writes no new incident", async (t) => {
  const { supervisor, url, directory, clock } = await fakeSupervised(t, "fault-closed");
  await whenHealthy(url);
  await supervisor.close();
  const before = (await readdir(directory).catch(() => [] as string[])).length;
  assert.doesNotThrow(() => supervisor.reportProcessFault(aFault("late")));
  await clock.advance(300);
  assert.equal((await readdir(directory).catch(() => [] as string[])).length, before);
});

test("a restart whose spawn throws leaves the supervisor failed with RUNTIME_RESTART_FAILED, not failing", async (t) => {
  let starts = 0;
  const clock = createFakeClock({ mode: "manual" });
  const fake = createFakeRuntimeChild();
  const { url } = await supervised(
    t,
    "restart-spawn-throws",
    undefined,
    fastDeadlines,
    RUNTIME_RESTART_WINDOW_MS,
    undefined,
    { clock, spawnRuntime: () => {
      if (starts++ > 0) throw new TypeError("runtime spawn failed");
      return fake;
    } },
  );
  t.after(() => fake.close());
  await fake.ready();
  await whenHealthy(url);
  const request = mcpCall(url, 96, "hang");
  await fake.arrived("/hang");
  await clock.advance(1_250);
  await whenFailed(url);
  assert.match(await (await request).text(), /RUNTIME_UNRESPONSIVE/, "the call that met the hang is answered with the failure");

  let body: string;
  do {
    await sleepMs(50);
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

test("the chat command routes answer 403 to a request whose Host is not local, even with the control header", async (t) => {
  const { url } = await fakeSupervised(t, "chat-commands-host");
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

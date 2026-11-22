import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { spawn } from "node:child_process";
import type { Request, Response } from "express";
import { createServer, request as httpRequest, type Server as HttpServer } from "node:http";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { writeIncidentArtifact } from "../bot-data/incident-log.js";
import { INCIDENT_HISTORY_BYTES, INCIDENT_HISTORY_MS, IncidentRecorder } from "../diagnostics/incident-recorder.js";
import type { ProcessFault } from "./process-faults.js";
import { NO_STREAK, readyAgain } from "./restart-policy.js";
import {
  RUNTIME_HEARTBEAT_MS,
  RUNTIME_UNRESPONSIVE_MS,
  RUNTIME_STARTUP_MS,
  runtimeMessageSchema,
} from "./runtime-liveness.js";
import { answerFailure, failRuntime } from "./runtime-supervisor-failure.js";
import type { IpcChannel } from "./ipc-transport.js";
import { envelopeSchema, LinkHub } from "./runtime-supervisor-links.js";
import {
  printSupervisorLine,
  requestContextOf,
  TICK_HISTORY_MS,
  type McpSupervisorOptions,
  type ObservedFailureCode,
  type PendingRequest,
  type RuntimeChild,
  type RuntimeState,
  type SupervisorClock,
  type SupervisorParts,
  type SupervisorState,
} from "./runtime-supervisor-state.js";

export type { McpSupervisorOptions, RuntimeChild, SupervisorClock } from "./runtime-supervisor-state.js";

const realClock: SupervisorClock = {
  now: () => performance.now(),
  every: (tick, ms) => { const timer = setInterval(tick, ms); return () => clearInterval(timer); },
  after: (ms, fire, options) => {
    const timer = setTimeout(fire, ms);
    if (options?.unref) timer.unref();
    return () => clearTimeout(timer);
  },
};

/** Production retains the inherited logs and IPC channel of the runtime process. */
const spawnRealRuntime = (executable: string, args: readonly string[]): RuntimeChild =>
  spawn(executable, [...args], { windowsHide: true, stdio: ["ignore", "inherit", "inherit", "ipc"] });

/** The supervisor's incident ring budget: the age from the options, else production's. */
const incidentHistoryBudget = (options: Pick<McpSupervisorOptions, "incidentHistoryMs">) => ({
  durationMs: options.incidentHistoryMs ?? INCIDENT_HISTORY_MS,
  bytes: INCIDENT_HISTORY_BYTES,
});

/** The supervisor's own incident recorder: artifacts go to the options' directory, history age from {@link incidentHistoryBudget}. */
const supervisorIncidentRecorder = (options: McpSupervisorOptions) =>
  new IncidentRecorder(
    { instanceId: options.instanceId, source: options.source },
    (capture) =>
      writeIncidentArtifact(
        options.incidents.directory,
        capture.trigger,
        capture.requestId,
        capture.contents,
        capture.precedingRequestId,
        options.incidents.retention,
      ),
    () => {},
    incidentHistoryBudget(options),
    undefined,
    options.wallClock,
  );

/** Public HTTP stays outside the bot's event loop, including pending MCP SSE replies. */
export async function startMcpSupervisor(options: McpSupervisorOptions) {
  // Docker binds all container interfaces; Compose restricts the published port to host loopback.
  if (!["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(options.host)) throw new Error("MCP must bind to loopback or 0.0.0.0 for container port forwarding.");
  const clock = options.clock ?? realClock;
  const startedAt = clock.now();
  let closing: Promise<void> | null = null;
  const pending = new Set<PendingRequest>();
  const recorder = supervisorIncidentRecorder(options);
  const sup: SupervisorState = {
    options,
    clock,
    recorder,
    runtime: { kind: "starting" },
    lastHeartbeat: startedAt,
    observationResumedAt: startedAt,
    lastWatchdogTick: startedAt,
    watchdogDelayMs: 0,
    stopping: false,
    child: null,
    streak: NO_STREAK,
    restartTimer: null,
    tickDelays: [],
    activity: null,
    heartbeat: null,
  };

  const links = new LinkHub({
    accepts: () => sup.runtime.kind === "ready",
    log: (line) => printSupervisorLine(sup, { event: "link_problem", observedAt: new Date().toISOString(), message: line }),
  });

  const parts: SupervisorParts = {
    sup,
    pending,
    links,
    fail: (code, message) => failRuntime(parts, code, message),
    startChild: () => startRuntimeChild(parts),
  };

  const app = createMcpExpressApp({ host: options.host, allowedHosts: ["127.0.0.1", "localhost", "[::1]"] });
  app.use((request, response) => routeHttpRequest(parts, request, response));
  const server = createServer(app);
  // Actions and SSE have natural lifetimes; only lost event-loop liveness is timed.
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  parts.startChild();
  const watchdog = startWatchdog(sup, parts.fail);
  const close = () => (closing ??= stopSupervisor(parts, server, watchdog));
  /** A session to the runtime over its IPC channel, for the brain's MCP client; refused while the runtime is not `ready`. */
  const openLink = async (): Promise<Transport> => {
    if (sup.runtime.kind !== "ready") throw new Error(linkRefusal(sup.runtime));
    const link = links.open();
    if (link === null) throw new Error("[RUNTIME_EXITED] the runtime's IPC channel is closed; its failure is being recorded: try again shortly.");
    return link;
  };
  return {
    server,
    openLink,
    get child(): RuntimeChild { return sup.child!; },
    /** For the supervisor process's own unhandled rejections (the runtime's arrive over IPC). */
    reportProcessFault: (fault: ProcessFault) => reportProcessFault(sup, fault, "supervisor"),
    close,
    [Symbol.asyncDispose]: close,
  };
}

/** One HTTP request: the diagnostics route, the saved failure while the runtime is not `ready`, else a proxy to the runtime. */
function routeHttpRequest(parts: SupervisorParts, request: Request, response: Response): void {
  const { sup, pending } = parts;
  if (request.method === "GET" && request.path === "/diagnostics/runtime") {
    response.json({ state: sup.runtime.kind, heartbeatAgeMs: sup.clock.now() - sup.lastHeartbeat, activity: sup.activity, heartbeat: sup.heartbeat });
    return;
  }
  const parsed = envelopeSchema.safeParse(request.body);
  const envelope = parsed.success ? parsed.data : null;
  if (sup.runtime.kind !== "ready") {
    const failure = sup.runtime.kind === "failed" ? sup.runtime.failure : null;
    if (failure && request.path === "/mcp" && envelope?.id !== undefined) {
      answerFailure(response, envelope.id, failure);
      return;
    }
    response.status(503).json({
      ok: false,
      runtime: { state: sup.runtime.kind, failure },
      minecraft: { connected: false },
      error: failure
        ? `[${failure.code}] ${failure.message}`
        : "Minecraft runtime is starting or saving its failure.",
    });
    return;
  }
  const body = request.body === undefined ? undefined : JSON.stringify(request.body);
  const headers = { ...request.headers };
  delete headers["transfer-encoding"];
  if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
  const upstream = httpRequest({
    hostname: "127.0.0.1",
    port: sup.runtime.port,
    method: request.method,
    path: request.originalUrl,
    headers,
  });
  const entry: PendingRequest = {
    upstream,
    response,
    id: envelope?.id ?? null,
    method: envelope?.method ?? null,
    tool: envelope?.params?.name ?? null,
    path: request.path,
    httpMethod: request.method,
  };
  pending.add(entry);
  sup.recorder.record("http_request", { id: entry.id, method: entry.method, tool: entry.tool, path: request.path });
  upstream.on("response", (reply) => {
    response.writeHead(reply.statusCode ?? 502, reply.headers);
    reply.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!pending.has(entry)) return; // A cancelled HTTP request does not mean the runtime failed.
    if (sup.runtime.kind === "failed") answerFailure(response, entry.id, sup.runtime.failure);
    else if (sup.runtime.kind !== "failing" && !sup.stopping)
      void parts.fail("RUNTIME_EXITED", `Runtime transport failed: ${error.message}`);
  });
  response.once("close", () => {
    pending.delete(entry);
    upstream.destroy();
  });
  upstream.end(body);
}

/** Starts the runtime child; a handler ignores any child but the current one (a killed one still exits later). */
function startRuntimeChild(parts: SupervisorParts): void {
  const { sup, links } = parts;
  const started = (sup.options.spawnRuntime ?? spawnRealRuntime)(sup.options.executable, sup.options.args);
  sup.child = started;
  links.attach(ipcChannelOf(started));
  started.on("message", (raw: unknown) => {
    // Link frames of the current, ready child go to their link; everything else is the runtime's own report.
    if (started === sup.child && sup.runtime.kind === "ready" && links.route(raw)) return;
    handleRuntimeMessage(sup, started, raw);
  });
  started.once("error", (error) => {
    if (started === sup.child) void parts.fail("RUNTIME_EXITED", error.message);
  });
  started.once("exit", (code, signal) => {
    if (started === sup.child) void parts.fail("RUNTIME_EXITED", `Runtime exited: code=${code}, signal=${signal}.`);
  });
}

/** The link's view of a child's channel; a child without one (a test fixture) answers every write with an error. */
function ipcChannelOf(child: RuntimeChild): IpcChannel {
  return {
    get connected() {
      return child.connected;
    },
    send: (message, callback) => {
      if (child.send === undefined) {
        callback?.(new Error("the runtime child has no IPC channel"));
        return false;
      }
      return child.send(message, callback);
    },
    on: (event, listener) => child.on(event, listener),
    off: (event, listener) => child.off(event, listener),
  };
}

/** Stops the supervisor: links closed, the child asked to end (SIGKILL after the grace), calls in flight cut, HTTP closed, incidents flushed. */
async function stopSupervisor(parts: SupervisorParts, server: HttpServer, watchdog: () => void): Promise<void> {
  const { sup, pending, links } = parts;
  sup.stopping = true;
  links.closeAll();
  watchdog();
  sup.restartTimer?.();
  if (sup.child?.pid !== undefined && sup.child.exitCode === null && sup.child.signalCode === null) {
    const stopped = new Promise<void>((resolve) => sup.child!.once("exit", () => resolve()));
    sup.child.kill("SIGTERM");
    // Normal disposal gets the same liveness allowance as execution. A
    // cleanup loop must not keep the owned child alive after service stop.
    const force = sup.clock.after(sup.options.deadlines?.killGraceMs ?? RUNTIME_UNRESPONSIVE_MS, () => { sup.child?.kill("SIGKILL"); });
    try {
      await stopped;
    } finally {
      force();
    }
  }
  for (const entry of pending) {
    entry.response.destroy();
    entry.upstream.destroy();
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await sup.recorder.flush();
}

/**
 * Every `heartbeatMs` (default {@link RUNTIME_HEARTBEAT_MS}), declares the runtime unresponsive once its silence passes
 * the deadline of its state (starting or ready).
 */
function startWatchdog(sup: SupervisorState, fail: (code: ObservedFailureCode, message: string) => Promise<void>): () => void {
  const { deadlines } = sup.options;
  const heartbeatMs = deadlines?.heartbeatMs ?? RUNTIME_HEARTBEAT_MS;
  return sup.clock.every(() => {
    const now = sup.clock.now();
    sup.watchdogDelayMs = Math.max(0, now - sup.lastWatchdogTick - heartbeatMs);
    sup.lastWatchdogTick = now;
    sup.tickDelays.push({ at: now, delayMs: sup.watchdogDelayMs });
    while (sup.tickDelays[0]!.at < now - TICK_HISTORY_MS) sup.tickDelays.shift();
    // A watchdog that missed its own liveness window cannot attribute that
    // gap to the child. Resume observation before judging it; queued IPC and
    // a child recovering from the same scheduling pause get a full window.
    const deadlineMs = sup.runtime.kind === "starting" ? (deadlines?.startupMs ?? RUNTIME_STARTUP_MS) : (deadlines?.unresponsiveMs ?? RUNTIME_UNRESPONSIVE_MS);
    if (sup.watchdogDelayMs >= deadlineMs) {
      sup.observationResumedAt = now;
      sup.recorder.record("supervisor_observation_resumed", {
        supervisorTickDelayMs: sup.watchdogDelayMs,
        heartbeatAgeMs: now - sup.lastHeartbeat,
      });
    }
    const age = now - Math.max(sup.lastHeartbeat, sup.observationResumedAt);
    if (age >= deadlineMs)
      void fail(
        "RUNTIME_UNRESPONSIVE",
        `Runtime event-loop heartbeat absent for ${Math.round(now - sup.lastHeartbeat)} ms.`,
      );
  }, heartbeatMs);
}

/** Applies one message of the current runtime child; a failed, failing or replaced child's messages are ignored. */
function handleRuntimeMessage(sup: SupervisorState, from: RuntimeChild, raw: unknown): void {
  const parsed = runtimeMessageSchema.safeParse(raw);
  if (from !== sup.child || !parsed.success || sup.runtime.kind === "failed" || sup.runtime.kind === "failing") return;
  const event = parsed.data;
  if (event.kind === "fault") {
    reportProcessFault(sup, event.fault, "runtime");
    return;
  }
  if (event.kind !== "ready") sup.activity = event.activity;
  sup.recorder.record(event.kind, event);
  if (event.kind === "heartbeat") {
    sup.lastHeartbeat = sup.clock.now();
    sup.heartbeat = event;
  }
  if (event.kind === "ready") {
    sup.runtime = { kind: "ready", port: event.port };
    // Ready shows a live loop; the shorter deadline counts from here, not from the last start-up heartbeat.
    sup.lastHeartbeat = sup.clock.now();
    sup.streak = readyAgain(sup.streak, sup.lastHeartbeat);
    if (sup.streak.attempts > 0) printSupervisorLine(sup, { event: "runtime_ready", observedAt: new Date().toISOString(), attempt: sup.streak.attempts });
  }
}

/** Why a link cannot be opened now: the saved failure, or that the runtime is not up yet. */
function linkRefusal(runtime: Exclude<RuntimeState, { kind: "ready" }>): string {
  if (runtime.kind === "failed") return `[${runtime.failure.code}] ${runtime.failure.message}`;
  return `[RUNTIME_STARTING] the runtime is starting${runtime.kind === "failing" ? " again after a failure it is recording" : ""}: open the link again shortly.`;
}

/**
 * Records a promise rejection nobody handled, in the runtime or in this process, and saves an incident for it. The
 * runtime keeps running (owner 2026-10-19). After `close` the fault is recorded but no capture starts: the recorder is flushed.
 */
function reportProcessFault(sup: SupervisorState, fault: ProcessFault, origin: "runtime" | "supervisor"): void {
  const { requestId, precedingRequestId } = requestContextOf(sup.activity);
  sup.recorder.record("process_fault", { origin, fault, activity: sup.activity });
  if (sup.stopping) return;
  void sup.recorder.capture("process_fault", requestId, precedingRequestId).then((captured) => {
    if (captured.kind === "failed") process.stderr.write(`[minecraft-supervisor] the process_fault incident was not saved: ${captured.error}
`);
  });
}

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type ClientRequest, type ServerResponse } from "node:http";
import { z } from "zod";
import { writeIncidentArtifact, type IncidentReference, type IncidentRetention } from "../bot-data/incident-log.js";
import { IncidentRecorder, type SourceIdentity } from "../diagnostics/incident-recorder.js";
import type { ProcessFault } from "./process-faults.js";
import {
  RUNTIME_HEARTBEAT_MS,
  RUNTIME_UNRESPONSIVE_MS,
  RUNTIME_RESTART_WINDOW_MS,
  RUNTIME_STARTUP_MS,
  runtimeMessageSchema,
  type RuntimeActivity,
} from "./runtime-liveness.js";

const envelopeSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.object({ name: z.string().optional() }).optional(),
});
interface PendingRequest {
  readonly response: ServerResponse;
  readonly upstream: ClientRequest;
  readonly id: string | number | null;
  readonly method: string | null;
  readonly tool: string | null;
  readonly path: string;
  readonly httpMethod: string;
}
/** What the watchdog or the child's exit observed; a failed restart has a code of its own. */
type ObservedFailureCode = "RUNTIME_UNRESPONSIVE" | "RUNTIME_EXITED";
interface RuntimeFailure {
  readonly actionId?: string;
  readonly code: ObservedFailureCode | "RUNTIME_RESTART_FAILED";
  readonly observedAt: string;
  readonly message: string;
  readonly incident: IncidentReference;
  readonly activity: RuntimeActivity | null;
}
type RuntimeState =
  | { kind: "starting" }
  | { kind: "ready"; port: number }
  | { kind: "failing" }
  | { kind: "failed"; failure: RuntimeFailure };

export interface McpSupervisorOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly host: string;
  readonly port: number;
  readonly instanceId: string;
  readonly source: SourceIdentity;
  readonly incidents: { directory: string; retention: IncidentRetention };
  /** Silence allowed before `ready` and after it; for tests that cannot wait the real deadlines. */
  readonly deadlines?: { readonly startupMs: number; readonly unresponsiveMs: number };
  /** One restart of a killed runtime per this window (default {@link RUNTIME_RESTART_WINDOW_MS}); 0 never restarts. For tests. */
  readonly restartWindowMs?: number;
}

type HeartbeatMessage = Extract<z.infer<typeof runtimeMessageSchema>, { kind: "heartbeat" }>;
/** What the supervisor changes while it runs; the steps below the supervisor take it explicitly. */
interface SupervisorState {
  readonly options: McpSupervisorOptions;
  readonly recorder: IncidentRecorder;
  runtime: RuntimeState;
  lastHeartbeat: number;
  observationResumedAt: number;
  stopping: boolean;
  child: ChildProcess | null;
  lastRestartAt: number | null;
  activity: RuntimeActivity | null;
  heartbeat: HeartbeatMessage | null;
}

/** Public HTTP stays outside the bot's event loop, including pending MCP SSE replies. */
export async function startMcpSupervisor(options: McpSupervisorOptions) {
  // Docker binds all container interfaces; Compose restricts the published port to host loopback.
  if (!["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(options.host)) throw new Error("MCP must bind to loopback or 0.0.0.0 for container port forwarding.");
  const startedAt = performance.now();
  let lastWatchdogTick = startedAt;
  let watchdogDelayMs = 0;
  let closing: Promise<void> | null = null;
  const pending = new Set<PendingRequest>();
  const recorder = new IncidentRecorder(
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
  );
  const sup: SupervisorState = {
    options,
    recorder,
    runtime: { kind: "starting" },
    lastHeartbeat: startedAt,
    observationResumedAt: startedAt,
    stopping: false,
    child: null,
    lastRestartAt: null,
    activity: null,
    heartbeat: null,
  };

  const answerFailure = (response: ServerResponse, id: string | number | null, failure: RuntimeFailure) => {
    if (response.writableEnded || response.destroyed) return;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: `[${failure.code}] ${failure.message}`, data: failure },
    });
    if (response.headersSent) {
      if (String(response.getHeader("content-type")).includes("text/event-stream"))
        response.end(`\n\nevent: message\ndata: ${body}\n\n`);
      else response.destroy(new Error(failure.message));
      // A completed JSON-RPC exchange uses HTTP 200 even when its result is an
      // error. HTTP 503 makes the SDK discard the structured MCP error as a
      // transport failure. Observational HTTP requests still receive 503.
    } else response.writeHead(id === null ? 503 : 200, { "content-type": "application/json" }).end(body);
  };
  const fail = async (code: ObservedFailureCode, message: string) => {
    if (sup.stopping || sup.runtime.kind === "failed" || sup.runtime.kind === "failing") return;
    sup.runtime = { kind: "failing" };
    const observedAt = new Date().toISOString();
    const { requestId, precedingRequestId } = requestContextOf(sup.activity);
    recorder.record("runtime_failure", {
      code,
      message,
      pid: sup.child?.pid,
      heartbeatAgeMs: performance.now() - sup.lastHeartbeat,
      supervisorTickDelayMs: watchdogDelayMs,
      activity: sup.activity,
      activityAgeMs: sup.activity === null ? null : Date.now() - sup.activity.observedAt,
      pending: [...pending].map(({ id, method, tool, path, httpMethod }) => ({ id, method, tool, path, httpMethod })),
    });
    // Stop only the child we spawned. SIGKILL also covers an event loop that
    // cannot process SIGTERM; it never asks that loop to perform its own rescue.
    sup.child?.kill("SIGKILL");
    const captured = await recorder.capture(
      incidentTriggerOf(code),
      requestId,
      precedingRequestId,
    );
    const incident: IncidentReference =
      captured.kind === "completed"
        ? captured.reference
        : {
            incidentId: "supervisor-write-failed",
            trigger: incidentTriggerOf(code),
            requestId,
            precedingRequestId,
            artifact: { kind: "failed", error: captured.kind === "failed" ? captured.error : "Capture was coalesced." },
          };
    const failure: RuntimeFailure = {
      ...(sup.activity?.active.find((scope) => scope.owner.actionId)?.owner.actionId
        ? { actionId: sup.activity.active.find((scope) => scope.owner.actionId)!.owner.actionId! } : {}),
      code,
      observedAt,
      message: `${message} Failure observed at ${observedAt}; this runtime has been stopped and requires a restart.`,
      incident,
      activity: sup.activity,
    };
    for (const entry of pending) {
      pending.delete(entry); // Its upstream error below is ours, not a second failure of the restarted runtime.
      entry.upstream.destroy();
      answerFailure(entry.response, entry.id, failure);
    }
    console.error(`[minecraft-supervisor] ${JSON.stringify(failure)}`);
    restartOrStayFailed(sup, code, failure, startChild);
  };

  const app = createMcpExpressApp({ host: options.host, allowedHosts: ["127.0.0.1", "localhost", "[::1]"] });
  app.use((request, response) => {
    if (request.method === "GET" && request.path === "/diagnostics/runtime") {
      response.json({ state: sup.runtime.kind, heartbeatAgeMs: performance.now() - sup.lastHeartbeat, activity: sup.activity, heartbeat: sup.heartbeat });
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
    recorder.record("http_request", { id: entry.id, method: entry.method, tool: entry.tool, path: request.path });
    upstream.on("response", (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    });
    upstream.on("error", (error) => {
      if (!pending.has(entry)) return; // A cancelled HTTP request does not mean the runtime failed.
      if (sup.runtime.kind === "failed") answerFailure(response, entry.id, sup.runtime.failure);
      else if (sup.runtime.kind !== "failing" && !sup.stopping)
        void fail("RUNTIME_EXITED", `Runtime transport failed: ${error.message}`);
    });
    response.once("close", () => {
      pending.delete(entry);
      upstream.destroy();
    });
    upstream.end(body);
  });
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
  /** Starts the runtime child; a handler ignores any child but the current one (a killed one still exits later). */
  const startChild = () => {
    const started = spawn(options.executable, [...options.args], {
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    sup.child = started;
    started.on("message", (raw: unknown) => handleRuntimeMessage(sup, started, raw));
    started.once("error", (error) => {
      if (started === sup.child) void fail("RUNTIME_EXITED", error.message);
    });
    started.once("exit", (code, signal) => {
      if (started === sup.child) void fail("RUNTIME_EXITED", `Runtime exited: code=${code}, signal=${signal}.`);
    });
  };
  startChild();
  const watchdog = setInterval(() => {
    const now = performance.now();
    watchdogDelayMs = Math.max(0, now - lastWatchdogTick - RUNTIME_HEARTBEAT_MS);
    lastWatchdogTick = now;
    // A watchdog that missed its own liveness window cannot attribute that
    // gap to the child. Resume observation before judging it; queued IPC and
    // a child recovering from the same scheduling pause get a full window.
    const deadlineMs = sup.runtime.kind === "starting" ? (options.deadlines?.startupMs ?? RUNTIME_STARTUP_MS) : (options.deadlines?.unresponsiveMs ?? RUNTIME_UNRESPONSIVE_MS);
    if (watchdogDelayMs >= deadlineMs) {
      sup.observationResumedAt = now;
      recorder.record("supervisor_observation_resumed", {
        supervisorTickDelayMs: watchdogDelayMs,
        heartbeatAgeMs: now - sup.lastHeartbeat,
      });
    }
    const age = now - Math.max(sup.lastHeartbeat, sup.observationResumedAt);
    if (age >= deadlineMs)
      void fail(
        "RUNTIME_UNRESPONSIVE",
        `Runtime event-loop heartbeat absent for ${Math.round(now - sup.lastHeartbeat)} ms.`,
      );
  }, RUNTIME_HEARTBEAT_MS);
  const stop = async () => {
    sup.stopping = true;
    clearInterval(watchdog);
    if (sup.child?.pid !== undefined && sup.child.exitCode === null && sup.child.signalCode === null) {
      const stopped = new Promise<void>((resolve) => sup.child!.once("exit", () => resolve()));
      sup.child.kill("SIGTERM");
      // Normal disposal gets the same liveness allowance as execution. A
      // cleanup loop must not keep the owned child alive after service stop.
      const force = setTimeout(() => sup.child?.kill("SIGKILL"), RUNTIME_UNRESPONSIVE_MS);
      try {
        await stopped;
      } finally {
        clearTimeout(force);
      }
    }
    for (const entry of pending) {
      entry.response.destroy();
      entry.upstream.destroy();
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await recorder.flush();
  };
  const close = () => (closing ??= stop());
  return {
    server,
    get child(): ChildProcess { return sup.child!; },
    /** For the supervisor process's own unhandled rejections (the runtime's arrive over IPC). */
    reportProcessFault: (fault: ProcessFault) => reportProcessFault(sup, fault, "supervisor"),
    close,
    [Symbol.asyncDispose]: close,
  };
}

/** Applies one message of the current runtime child; a failed, failing or replaced child's messages are ignored. */
function handleRuntimeMessage(sup: SupervisorState, from: ChildProcess, raw: unknown): void {
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
    sup.lastHeartbeat = performance.now();
    sup.heartbeat = event;
  }
  if (event.kind === "ready") {
    sup.runtime = { kind: "ready", port: event.port };
    // Ready shows a live loop; the shorter deadline counts from here, not from the last start-up heartbeat.
    sup.lastHeartbeat = performance.now();
  }
}

/** After a failure: starts the runtime once per restart window, else the supervisor stays failed with that failure. */
function restartOrStayFailed(
  sup: SupervisorState,
  code: ObservedFailureCode,
  failure: RuntimeFailure,
  startChild: () => void,
): void {
  const now = performance.now();
  const window = sup.options.restartWindowMs ?? RUNTIME_RESTART_WINDOW_MS;
  if (sup.stopping || window <= 0 || (sup.lastRestartAt !== null && now - sup.lastRestartAt < window)) {
    sup.runtime = { kind: "failed", failure };
    return;
  }
  sup.lastRestartAt = now;
  sup.recorder.record("runtime_restarted", { after: code, previousPid: sup.child?.pid });
  sup.runtime = { kind: "starting" };
  sup.lastHeartbeat = now;
  sup.observationResumedAt = now;
  sup.heartbeat = null;
  sup.activity = null;
  try {
    startChild();
  } catch (cause) {
    // A spawn that throws must not leave the supervisor `failing` (it would answer 503 for ever) nor reject into `fail`'s caller.
    stayFailedAfterRestartFailed(sup, failure, cause);
  }
}

/** The restart itself failed: the supervisor stays failed and every later call is answered with why the runtime is not back. */
function stayFailedAfterRestartFailed(sup: SupervisorState, failure: RuntimeFailure, cause: unknown): void {
  const observedAt = new Date().toISOString();
  const reason = cause instanceof Error ? cause.message : String(cause);
  const restartFailure: RuntimeFailure = {
    ...failure,
    code: "RUNTIME_RESTART_FAILED",
    observedAt,
    message: `Starting the runtime again after ${failure.code} failed: ${reason}. Failure observed at ${observedAt}; this runtime has been stopped and requires a restart of the host.`,
  };
  sup.recorder.record("runtime_restart_failed", { after: failure.code, reason });
  sup.runtime = { kind: "failed", failure: restartFailure };
  console.error(`[minecraft-supervisor] ${JSON.stringify(restartFailure)}`);
}

/** The request an incident belongs to: the one running in the runtime's last activity, else the one that just closed. */
function requestContextOf(activity: RuntimeActivity | null): { requestId: number | null; precedingRequestId: number | null } {
  const requestId = activity?.active.find((scope) => scope.owner.requestId != null)?.owner.requestId ?? null;
  return { requestId, precedingRequestId: requestId === null ? (activity?.precedingRequestId ?? null) : null };
}

function incidentTriggerOf(code: ObservedFailureCode): "runtime_unresponsive" | "runtime_exited" {
  return code === "RUNTIME_UNRESPONSIVE" ? "runtime_unresponsive" : "runtime_exited";
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

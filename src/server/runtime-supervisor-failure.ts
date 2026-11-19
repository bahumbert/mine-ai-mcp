/** What the supervisor does when the runtime fails: the incident, the answer to every call in flight, the restart (split from runtime-supervisor.ts). */
import os from "node:os";
import type { ServerResponse } from "node:http";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { IncidentReference } from "../bot-data/incident-log.js";
import type { IncidentRecorder } from "../diagnostics/incident-recorder.js";
import { decideRestart, type RestartDecision } from "./restart-policy.js";
import { RUNTIME_RESTART, type RestartSettings } from "./runtime-liveness.js";
import {
  printSupervisorLine,
  requestContextOf,
  TICK_HISTORY_MS,
  type McpSupervisorOptions,
  type ObservedFailureCode,
  type RuntimeFailure,
  type SupervisorParts,
  type SupervisorState,
} from "./runtime-supervisor-state.js";

/**
 * The runtime failed (once: a failure being recorded or saved ignores the next): the child is killed, the incident
 * captured, every call in flight on HTTP and on the links answered with the failure, and the restart scheduled.
 */
export async function failRuntime(parts: SupervisorParts, code: ObservedFailureCode, message: string): Promise<void> {
  const { sup, pending, links } = parts;
  if (sup.stopping || sup.runtime.kind === "failed" || sup.runtime.kind === "failing") return;
  sup.runtime = { kind: "failing" };
  const observedAt = new Date().toISOString();
  const { requestId, precedingRequestId } = requestContextOf(sup.activity);
  const machine = tickDelaysAtFailure(sup); // Read before the capture: it is the supervisor's lateness at the failure.
  const planned = planRestart(sup);
  sup.recorder.record("runtime_failure", {
    code,
    message,
    pid: sup.child?.pid,
    heartbeatAgeMs: performance.now() - sup.lastHeartbeat,
    supervisorTickDelayMs: machine.supervisorTickDelayMs,
    activity: sup.activity,
    activityAgeMs: sup.activity === null ? null : Date.now() - sup.activity.observedAt,
    pending: [
      ...[...pending].map(({ id, method, tool, path, httpMethod }) => ({ id, method, tool, path, httpMethod })),
      ...links.pendingRequests(),
    ],
  });
  // Stop only the child we spawned. SIGKILL also covers an event loop that
  // cannot process SIGTERM; it never asks that loop to perform its own rescue.
  sup.child?.kill("SIGKILL");
  const captured = await sup.recorder.capture(incidentTriggerOf(code), requestId, precedingRequestId);
  const incident = incidentReferenceOf(captured, code, requestId, precedingRequestId);
  const decision = sup.stopping ? null : planned; // A close during the capture schedules nothing, and the failure says so.
  const outlook = restartOutlook(sup.options, decision);
  const failure: RuntimeFailure = {
    ...(sup.activity?.active.find((scope) => scope.owner.actionId)?.owner.actionId
      ? { actionId: sup.activity.active.find((scope) => scope.owner.actionId)!.owner.actionId! } : {}),
    code,
    observedAt,
    message: `${message} Failure observed at ${observedAt}; ${outlook.tail}`,
    incident,
    activity: sup.activity,
    restart: outlook.restart,
  };
  for (const entry of pending) {
    pending.delete(entry); // Its upstream error below is ours, not a second failure of the restarted runtime.
    entry.upstream.destroy();
    answerFailure(entry.response, entry.id, failure);
  }
  // Requests that reached the supervisor during the capture are in the list now: every link call ends with the failure.
  links.failAll((id) => failureMessage(id, failure) as JSONRPCMessage);
  printSupervisorLine(sup, failure);
  scheduleRestart(sup, code, decision, failure, machine, parts.startChild);
}

/** The JSON-RPC error that answers a call with the saved failure; HTTP and links send the same body. */
function failureMessage(id: string | number | null, failure: RuntimeFailure) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code: -32603, message: `[${failure.code}] ${failure.message}`, data: failure },
  };
}

/** Answers one pending or later MCP call with the saved failure, as a JSON-RPC error over the channel the call came in on. */
export function answerFailure(response: ServerResponse, id: string | number | null, failure: RuntimeFailure): void {
  if (response.writableEnded || response.destroyed) return;
  const body = JSON.stringify(failureMessage(id, failure));
  if (response.headersSent) {
    if (String(response.getHeader("content-type")).includes("text/event-stream"))
      response.end(`\n\nevent: message\ndata: ${body}\n\n`);
    else response.destroy(new Error(failure.message));
    // A completed JSON-RPC exchange uses HTTP 200 even when its result is an
    // error. HTTP 503 makes the SDK discard the structured MCP error as a
    // transport failure. Observational HTTP requests still receive 503.
  } else response.writeHead(id === null ? 503 : 200, { "content-type": "application/json" }).end(body);
}

/** The receipt of the failure's incident: the saved artifact's, or one saying the supervisor could not write it. */
function incidentReferenceOf(
  captured: Awaited<ReturnType<IncidentRecorder["capture"]>>,
  code: ObservedFailureCode,
  requestId: number | null,
  precedingRequestId: number | null,
): IncidentReference {
  if (captured.kind === "completed") return captured.reference;
  return {
    incidentId: "supervisor-write-failed",
    trigger: incidentTriggerOf(code),
    requestId,
    precedingRequestId,
    artifact: { kind: "failed", error: captured.kind === "failed" ? captured.error : "Capture was coalesced." },
  };
}

/** The restart settings the supervisor runs with: the option, else production's; `null` (never restart) is kept as given. */
const restartSettingsOf = (options: McpSupervisorOptions): RestartSettings | null =>
  options.restart === undefined ? RUNTIME_RESTART : options.restart;

/** The supervisor's lateness now and its largest over the last minute: whether the machine was starving it at the failure. */
function tickDelaysAtFailure(sup: SupervisorState): { supervisorTickDelayMs: number; maxTickDelayMs: number } {
  const since = performance.now() - TICK_HISTORY_MS;
  const recent = sup.tickDelays.filter((tick) => tick.at >= since).map((tick) => tick.delayMs);
  return { supervisorTickDelayMs: sup.watchdogDelayMs, maxTickDelayMs: Math.max(0, ...recent) };
}

/**
 * What the policy decides for a failure seen now (the streak moves with it), else `null` when the supervisor is
 * stopping or runs without restart settings. The delay is whole milliseconds: the line, the timer and `at` agree.
 */
function planRestart(sup: SupervisorState): RestartDecision | null {
  const settings = restartSettingsOf(sup.options);
  if (sup.stopping || settings === null) return null;
  const decision = decideRestart(sup.streak, performance.now(), settings, Math.random);
  sup.streak = decision.streak;
  return decision.kind === "restart" ? { ...decision, delayMs: Math.round(decision.delayMs) } : decision;
}

/**
 * The failure's `restart` field and the tail of its message: when the runtime starts again, that it stays down for
 * good, or (no decision: no restart option, or stopping) that it requires a restart. `at` is display only.
 */
function restartOutlook(options: McpSupervisorOptions, decision: RestartDecision | null): { restart: RuntimeFailure["restart"]; tail: string } {
  if (decision?.kind === "restart") {
    const at = new Date(Date.now() + decision.delayMs).toISOString();
    return {
      restart: { attempt: decision.attempt, of: decision.of, at },
      tail: `this runtime has been stopped; it starts again at ${at} (restart ${decision.attempt} of ${decision.of}).`,
    };
  }
  if (decision?.kind === "give_up") {
    const healthyMinutes = Number((restartSettingsOf(options)!.healthyMs / 60_000).toFixed(1));
    return {
      restart: null,
      tail: `this runtime has been stopped and stays down after ${decision.of} restarts in a row without ${healthyMinutes} min of play: restart the host.`,
    };
  }
  return { restart: null, tail: "this runtime has been stopped and requires a restart." };
}

/**
 * After a failure the supervisor is `failed` with that failure; for a `restart` decision a timer starts the runtime
 * again after the delay (calls meanwhile get the failure). A close, before or during the wait, starts nothing.
 */
function scheduleRestart(
  sup: SupervisorState,
  code: ObservedFailureCode,
  decision: RestartDecision | null,
  failure: RuntimeFailure,
  machine: { supervisorTickDelayMs: number; maxTickDelayMs: number },
  startChild: () => void,
): void {
  sup.runtime = { kind: "failed", failure };
  if (sup.stopping || decision?.kind !== "restart") return;
  const scheduled = {
    event: "restart_scheduled",
    observedAt: new Date().toISOString(),
    attempt: decision.attempt,
    of: decision.of,
    delayMs: decision.delayMs,
    ...machine,
    loadavg: os.loadavg(),
    hostFreeMemMB: Math.round(os.freemem() / 1_048_576), // The OS the host runs in: WSL's under WSL.
  };
  const { event: _event, ...recorded } = scheduled;
  sup.recorder.record("runtime_restart_scheduled", recorded);
  printSupervisorLine(sup, scheduled);
  sup.restartTimer = setTimeout(() => {
    sup.restartTimer = null;
    if (sup.stopping) return;
    startAfterFailure(sup, code, failure, startChild);
  }, decision.delayMs);
  sup.restartTimer.unref();
}

/** The restart timer's turn: the runtime is `starting` with fresh liveness clocks, or the supervisor stays failed if the spawn throws. */
function startAfterFailure(sup: SupervisorState, code: ObservedFailureCode, failure: RuntimeFailure, startChild: () => void): void {
  const now = performance.now();
  sup.recorder.record("runtime_restarted", { after: code, previousPid: sup.child?.pid });
  sup.runtime = { kind: "starting" };
  sup.lastHeartbeat = now;
  sup.observationResumedAt = now;
  sup.heartbeat = null;
  sup.activity = null;
  try {
    startChild();
  } catch (cause) {
    // A spawn that throws must not leave the supervisor `failing` (it would answer 503 for ever) nor reject into the timer.
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
    restart: null,
  };
  sup.recorder.record("runtime_restart_failed", { after: failure.code, reason });
  sup.runtime = { kind: "failed", failure: restartFailure };
  printSupervisorLine(sup, restartFailure);
}

function incidentTriggerOf(code: ObservedFailureCode): "runtime_unresponsive" | "runtime_exited" {
  return code === "RUNTIME_UNRESPONSIVE" ? "runtime_unresponsive" : "runtime_exited";
}

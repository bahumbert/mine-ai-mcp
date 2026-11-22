/** What the supervisor's files share: its options, its state, the failure and the steps' common parts (split from runtime-supervisor.ts). */
import type { ClientRequest, ServerResponse } from "node:http";
import type { z } from "zod";
import type { IncidentReference, IncidentRetention } from "../bot-data/incident-log.js";
import type { IncidentRecorder, SourceIdentity } from "../diagnostics/incident-recorder.js";
import type { RestartStreak } from "./restart-policy.js";
import type { RestartSettings, RuntimeActivity, runtimeMessageSchema } from "./runtime-liveness.js";
import type { LinkHub } from "./runtime-supervisor-links.js";

export interface PendingRequest {
  readonly response: ServerResponse;
  readonly upstream: ClientRequest;
  readonly id: string | number | null;
  readonly method: string | null;
  readonly tool: string | null;
  readonly path: string;
  readonly httpMethod: string;
}
/** What the watchdog or the child's exit observed; a failed restart has a code of its own. */
export type ObservedFailureCode = "RUNTIME_UNRESPONSIVE" | "RUNTIME_EXITED";
export interface RuntimeFailure {
  readonly actionId?: string;
  readonly code: ObservedFailureCode | "RUNTIME_RESTART_FAILED";
  readonly observedAt: string;
  readonly message: string;
  readonly incident: IncidentReference;
  readonly activity: RuntimeActivity | null;
  /** When the supervisor starts the runtime again (`at`: display only) or `null` when it stays down; last field. */
  readonly restart: { readonly attempt: number; readonly of: number; readonly at: string } | null;
}
export type RuntimeState =
  | { kind: "starting" }
  | { kind: "ready"; port: number }
  | { kind: "failing" }
  | { kind: "failed"; failure: RuntimeFailure };

/** Monotonic watchdog time and cancellable timers, shared with the manual test clock. */
export interface SupervisorClock {
  now(): number;
  every(tick: () => void, ms: number): () => void;
  /** `unref`: the wait does not keep the process alive (the real clock; a manual clock has no process to keep). */
  after(ms: number, fire: () => void, options?: { readonly unref?: boolean }): () => void;
}

/**
 * Only the child-process lifecycle and IPC surface the supervisor owns. The runtime links need `send` and `connected`;
 * a child that has no IPC channel of its own (a test fixture) leaves them out, and a link then fails to write.
 */
export interface RuntimeChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly connected?: boolean;
  send?(message: unknown, callback?: (error: Error | null) => void): boolean;
  on(event: "message", listener: (message: unknown) => void): this;
  off(event: "message", listener: (message: unknown) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal: NodeJS.Signals): boolean;
}

export interface McpSupervisorOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly host: string;
  readonly port: number;
  readonly instanceId: string;
  readonly source: SourceIdentity;
  readonly incidents: { directory: string; retention: IncidentRetention };
  readonly clock?: SupervisorClock;
  /** Wall-clock reading of the incident ring's row times and ageing (default `Date.now`); tests pass their manual clock's `now`. */
  readonly wallClock?: () => number;
  readonly spawnRuntime?: (executable: string, args: readonly string[]) => RuntimeChild;
  /**
   * Silence allowed before `ready` and after it, the watchdog's interval (default `RUNTIME_HEARTBEAT_MS`) and the
   * wait between SIGTERM and SIGKILL at close (default `RUNTIME_UNRESPONSIVE_MS`). Tests can inject a clock and
   * child to move these deadlines without waiting for real time.
   */
  readonly deadlines?: {
    readonly startupMs: number;
    readonly unresponsiveMs: number;
    readonly heartbeatMs?: number;
    readonly killGraceMs?: number;
  };
  /**
   * How a killed runtime is started again (default `RUNTIME_RESTART`; the host passes its flags); `null` never
   * restarts, which is not the same as leaving it out.
   */
  readonly restart?: RestartSettings | null;
  /** Receives the failure and restart event lines, `[minecraft-supervisor] …` (default `console.error`), so tests read them. */
  readonly log?: (line: string) => void;
  /** How far back the supervisor's incident ring keeps rows (default `INCIDENT_HISTORY_MS`); a test shortens it to see rows age out. */
  readonly incidentHistoryMs?: number;
}

export type HeartbeatMessage = Extract<z.infer<typeof runtimeMessageSchema>, { kind: "heartbeat" }>;
/** What the supervisor changes while it runs; the steps below the supervisor take it explicitly. */
export interface SupervisorState {
  readonly options: McpSupervisorOptions;
  readonly clock: SupervisorClock;
  readonly recorder: IncidentRecorder;
  runtime: RuntimeState;
  lastHeartbeat: number;
  observationResumedAt: number;
  /** When the watchdog last ran, and how late that run was past its interval (the supervisor's own blind gap). */
  lastWatchdogTick: number;
  watchdogDelayMs: number;
  stopping: boolean;
  child: RuntimeChild | null;
  /** The failures in a row since the runtime last played `healthyMs` (see `decideRestart`). */
  streak: RestartStreak;
  /** Cancels the wait before a scheduled restart (set while it runs; the runtime is `failed` meanwhile). */
  restartTimer: (() => void) | null;
  /** The watchdog's lateness over the last {@link TICK_HISTORY_MS}, for the restart line. */
  tickDelays: { readonly at: number; readonly delayMs: number }[];
  activity: RuntimeActivity | null;
  heartbeat: HeartbeatMessage | null;
}
export const TICK_HISTORY_MS = 60_000;

/** What the supervisor's steps share: its state, the HTTP calls in flight, the links, and the two steps that call each other. */
export interface SupervisorParts {
  readonly sup: SupervisorState;
  readonly pending: Set<PendingRequest>;
  readonly links: LinkHub;
  fail(code: ObservedFailureCode, message: string): Promise<void>;
  startChild(): void;
}

/** One `[minecraft-supervisor] <json>` line to the option's `log` (default stderr). */
export function printSupervisorLine(sup: SupervisorState, payload: object): void {
  (sup.options.log ?? console.error)(`[minecraft-supervisor] ${JSON.stringify({ instanceId: sup.options.instanceId, ...payload })}`);
}

/** The request an incident belongs to: the one running in the runtime's last activity, else the one that just closed. */
export function requestContextOf(activity: RuntimeActivity | null): { requestId: number | null; precedingRequestId: number | null } {
  const requestId = activity?.active.find((scope) => scope.owner.requestId != null)?.owner.requestId ?? null;
  return { requestId, precedingRequestId: requestId === null ? (activity?.precedingRequestId ?? null) : null };
}

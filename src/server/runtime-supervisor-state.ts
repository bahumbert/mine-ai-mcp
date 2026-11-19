/** What the supervisor's files share: its options, its state, the failure and the steps' common parts (split from runtime-supervisor.ts). */
import type { ChildProcess } from "node:child_process";
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

export interface McpSupervisorOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly host: string;
  readonly port: number;
  readonly instanceId: string;
  readonly source: SourceIdentity;
  readonly incidents: { directory: string; retention: IncidentRetention };
  /**
   * Silence allowed before `ready` and after it, the watchdog's interval (default `RUNTIME_HEARTBEAT_MS`) and the
   * wait between SIGTERM and SIGKILL at close (default `RUNTIME_UNRESPONSIVE_MS`); for tests that cannot wait
   * the real deadlines, since the runtime is a real child process no fake clock reaches.
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
  readonly recorder: IncidentRecorder;
  runtime: RuntimeState;
  lastHeartbeat: number;
  observationResumedAt: number;
  /** When the watchdog last ran, and how late that run was past its interval (the supervisor's own blind gap). */
  lastWatchdogTick: number;
  watchdogDelayMs: number;
  stopping: boolean;
  child: ChildProcess | null;
  /** The failures in a row since the runtime last played `healthyMs` (see `decideRestart`). */
  streak: RestartStreak;
  /** The wait before a scheduled restart; the runtime is `failed` while it runs. */
  restartTimer: NodeJS.Timeout | null;
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

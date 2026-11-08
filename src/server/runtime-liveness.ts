import { z } from "zod";
import { observeExecution, type ExecutionEvent } from "../execution/execution-scope.js";
import { processFaultSchema } from "./process-faults.js";

// Four liveness observations per second; five seconds leaves 25 seconds before
// the observed Minecraft keepalive timeout. This never limits action duration.
export const RUNTIME_HEARTBEAT_MS = 250;
export const RUNTIME_UNRESPONSIVE_MS = 5_000;
/**
 * The silence allowed before the runtime reports `ready`: loading its modules blocks the event loop for seconds, more
 * with the server, Ollama and other hosts starting beside it (live 2026-10-11: a host killed at start, heartbeat absent
 * 5 s, while its module graph loaded). After `ready`, {@link RUNTIME_UNRESPONSIVE_MS} applies.
 */
export const RUNTIME_STARTUP_MS = 30_000;
/** A random wait between `minMs` and `maxMs` before a restart, so runtimes that failed together do not start together. */
export interface RestartDelay {
  readonly minMs: number;
  readonly maxMs: number;
}
export interface RestartSettings {
  /** The delay range of each attempt in a row; past the list the last range repeats. At least one; `minMs <= maxMs`. */
  readonly delays: readonly RestartDelay[];
  /** Failed attempts in a row after which the runtime stays down for good (a crash loop is not hidden behind restarts). */
  readonly attempts: number;
  /** Play time after `ready` that starts a new streak at the next failure. */
  readonly healthyMs: number;
}
/**
 * A killed runtime is started again after a growing, random delay, up to `attempts` times in a row. The host flags
 * `--restart-delays-ms`, `--restart-attempts` and `--restart-reset-after-ms` override these.
 * - delay 1, 0-5 s: run 34 restarted 8 runtimes in the same 6 s; one runtime alone loses at most 5 s more.
 * - delay 2, 15-30 s: after the machine's 30 s start-up allowance, not into the same stall.
 * - delays 3 and 4, 1-2 min and 4-8 min: growing by four, a longer stall is waited out, not hammered.
 * - delays 5 and 6, 5-10 min: never more than 10 min between tries.
 * - `attempts` 6: the six delays are ~15-31 min of tries, then down.
 * - `healthyMs` 10 min: 10 min of play resets the streak.
 */
export const RUNTIME_RESTART: RestartSettings = {
  delays: [
    { minMs: 0, maxMs: 5_000 },
    { minMs: 15_000, maxMs: 30_000 },
    { minMs: 60_000, maxMs: 120_000 },
    { minMs: 240_000, maxMs: 480_000 },
    { minMs: 300_000, maxMs: 600_000 },
    { minMs: 300_000, maxMs: 600_000 },
  ],
  attempts: 6,
  healthyMs: 600_000,
};
const ownerSchema = z.object({
  bot: z.string(),
  operation: z.string(),
  targetId: z.number().nullable(),
  requestId: z.number().nullable().optional(),
  actionId: z.string().optional(),
});
const executionSchema = z.object({
  scopeId: z.string(),
  owner: ownerSchema,
  at: z.number(),
  sequence: z.number(),
  phase: z.string(),
  activePhase: z.string().nullable(),
  kind: z.enum(["entered", "returned", "closed", "yielded", "progress"]),
  reason: z.string().nullable().optional(),
  iterations: z.number().optional(),
  uninterruptedMs: z.number().optional(),
  firstYield: z.boolean().optional(),
});
const activitySchema = z.object({
  observedAt: z.number(),
  active: z.array(executionSchema),
  precedingRequestId: z.number().nullable(),
});
export type RuntimeActivity = z.infer<typeof activitySchema>;
export const runtimeMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), port: z.number().int().positive() }),
  z.object({
    kind: z.literal("heartbeat"),
    sequence: z.number().int(),
    executionEvents: z.number().int(),
    omitted: z.number().int(),
    memory: z.object({ rss: z.number(), heapUsed: z.number(), heapTotal: z.number(), external: z.number() }),
    activity: activitySchema,
  }),
  z.object({
    kind: z.literal("execution"),
    event: executionSchema,
    activity: activitySchema,
  }),
  /** A promise the runtime left unhandled: the supervisor records it as a `process_fault` incident. */
  z.object({ kind: z.literal("fault"), fault: processFaultSchema }),
]);

/**
 * The heartbeat is sent only by a timer, never from an execution checkpoint.
 * IPC has at most one write in flight and one latest transition waiting: a
 * stopped supervisor cannot make execution telemetry allocate without bound.
 * Omitted transitions are counted, not silently presented as a complete trace.
 */
export function reportRuntimeLiveness(): Disposable {
  // Lifetimes, not a time window: a quiet route remains attributable after its
  // entered event leaves the incident ring. Full snapshots survive IPC coalescing.
  const active = new Map<string, ExecutionEvent>();
  let precedingRequestId: number | null = null;
  const activity = (): RuntimeActivity => ({
    observedAt: Date.now(),
    active: [...active.values()],
    precedingRequestId,
  });
  let writing = false;
  let pending: ExecutionEvent | null = null;
  let omitted = 0;
  let executionEvents = 0;
  let sequence = 0;
  let heartbeatWriting = false;
  const publish = (event: ExecutionEvent) => {
    if (!process.connected || !process.send) return;
    if (writing) {
      if (pending) omitted++;
      pending = event;
      return;
    }
    writing = true;
    process.send({ kind: "execution", event, activity: activity() }, () => {
      writing = false;
      const latest = pending;
      pending = null;
      if (latest) publish(latest);
    });
  };
  const remove = observeExecution((event) => {
    if (event.activePhase === null) active.delete(event.scopeId);
    else active.set(event.scopeId, event);
    if (event.kind === "closed" && event.owner.requestId != null) precedingRequestId = event.owner.requestId;
    executionEvents++;
    publish(event);
  });
  const heartbeat = setInterval(() => {
    if (!process.connected || !process.send || heartbeatWriting) return;
    heartbeatWriting = true;
    process.send(
      {
        kind: "heartbeat",
        sequence: ++sequence,
        executionEvents,
        omitted,
        memory: process.memoryUsage(),
        activity: activity(),
      },
      () => {
        heartbeatWriting = false;
      },
    );
  }, RUNTIME_HEARTBEAT_MS);
  heartbeat.unref();
  return {
    [Symbol.dispose]() {
      clearInterval(heartbeat);
      remove();
    },
  };
}

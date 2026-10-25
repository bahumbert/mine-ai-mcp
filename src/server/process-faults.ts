// What a process does with a promise rejection nobody handled: report it and keep running, never exit on it.
import { z } from "zod";

export const processFaultSchema = z.object({
  kind: z.literal("unhandled_rejection"),
  message: z.string(),
  stack: z.string().nullable(),
  observedAt: z.string(),
  /** How many more times this identical fault happened since its previous report (0 for the first, full report). */
  repeats: z.number().int().nonnegative(),
});
export type ProcessFault = z.infer<typeof processFaultSchema>;

/** An identical fault is reported again, as a count, at most this often: a fault in a loop cannot flood the log or the IPC channel. */
export const PROCESS_FAULT_REPEAT_REPORT_MS = 60_000;
/** Distinct messages remembered for counting; the oldest is reported and forgotten past this (messages that carry ids never repeat). */
const REMEMBERED_FAULTS = 100;

interface FaultTally {
  lastReportedAt: number;
  held: number;
  latest: ProcessFault;
}

export interface ProcessFaultReporterOptions {
  readonly repeatReportMs?: number;
}

/** Reports unhandled rejections instead of letting Bun exit; identical faults are reported once, then counted. */
export function reportUnhandledRejections(
  report: (fault: ProcessFault) => void,
  options: ProcessFaultReporterOptions = {},
): Disposable {
  const repeatReportMs = options.repeatReportMs ?? PROCESS_FAULT_REPEAT_REPORT_MS;
  const tallies = new Map<string, FaultTally>();
  // A throw in this listener would be an uncaught exception, the very exit it exists to prevent.
  const send = (fault: ProcessFault) => {
    try {
      report(fault);
    } catch (cause) {
      process.stderr.write(`[process-faults] the fault reporter failed: ${describeReason(cause).message}\n`);
    }
  };
  const flush = (tally: FaultTally, at: number) => {
    send({ ...tally.latest, repeats: tally.held });
    tally.held = 0;
    tally.lastReportedAt = at;
  };
  const listener = (reason: unknown) => {
    const now = performance.now();
    const fault = faultOf(reason);
    const tally = tallies.get(fault.message);
    if (tally === undefined) {
      rememberFault(tallies, fault.message, { lastReportedAt: now, held: 0, latest: fault }, flush);
      send(fault);
      return;
    }
    tally.held++;
    tally.latest = fault;
    if (now - tally.lastReportedAt >= repeatReportMs) flush(tally, now);
  };
  process.on("unhandledRejection", listener);
  return {
    [Symbol.dispose]() {
      process.off("unhandledRejection", listener);
      for (const tally of tallies.values()) if (tally.held > 0) flush(tally, performance.now());
      tallies.clear();
    },
  };
}

function rememberFault(
  tallies: Map<string, FaultTally>,
  message: string,
  tally: FaultTally,
  flush: (tally: FaultTally, at: number) => void,
): void {
  if (tallies.size >= REMEMBERED_FAULTS) {
    const [oldest, forgotten] = tallies.entries().next().value!;
    if (forgotten.held > 0) flush(forgotten, performance.now());
    tallies.delete(oldest);
  }
  tallies.set(message, tally);
}

function faultOf(reason: unknown): ProcessFault {
  const { message, stack } = describeReason(reason);
  return { kind: "unhandled_rejection", message, stack, observedAt: new Date().toISOString(), repeats: 0 };
}

/** A reason is anything a promise was rejected with: an Error, a string, an object, undefined. */
function describeReason(reason: unknown): { message: string; stack: string | null } {
  if (reason instanceof Error) return { message: reason.message, stack: reason.stack ?? null };
  try {
    return { message: String(reason), stack: null };
  } catch {
    return { message: "an unprintable rejection reason", stack: null };
  }
}

/** The stderr text of a fault; `label` names the process (`runtime`, `host`). */
export function formatProcessFault(label: string, fault: ProcessFault): string {
  const count = fault.repeats > 0 ? ` (${fault.repeats} more since the last report)` : "";
  const stack = fault.stack === null || fault.repeats > 0 ? "" : `\n${fault.stack}`;
  return `[${label}] unhandled rejection: ${fault.message}${count}${stack}\n`;
}

/** Where a fault is written and sent: a child process's stderr and its IPC channel to the supervisor. */
interface FaultChannel {
  readonly connected?: boolean;
  send?(message: unknown): boolean;
}

/** Writes the fault to stderr and, while this process has a supervisor on an IPC channel, sends it there; neither throws. */
export function reportFaultToStderrAndParent(
  label: string,
  fault: ProcessFault,
  channel: FaultChannel = process,
  stderr: { write(text: string): unknown } = process.stderr,
): void {
  stderr.write(formatProcessFault(label, fault));
  if (!channel.connected || !channel.send) return;
  try {
    channel.send({ kind: "fault", fault }); // false: the channel's queue is full; stderr has the fault
  } catch {
    // The channel closed under us: the supervisor is gone or going, stderr has the fault.
  }
}

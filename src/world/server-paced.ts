/** Shared server-tick budgets for runtime limits and scenario observations, bounded when the server stops. */
import type { Bot } from "mineflayer";
import { monotonicNow } from "../utils/monotonic-clock.js";
import { AGE_PACKET_TICKS, MS_PER_ON_TIME_TICK, serverPacedWallMs, serverTickDeadline } from "./world-age.js";

/** Only `ticks` confirms that the server ran the requested window; `unobserved` is a wall-time fallback. */
export type ServerPacedEnd = "ticks" | "unobserved" | "stalled" | "wall";

/** Monotonic time and a disposable repeating look; structurally compatible with the shared fake clock. */
export interface ServerPacedClock {
  readonly now: () => number;
  readonly every: (tick: () => void, ms: number) => () => void;
}

/** Backstops and observation cadence for a budget measured by the server's world age. */
export interface ServerPacedOptions {
  /** Total wall backstop; default `serverPacedWallMs(ticks)`. */
  readonly wallMs?: number;
  /** Still-age bound; default SERVER_CLOCK_STOPPED_MS (20 s), null disables it. */
  readonly stoppedMs?: number | null;
  /** Default: monotonicNow and the global setInterval. */
  readonly clock?: ServerPacedClock;
  /** Milliseconds between looks; default 50. */
  readonly checkMs?: number;
}

/** A budget's signal, latched expiry kind and elapsed time; disposal releases its timer without aborting. */
export interface ServerPacedSignal extends Disposable {
  readonly signal: AbortSignal;
  end(): ServerPacedEnd | null;
  elapsed(): { readonly ms: number; readonly ticks: number | null };
}

/** The observed reason a server-paced budget expired; every end is a runtime timeout, not necessarily server evidence. */
export class ServerPacedExpired extends Error {
  constructor(
    readonly end: ServerPacedEnd,
    readonly ticks: number,
    readonly elapsedMs: number,
    readonly elapsedTicks: number | null,
  ) {
    super(`Server-paced budget ended (${end}): ${elapsedMs} ms, ${elapsedTicks ?? "unknown"} world ticks; budget ${ticks} ticks.`);
    this.name = "ServerPacedExpired";
  }
}

/** The wall clock is only a backstop; elapsed server time always comes from serverTickDeadline. */
const DEFAULT_CLOCK: ServerPacedClock = {
  now: monotonicNow,
  every: (look, ms) => {
    const timer = setInterval(look, ms);
    return () => clearInterval(timer);
  },
};

/** A timer cleanup fault must not hide the answer, cancellation reason or expiry (task review, 2026-11-18). */
function stopTimer(stop: (() => void) | undefined): void {
  try {
    stop?.();
  } catch {
    // The disposer was attempted once; preserve the primary outcome and still remove the abort listener.
  }
}

/** Classify expiry using the same observation and clock as the shared packet-origin deadline (spec D1). */
function pacedDeadline(bot: Pick<Bot, "time">, ticks: number, options: ServerPacedOptions) {
  const clock = options.clock ?? DEFAULT_CLOCK;
  const unobserved = bot.time?.age == null;
  const wallMs = options.wallMs ?? serverPacedWallMs(ticks);
  const deadline = serverTickDeadline(() => bot.time?.age ?? null, ticks, clock.now(), {
    origin: "packet", wallMs, stoppedMs: options.stoppedMs,
  });
  const elapsed = () => deadline.elapsed(clock.now());
  return { clock, elapsed, look(): ServerPacedEnd | null {
    const now = clock.now();
    if (!deadline.passed(now)) return null;
    const spent = deadline.elapsed(now);
    if (spent.ticks !== null && spent.ticks >= ticks + AGE_PACKET_TICKS) return "ticks";
    if (unobserved && spent.ms >= ticks * MS_PER_ON_TIME_TICK) return "unobserved";
    return spent.ms >= wallMs ? "wall" : "stalled";
  } };
}

/**
 * Start a stopwatch on wall time and world age; each read names what a failed wait reports (`elapsedMs`, `elapsedTicks`, spec D5
 * of red-paths-server-ticks). The tick count is null when the age is unknown at the start or at the read.
 */
export function serverPacedElapsed(bot: Pick<Bot, "time">): () => { readonly elapsedMs: number; readonly elapsedTicks: number | null } {
  const startedMs = monotonicNow();
  const startAge = bot.time?.age ?? null;
  return () => {
    const age = bot.time?.age ?? null;
    return { elapsedMs: monotonicNow() - startedMs, elapsedTicks: startAge === null || age === null ? null : age - startAge };
  };
}

/** Abort when the server-tick window, wall backstop or stopped-clock bound ends; dispose on every caller exit. */
export function serverPacedSignal(bot: Pick<Bot, "time">, ticks: number, options: ServerPacedOptions = {}): ServerPacedSignal {
  const budget = pacedDeadline(bot, ticks, options);
  const controller = new AbortController();
  let end: ServerPacedEnd | null = null;
  let disposed = false;
  let stop: (() => void) | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopTimer(stop);
  };
  const look = () => {
    if (disposed) return;
    end = budget.look();
    if (end === null) return;
    const elapsed = budget.elapsed();
    dispose();
    controller.abort(new ServerPacedExpired(end, ticks, elapsed.ms, elapsed.ticks));
  };
  look();
  if (!disposed) stop = budget.clock.every(look, options.checkMs ?? 50);
  return { signal: controller.signal, end: () => end, elapsed: budget.elapsed, [Symbol.dispose]: dispose };
}

/** Wait for an answer before checking expiry; outer cancellation and observation errors reject with their reason. */
export function waitForServerPaced(
  bot: Pick<Bot, "time">,
  ticks: number,
  options: ServerPacedOptions & { readonly until?: () => boolean; readonly signal?: AbortSignal } = {},
): Promise<"until" | ServerPacedEnd> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(options.signal.reason);
    const budget = pacedDeadline(bot, ticks, options);
    let settled = false;
    let stop: (() => void) | undefined;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      stopTimer(stop);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(options.signal?.reason);
    };
    const look = () => {
      if (settled) return;
      try {
        options.signal?.throwIfAborted();
        const end = options.until?.() ? "until" : budget.look();
        if (end === null) return;
        cleanup();
        resolve(end);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    look();
    if (!settled) stop = budget.clock.every(look, options.checkMs ?? 50);
  });
}

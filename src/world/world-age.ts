/**
 * Wait for the server to have had time to answer.
 *
 * "The server handled it" is an answer packet or the world age (`bot.time.age`, the server's own tick count) moving
 * on after the send: packets arrive in order, so a world that moved 40 ticks past our request without the change
 * we wait for will not bring it. Client ticks say nothing of that (physics can be off, the server far behind), and
 * the server clock may stop altogether, so every wait is also bounded on the monotonic wall clock.
 */
import type { Bot } from "mineflayer";

/** `stalled`: the world age stood still for `stallMs`; `timeout`: `wallMs` passed. */
export type WorldAgeWait = "moved" | "until" | "timeout" | "stalled";

export interface WorldAgeOptions {
  /** Longest wait on the monotonic wall clock, whatever the server clock does. */
  readonly wallMs: number;
  /**
   * Longest time the world age may stand still: the bound renews at each move of the age, so a slow server that
   * keeps moving is waited for up to `wallMs`, and a stopped one is given up on after this long. Absent: only `wallMs`.
   */
  readonly stallMs?: number;
  readonly signal?: AbortSignal;
  /** The change waited for; checked at every look. */
  readonly until?: () => boolean;
  /** Milliseconds between looks. */
  readonly pollMs?: number;
  /** Injectable monotonic clock (milliseconds) and sleep, for tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_POLL_MS = 25;

/** Milliseconds per server tick when the server runs on time; used only before any age was heard. */
export const MS_PER_ON_TIME_TICK = 50;

/** A cached age is up to 19 ticks old between regular 20-tick broadcasts (world-age-per-second contract). */
export const STALE_AGE_TICKS = 19;

export interface ServerTickDeadline {
  readonly ticks: number;
  /** Observe the age and latch expiry once the tick budget or stopped-clock bound passes. */
  passed(nowMs: number): boolean;
  /** Observe the age and report time since creation; ticks are unknown until the first age is heard. */
  elapsed(nowMs: number): { readonly ms: number; readonly ticks: number | null };
}

/** A polled, timer-free deadline on the server clock, with a wall fallback before the first time packet. */
export function serverTickDeadline(
  readAge: () => number | null | undefined,
  ticks: number,
  startedMs: number,
): ServerTickDeadline {
  let firstAge = readAge() ?? undefined;
  let lastAge = firstAge;
  let lastMoveMs = startedMs;
  let lastLookMs = startedMs;
  let passed = false;
  const observe = (nowMs: number) => {
    const age = readAge() ?? undefined;
    firstAge ??= age;
    const elapsedTicks = firstAge === undefined || age === undefined ? null : age - firstAge;
    if (age !== undefined && age !== lastAge) [lastAge, lastMoveMs] = [age, nowMs];
    // An unobserved gap cannot distinguish a stopped clock from a later move (a2 review gap 11, 2026-11-15).
    passed ||= (elapsedTicks !== null && elapsedTicks >= ticks)
      || nowMs - lastMoveMs >= SERVER_CLOCK_STOPPED_MS
      || (firstAge === undefined && nowMs - startedMs >= ticks * MS_PER_ON_TIME_TICK)
      || nowMs - lastLookMs >= SERVER_CLOCK_STOPPED_MS;
    lastLookMs = nowMs;
    return { ms: nowMs - startedMs, ticks: elapsedTicks };
  };
  return {
    ticks,
    passed(nowMs) {
      observe(nowMs);
      return passed;
    },
    elapsed: observe,
  };
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Resolve when `until` is true, the world age moved `ticks` past its value now, the age stood still for `stallMs`, or `wallMs` passed. */
export async function waitForWorldAge(bot: Pick<Bot, "time">, ticks: number, options: WorldAgeOptions): Promise<WorldAgeWait> {
  const now = options.now ?? (() => performance.now());
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => sleepFor(ms, options.signal));
  const startedAt = now();
  // A bot that has heard no time packet yet has a null age (`time.js`): the first age it hears is the one to move from.
  let ageAtStart = bot.time?.age ?? undefined;
  let lastAge = ageAtStart;
  let lastMoveAt = startedAt;
  for (;;) {
    options.signal?.throwIfAborted();
    if (options.until?.() === true) return "until";
    const age = bot.time?.age ?? undefined;
    ageAtStart ??= age;
    if (ageAtStart !== undefined && age !== undefined && age - ageAtStart >= ticks) return "moved";
    if (age !== lastAge) [lastAge, lastMoveAt] = [age, now()];
    if (now() - startedAt >= options.wallMs) return "timeout";
    if (options.stallMs !== undefined && now() - lastMoveAt >= options.stallMs) return "stalled";
    const untilBound = Math.min(options.wallMs - (now() - startedAt), options.stallMs === undefined ? Infinity : options.stallMs - (now() - lastMoveAt));
    await sleep(Math.min(pollMs, Math.max(1, untilBound)));
  }
}

/** World age a request waits past its send before "no answer" is the answer (one time packet per 20 ticks: two packets). */
export const SERVER_ANSWER_TICKS = 40;

/**
 * Two time-packet intervals at 2 tps, leaving room for a slow server behind schedule (scenario-ticks C8, 2026-11-15).
 * The rate: `scenarios/build/place-block-slow-server.yaml`; cadence: contract check `world-age-at-slow-tick`.
 */
export const SERVER_CLOCK_STOPPED_MS = 20_000;

/** Wait for ticks or an answer, allowing a moving server clock to run without a wall cap. */
export function waitForServerTicks(
  bot: Pick<Bot, "time">,
  ticks: number,
  options: Pick<WorldAgeOptions, "signal" | "until" | "now" | "sleep"> = {},
): Promise<WorldAgeWait> {
  return waitForWorldAge(bot, ticks, {
    ...options, wallMs: Number.POSITIVE_INFINITY,
    stallMs: SERVER_CLOCK_STOPPED_MS,
  });
}

/**
 * Resolve when `until` is true, the world age reached `sentAtAge + SERVER_ANSWER_TICKS`, it stood still for `stallMs`, or `wallMs` passed.
 * `sentAtAge` is the age when the request went out (undefined: the age now), so a caller that looked away for a while
 * does not wait the 40 ticks again.
 */
export function waitForServerAnswer(
  bot: Pick<Bot, "time">,
  sentAtAge: number | undefined,
  options: WorldAgeOptions,
): Promise<WorldAgeWait> {
  const ageNow = bot.time?.age;
  const ticksLeft = sentAtAge === undefined || ageNow === undefined ? SERVER_ANSWER_TICKS : sentAtAge + SERVER_ANSWER_TICKS - ageNow;
  return waitForWorldAge(bot, Math.max(0, ticksLeft), options);
}

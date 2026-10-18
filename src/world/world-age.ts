/**
 * Wait for the server to have had time to answer.
 *
 * "The server handled it" is an answer packet or the world age (`bot.time.age`, the server's own tick count) moving
 * on after the send: packets arrive in order, so a world that moved 40 ticks past our request without the change
 * we wait for will not bring it. Client ticks say nothing of that (physics can be off, the server far behind), and
 * the server clock may stop altogether, so every wait is also bounded on the monotonic wall clock.
 */
import type { Bot } from "mineflayer";

export type WorldAgeWait = "moved" | "until" | "timeout";

export interface WorldAgeOptions {
  /** Longest wait on the monotonic wall clock, whatever the server clock does. */
  readonly wallMs: number;
  readonly signal?: AbortSignal;
  /** The change waited for; checked at every look. */
  readonly until?: () => boolean;
  /** Milliseconds between looks. */
  readonly pollMs?: number;
  /** Injectable monotonic clock (milliseconds) and sleep, for tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_MS = 25;

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

/** Resolve when `until` is true, the world age moved `ticks` past its value now, or `wallMs` passed. */
export async function waitForWorldAge(bot: Pick<Bot, "time">, ticks: number, options: WorldAgeOptions): Promise<WorldAgeWait> {
  const now = options.now ?? (() => performance.now());
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => sleepFor(ms, options.signal));
  const startedAt = now();
  const ageAtStart = bot.time?.age;
  for (;;) {
    options.signal?.throwIfAborted();
    if (options.until?.() === true) return "until";
    const age = bot.time?.age;
    if (ageAtStart !== undefined && age !== undefined && age - ageAtStart >= ticks) return "moved";
    if (now() - startedAt >= options.wallMs) return "timeout";
    await sleep(Math.min(pollMs, Math.max(1, options.wallMs - (now() - startedAt))));
  }
}

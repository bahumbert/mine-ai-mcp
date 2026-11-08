// The restart policy of a killed runtime, pure: whether and when to start it again from the failures in a row.
import type { RestartSettings } from "./runtime-liveness.js";

/** The failures in a row since the runtime last played `healthyMs`, and when it last reported `ready` (monotonic ms). */
export interface RestartStreak {
  readonly attempts: number;
  readonly readyAt: number | null;
}
export const NO_STREAK: RestartStreak = { attempts: 0, readyAt: null };

export type RestartDecision =
  | { readonly kind: "restart"; readonly delayMs: number; readonly attempt: number; readonly of: number; readonly streak: RestartStreak }
  | { readonly kind: "give_up"; readonly of: number; readonly streak: RestartStreak };

/**
 * What to do with a runtime that failed at `failedAt` (monotonic ms, the clock of `readyAt`): start again after the
 * delay range of its attempt, or give up once `settings.attempts` attempts failed in a row. A runtime that stayed
 * ready for `healthyMs` before this failure starts a new streak. `random` is `Math.random`, injected for tests.
 */
export function decideRestart(
  streak: RestartStreak,
  failedAt: number,
  settings: RestartSettings,
  random: () => number,
): RestartDecision {
  const played = streak.readyAt !== null && failedAt - streak.readyAt >= settings.healthyMs;
  const current = played ? NO_STREAK : streak;
  if (current.attempts >= settings.attempts) return { kind: "give_up", of: settings.attempts, streak: current };
  const attempt = current.attempts + 1;
  const { minMs, maxMs } = settings.delays[Math.min(attempt, settings.delays.length) - 1]!;
  return {
    kind: "restart",
    delayMs: minMs + random() * (maxMs - minMs),
    attempt,
    of: settings.attempts,
    streak: { attempts: attempt, readyAt: null },
  };
}

/** The restarted runtime reported `ready` at `at` (monotonic ms): the play time that resets the streak counts from here. */
export function readyAgain(streak: RestartStreak, at: number): RestartStreak {
  return { ...streak, readyAt: at };
}

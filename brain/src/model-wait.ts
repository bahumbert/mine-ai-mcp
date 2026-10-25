// How long the brain waits before asking a model that did not answer again.

/** The longest wait after the same error repeated (a work loop error, or a model server that stays away). */
export const MAX_ERROR_WAIT_MS = 60_000;
/** A chat line still waits for an answer this long after it was heard; older, it is dropped. */
export const CHAT_RETRY_MS = 120_000;

/**
 * The wait before asking again after `failures` (at least 1) failures in a row: `pollMs` doubled each time, at most
 * {@link MAX_ERROR_WAIT_MS}, scaled by a factor from `random()` in [0, 1) to between half and all of it, so 20 agents
 * on one model server do not ask again in the same instant.
 */
export function modelRetryDelay(failures: number, pollMs: number, random: () => number): number {
  return Math.min(pollMs * 2 ** (failures - 1), MAX_ERROR_WAIT_MS) * (0.5 + random() / 2);
}

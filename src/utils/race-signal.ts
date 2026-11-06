/**
 * `work`, or a rejection with `signal`'s reason as soon as the signal aborts. A Mineflayer call (`bot.equip`,
 * `bot.sleep`, `bot.craft`, a placement) settles only when the server answers or its own timeout fires, seconds after a
 * death; an action awaits it through this so its cancel is not held back by that answer.
 *
 * The abandoned call may still reject later (its own timeout): that rejection is no longer anyone's and is swallowed.
 * The abort listener goes on every outcome. With no signal the call's own outcome is the result.
 */
export async function raceSignal<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  work.catch(() => undefined);
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

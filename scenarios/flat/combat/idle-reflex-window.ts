/** The idle window of an idle-reflex fixture: world ticks the server ran while the bot stood by. */
import type { Bot } from "mineflayer";
import { waitServerTicks } from "../../../tests/minecraft/drivers/server-ticks.ts";

/** Count from the first age heard, since a null age before the first time packet is no age. */
function windowAge(bot: Pick<Bot, "time">): () => number {
  let origin: number | undefined;
  return () => {
    origin ??= bot.time.age ?? undefined;
    return origin === undefined ? 0 : (bot.time.age ?? origin) - origin;
  };
}

/**
 * Hold the bot idle for `ticks` server ticks, or until `until` holds, and report the world ticks that passed.
 * A server whose world age stands still for 30 s fails the window (the trial ends failed with that text).
 */
export async function observeIdleWindow(
  bot: Pick<Bot, "time">,
  ticks: number,
  until: () => boolean,
  signal?: AbortSignal,
): Promise<{ observedTicks: number }> {
  const elapsed = windowAge(bot);
  const watchedUntil = () => {
    elapsed();
    return until();
  };
  const outcome = await waitServerTicks(bot, ticks, { signal, until: watchedUntil });
  const observedTicks = elapsed();
  if (outcome === "stalled")
    throw new Error(`idle window: the server's world age stood still for 30 s after ${observedTicks} of ${ticks} ticks`);
  return { observedTicks };
}

/** Poll a local read until it succeeds or the server-tick window expires, awaiting any read already in flight on abort. */
export async function pollServerWindow(
  bot: Pick<Bot, "time">,
  ticks: number,
  poll: () => Promise<boolean>,
  signal?: AbortSignal,
): Promise<{ observedTicks: number; ended: "poll" | "ticks" }> {
  signal?.throwIfAborted();
  const elapsed = windowAge(bot);
  const expired = () => elapsed() >= ticks;
  while (!expired()) {
    let matched: boolean;
    try {
      matched = await poll();
    } finally {
      signal?.throwIfAborted();
    }
    if (matched) return { observedTicks: elapsed(), ended: "poll" };
    // Stop at the window's budget even if it ends between full polling intervals.
    if (await waitServerTicks(bot, 20, { signal, until: expired }) === "stalled")
      throw new Error(`poll window: the server's world age stood still for 30 s after ${elapsed()} of ${ticks} ticks`);
    signal?.throwIfAborted();
  }
  return { observedTicks: elapsed(), ended: "ticks" };
}

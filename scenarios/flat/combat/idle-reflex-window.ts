/** The idle window of an idle-reflex fixture: world ticks the server ran while the bot stood by. */
import type { Bot } from "mineflayer";
import { waitServerTicks } from "../../../tests/minecraft/drivers/server-ticks.ts";

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
  // The origin is the first age the bot hears: a null age before the first time packet is no age (`time.js`).
  // Until one is heard, the window reports no ticks rather than an absolute age.
  let origin: number | undefined;
  const watchedUntil = () => {
    origin ??= bot.time.age ?? undefined;
    return until();
  };
  const outcome = await waitServerTicks(bot, ticks, { signal, until: watchedUntil });
  const observedTicks = origin === undefined ? 0 : (bot.time.age ?? origin) - origin;
  if (outcome === "stalled")
    throw new Error(`idle window: the server's world age stood still for 30 s after ${observedTicks} of ${ticks} ticks`);
  return { observedTicks };
}

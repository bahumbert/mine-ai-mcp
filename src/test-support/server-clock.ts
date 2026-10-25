import type { Bot } from "mineflayer";

/**
 * Move the fake server's world age the way the game does: one time packet per second, 20 ticks at a jump. Returns
 * the function that stops it; a test whose wait must end on the wall clock (a stopped server) simply does not start one.
 */
export function startServerClock(bot: Pick<Bot, "time">, everyMs = 10): () => void {
  const timer = setInterval(() => {
    bot.time.age += 20;
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

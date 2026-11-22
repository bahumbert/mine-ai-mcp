// Supply native digging with the server's clock and authoritative block answers.
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { MS_PER_ON_TIME_TICK, SERVER_ANSWER_TICKS, STALE_AGE_TICKS, waitForServerTicks } from "../../world/world-age.js";
import { changeCovers, subscribeServerBlockChanges } from "./server-block-changes.js";

interface DigCallbacks {
  finish(): void;
  complete(block: Block): void;
  fail(error: Error): void;
}

declare module "mineflayer" {
  interface Bot {
    /** Patched digging.js delegates its timer and completion to this installed capability. */
    _startServerDig?: (block: Block, digMs: number, callbacks: DigCallbacks) => () => void;
  }
}

/** Mining plus one packet for its removal answer (20/10-tps phase tests and native-dig contract, 2026-11-16). */
export function nativeDigTicks(digMs: number): number {
  return Math.ceil(digMs / MS_PER_ON_TIME_TICK) + STALE_AGE_TICKS + 1;
}

/** Require server removal within the mining, stale-age and answer budgets, or fail on a stopped clock. */
async function waitForDigRemoval(bot: Bot, digMs: number, signal: AbortSignal): Promise<void> {
  const ticks = Math.ceil(digMs / MS_PER_ON_TIME_TICK) + STALE_AGE_TICKS + SERVER_ANSWER_TICKS;
  const answered = await waitForServerTicks(bot, ticks, { signal });
  throw new Error(answered === "stalled"
    ? "[DIG_SERVER_CLOCK_STOPPED] The server clock stopped before confirming the dig. Inspect the target after it resumes."
    : "[DIG_NOT_CONFIRMED] The server did not confirm removal after the dig. Inspect the target before retrying.");
}

/** Observe before starting the clock, so neither an early authoritative answer nor cancellation is lost. */
function startServerDig(bot: Bot, block: Block, digMs: number, callbacks: DigCallbacks): () => void {
  const abort = new AbortController();
  const unsubscribe = subscribeServerBlockChanges(bot, change => {
    if (!changeCovers(change, block.position)) return;
    const after = bot.blockAt(block.position);
    if (after?.type === 0) callbacks.complete(after);
  });
  const onEnd = () => fail(new Error("[DIG_DISCONNECTED] The connection ended during digging. Reconnect and inspect the target before retrying."));
  const dispose = () => {
    if (abort.signal.aborted) return;
    abort.abort();
    clearTimeout(finishTimer);
    unsubscribe();
    bot._client.off("end", onEnd);
  };
  const fail = (error: Error) => {
    try {
      callbacks.fail(error);
    } catch {
      // Native stop settles in finally; a transport cleanup error must not escape an automatic failure.
    } finally {
      dispose();
    }
  };
  // Vanilla holds an early finish until mining completes; only its air completes this dig (P2b, 2026-11-15).
  const finishTimer = setTimeout(() => {
    try { callbacks.finish(); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  }, digMs);
  bot._client.once("end", onEnd);
  void waitForDigRemoval(bot, digMs, abort.signal).catch(error => {
    if (!abort.signal.aborted) fail(error);
  });
  return dispose;
}

/** Install once at the shared plugin seam; all native dig callers then share the same clock and observer. */
export function installNativeDigClock(bot: Bot): void {
  bot._startServerDig ??= (block, digMs, callbacks) => startServerDig(bot, block, digMs, callbacks);
}

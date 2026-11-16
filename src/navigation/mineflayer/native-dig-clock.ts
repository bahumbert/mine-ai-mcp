// Supply native digging with the server's clock and authoritative block answers.
import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { MS_PER_ON_TIME_TICK, SERVER_ANSWER_TICKS, waitForServerTicks } from "../../world/world-age.js";
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

/** A cached age can be 19 ticks stale: one packet of margin makes a finish safe at any packet phase. */
const DIG_AGE_MARGIN_TICKS = 19;

/** Wait for the mining budget, send finish once, then require the server's removal answer. */
async function finishOnServerClock(bot: Bot, digMs: number, signal: AbortSignal, callbacks: DigCallbacks): Promise<void> {
  const ticks = Math.ceil(digMs / MS_PER_ON_TIME_TICK) + DIG_AGE_MARGIN_TICKS;
  const mined = await waitForServerTicks(bot, ticks, { signal });
  if (mined === "stalled") throw new Error("[DIG_SERVER_CLOCK_STOPPED] The server clock stopped during digging. Wait for it to resume before retrying.");
  callbacks.finish();
  const answered = await waitForServerTicks(bot, SERVER_ANSWER_TICKS, { signal });
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
  bot._client.once("end", onEnd);
  void finishOnServerClock(bot, digMs, abort.signal, callbacks).catch(error => {
    if (!abort.signal.aborted) fail(error);
  });
  return dispose;
}

/** Install once at the shared plugin seam; all native dig callers then share the same clock and observer. */
export function installNativeDigClock(bot: Bot): void {
  bot._startServerDig ??= (block, digMs, callbacks) => startServerDig(bot, block, digMs, callbacks);
}

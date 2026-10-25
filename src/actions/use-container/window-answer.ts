// What a click between two stacks of one item waits for: the server's answer to it, which is the world age moving on 40 ticks.
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import { waitForServerAnswer } from "../../world/world-age.js";

type ContainerWindow = Awaited<ReturnType<Bot["openContainer"]>>;
type ItemLoader = (registry: Bot["registry"]) => typeof Item & { fromNotch(notch: unknown): Item | null };
const loadItem = createRequire(import.meta.url)("prismarine-item") as ItemLoader;

/**
 * Longest the world age may stand still while a click waits for its answer, on the monotonic wall clock. A server sends
 * one time packet per 20 ticks (facts `runtime-pitfalls.md` "Time packets"), so at N ticks a second the age moves every
 * 20 / N s: 5 s reads a server under 4 ticks a second as stopped.
 */
export const CLICK_STALL_MS = 5_000;
/**
 * Longest one click's wait takes on the monotonic wall clock while the age keeps moving: the 40 ticks of a server at the
 * 4 ticks a second `CLICK_STALL_MS` still tolerates take 10 s, plus one stall bound of slack.
 */
export const CLICK_WALL_MS = 15_000;

/** A click the server did not answer in time (a stalled or very slow world clock): the container may hold anything, so the caller reopens it. */
export class ClickAnswerTimeout extends Error {
  /**
   * `moved` of `total` is what a multi-stack transfer had moved before the stack that timed out (left out when 0).
   * The count sits inside the cause, so the next step stays the last sentence.
   */
  constructor(
    readonly slot: number,
    readonly waited: "stalled" | "timeout",
    readonly age: number | null | undefined,
    readonly moved = 0,
    readonly total = 0,
    options?: ErrorOptions,
  ) {
    const bound = waited === "stalled" ? `the world age did not move for ${CLICK_STALL_MS / 1000} s` : `40 world ticks took longer than ${CLICK_WALL_MS / 1000} s`;
    const progress = moved > 0 ? `; ${moved} of ${total} were moved before this stack` : "";
    super(`The server did not answer the click on slot ${slot}: ${bound} (world age ${age ?? "unknown"})${progress}, so it is lagging or stopped. Reopen the container and read its layout before moving more.`, options);
  }
}

/** The clock a wait reads: the monotonic wall clock and a sleep by default; a test passes the fake clock's. */
export interface ClickWaitTiming {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface ClickAnswerWatch {
  /**
   * Resolve once the world age has moved 40 ticks past the send: the server has then answered the click or stays quiet
   * because Mineflayer's prediction was right (it sends no correction for that). Throws `ClickAnswerTimeout` when the age
   * stood still for `CLICK_STALL_MS` or the wait passed `CLICK_WALL_MS`.
   */
  settle(slot: number, signal?: AbortSignal): Promise<void>;
  /** Stop listening (a settled watch has already). */
  stop(): void;
}

/**
 * Listen, from now, for the server's answer to the click about to be written. Mineflayer applies `set_slot` and
 * `window_items` itself but has no handler for `set_cursor_item` (measured: the stack the server holds in hand stays
 * unknown to the client), so this applies the cursor to the container's window. No packet ends the wait: a slot packet
 * may come from another player's click, and the cursor may follow the slot packet of the same answer by a tick or more.
 */
export function watchClickAnswer(bot: Bot, window: ContainerWindow, timing?: ClickWaitTiming): ClickAnswerWatch {
  const sentAtAge = bot.time?.age;
  const onCursor = (packet: { contents: unknown }) => {
    window.selectedItem = loadItem(bot.registry).fromNotch(packet.contents);
  };
  bot._client.on("set_cursor_item", onCursor);
  const stop = () => void bot._client.off("set_cursor_item", onCursor);
  return {
    stop,
    async settle(slot, signal) {
      try {
        const waited = await waitForServerAnswer(bot, sentAtAge, { wallMs: CLICK_WALL_MS, stallMs: CLICK_STALL_MS, ...(signal && { signal }), ...(timing && { now: timing.now, sleep: (ms: number) => timing.sleep(ms, signal) }) });
        if (waited === "stalled" || waited === "timeout") throw new ClickAnswerTimeout(slot, waited, bot.time?.age);
      } finally {
        stop();
      }
    },
  };
}

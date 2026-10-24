// What a click between two stacks of one item waits for: the server's correction of Mineflayer's prediction, or quiet.
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import { sleepMs } from "../../utils/wall-timers.js";
import { waitForServerAnswer } from "../../world/world-age.js";

type ContainerWindow = Awaited<ReturnType<Bot["openContainer"]>>;
type ItemLoader = (registry: Bot["registry"]) => typeof Item & { fromNotch(notch: unknown): Item | null };
const loadItem = createRequire(import.meta.url)("prismarine-item") as ItemLoader;

/** Longest wait for the answer to one click on the monotonic wall clock, whatever the server's clock does (a server under 8 ticks a second fails here). */
export const CLICK_ANSWER_WALL_MS = 5_000;
/** The server sends `set_cursor_item` right after the `set_slot` of one answer, in one tick (contract check `click-window-onto-variant`); a split packet needs this long. */
const CURSOR_FOLLOWS_SLOT_MS = 50;

/** The clock a wait reads: the monotonic wall clock and a sleep by default; a test passes the fake clock's. */
export interface ClickWaitTiming {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface ClickAnswerWatch {
  /** Resolve once the server answered the click on `slot` (a correction applied to the window) or stayed quiet for 40 ticks; throws past the wall bound. */
  settle(slot: number, signal?: AbortSignal): Promise<void>;
  /** Stop listening (a settled watch has already). */
  stop(): void;
}

/**
 * Listen, from now, for the server's correction of the click about to be written. Mineflayer applies `set_slot` and
 * `window_items` itself but has no handler for `set_cursor_item` (measured: the stack the server holds in hand stays
 * unknown to the client), so this applies the cursor to the container's window as the answer's last part.
 */
export function watchClickAnswer(bot: Bot, window: ContainerWindow, timing?: ClickWaitTiming): ClickAnswerWatch {
  const sentAtAge = bot.time?.age;
  let corrected = false;
  const onSlots = (packet: { windowId: number }) => void (corrected ||= packet.windowId === window.id);
  const onCursor = (packet: { contents: unknown }) => {
    window.selectedItem = loadItem(bot.registry).fromNotch(packet.contents);
    corrected = true;
  };
  bot._client.on("set_slot", onSlots);
  bot._client.on("window_items", onSlots);
  bot._client.on("set_cursor_item", onCursor);
  const stop = () => {
    bot._client.off("set_slot", onSlots);
    bot._client.off("window_items", onSlots);
    bot._client.off("set_cursor_item", onCursor);
  };
  return {
    stop,
    async settle(slot, signal) {
      try {
        const waited = await waitForServerAnswer(bot, sentAtAge, { wallMs: CLICK_ANSWER_WALL_MS, until: () => corrected, ...(signal && { signal }), ...(timing && { now: timing.now, sleep: (ms: number) => timing.sleep(ms, signal) }) });
        if (waited === "timeout") {
          throw new Error(
            `The server did not answer the click on slot ${slot} within ${CLICK_ANSWER_WALL_MS} ms (world age ${bot.time?.age ?? "unknown"}): it is lagging or stopped. Reopen the container and read its layout before moving more.`,
          );
        }
        if (corrected) await (timing?.sleep ?? sleepMs)(CURSOR_FOLLOWS_SLOT_MS, signal);
      } finally {
        stop();
      }
    },
  };
}

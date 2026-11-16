// Send furnace shift-clicks and count only the takes the server has had time to answer.
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import { createRequire } from "node:module";
import { sameItemVariant } from "../../world/item-variant.js";
import { carriedCount } from "../../world/inventory-count.js";
import { SERVER_CLOCK_STOPPED_MS, waitForServerAnswer } from "../../world/world-age.js";
import type { FurnaceWindow } from "./furnace-cook.js";

export interface WindowAnswers {
  readonly corrected: () => boolean;
  readonly resynced: () => boolean;
  readonly closed: () => boolean;
  dispose(): void;
}

export interface SentTake {
  readonly source: "output" | "input" | "fuel";
  readonly sourceSlot: number;
  readonly like: Item;
  readonly sourceBefore: number;
  readonly playerBefore: number;
  readonly predicted: number;
  readonly inventoryBefore: number;
  readonly sentAtAge: number | undefined;
}

export interface AnsweredTakes {
  readonly counts: readonly number[];
  readonly errors: readonly string[];
  readonly answer: "answered" | "stalled" | "closed" | "aborted";
}

interface AnswerState {
  corrected: boolean;
  resynced: boolean;
  readonly previous: SentTake[];
}

const answerStates = new WeakMap<WindowAnswers, AnswerState>();
const closedWindows = new WeakSet<FurnaceWindow>();
const require = createRequire(import.meta.url);

/** Watch the server's corrections before the first click can be sent. */
export function watchWindowAnswers(bot: Bot, window: FurnaceWindow): WindowAnswers {
  const state: AnswerState = { corrected: false, resynced: false, previous: [] };
  const onSlot = (packet: { windowId: number; slot: number }) => {
    if (packet.windowId === window.id && packet.slot >= window.inventoryStart && packet.slot < window.inventoryEnd) state.corrected = true;
  };
  const onItems = (packet: { windowId: number }) => { if (packet.windowId === window.id) state.resynced = true; };
  const onCursor = () => { state.corrected = true; };
  const onClose = () => { closedWindows.add(window); };
  bot._client.on("set_slot", onSlot);
  bot._client.on("window_items", onItems);
  bot._client.on("set_cursor_item", onCursor);
  window.on("close", onClose);
  let disposed = false;
  const answers: WindowAnswers = {
    corrected: () => state.corrected,
    resynced: () => state.resynced,
    closed: () => closedWindows.has(window) || bot.currentWindow !== window,
    dispose() {
      if (disposed) return;
      disposed = true;
      bot._client.off("set_slot", onSlot);
      bot._client.off("window_items", onItems);
      bot._client.off("set_cursor_item", onCursor);
      window.off("close", onClose);
    },
  };
  answerStates.set(answers, state);
  return answers;
}

/** Count a variant only in the window's player slots. */
export function playerPartCount(window: FurnaceWindow, like: Item): number {
  return window.slots.slice(window.inventoryStart, window.inventoryEnd)
    .reduce((count, stack) => count + (stack && sameItemVariant(stack, like) ? stack.count : 0), 0);
}

/** Check the same inventory capacity as today's cook, respecting stack variants. */
function hasInventoryRoom(bot: Bot, item: Item): boolean {
  return bot.inventory.items().some((stack) => sameItemVariant(stack, item) && stack.count < stack.stackSize)
    || bot.inventory.emptySlotCount() > 0;
}

/** Send one take, retaining the source and player counts before prediction mutates them. */
export async function sendTake(bot: Bot, window: FurnaceWindow, source: SentTake["source"]): Promise<SentTake | null> {
  if (bot.currentWindow !== window || closedWindows.has(window)) throw new Error("The furnace window closed before the take.");
  const item = window[`${source}Item`]();
  if (!item) return null;
  if (!hasInventoryRoom(bot, item)) throw new Error(`No inventory room for furnace ${source} ${item.name} x${item.count}.`);
  const ItemClass = require("prismarine-item")(bot.registry) as typeof Item;
  const like = ItemClass.fromNotch(ItemClass.toNotch(item))!;
  const sourceBefore = item.count;
  const sourceSlot = item.slot;
  const playerBefore = playerPartCount(window, like);
  const inventoryBefore = carriedCount(bot, like.name);
  const sentAtAge = bot.time?.age ?? undefined;
  await bot.clickWindow(sourceSlot, 0, 1);
  const predicted = Math.max(0, sourceBefore - (window.slots[sourceSlot]?.count ?? 0));
  return { source, sourceSlot, like, sourceBefore, playerBefore, predicted, inventoryBefore, sentAtAge };
}

/** Correct only an unambiguous variant: a recovery may have taken that variant in an earlier answered call. */
function answeredCounts(window: FurnaceWindow, takes: readonly SentTake[], answers: WindowAnswers, errors: string[]): number[] {
  const previous = answerStates.get(answers)?.previous ?? [];
  return takes.map((take, index) => {
    if (!answers.corrected() && !answers.resynced()) return take.predicted;
    const shared = [...previous, ...takes.filter((_, other) => index !== other)].some((other) => sameItemVariant(other.like, take.like));
    if (shared) {
      errors.push(`The server corrected a furnace take of ${take.like.name} that another take shares; its count is read after close.`);
      return take.predicted;
    }
    return Math.max(0, playerPartCount(window, take.like) - take.playerBefore);
  });
}

/** Wait for the server's answer, then reconcile a corrected prediction. */
export async function answerTakes(bot: Bot, window: FurnaceWindow, takes: readonly SentTake[], answers: WindowAnswers, signal?: AbortSignal): Promise<AnsweredTakes> {
  const predictions = takes.map((take) => take.predicted);
  if (signal?.aborted) return { counts: predictions, errors: [], answer: "aborted" };
  if (takes.length === 0) return { counts: [], errors: [], answer: "answered" };
  let answer: AnsweredTakes["answer"];
  try {
    const waited = await waitForServerAnswer(bot, takes.at(-1)!.sentAtAge, {
      wallMs: Infinity, stallMs: SERVER_CLOCK_STOPPED_MS, signal, until: answers.closed,
    });
    answer = waited === "until" ? "closed" : waited === "stalled" ? "stalled" : "answered";
  } catch (cause) {
    if (!signal?.aborted) throw cause;
    return { counts: predictions, errors: [], answer: "aborted" };
  }
  const errors: string[] = [];
  if (answer === "stalled") errors.push("The server's clock stood still for 20 s after a furnace take: the take is not confirmed.");
  if (answer === "closed") errors.push("The furnace window closed before the take was answered.");
  const counts = answer === "answered" ? answeredCounts(window, takes, answers, errors) : predictions;
  takes.forEach((take, index) => {
    if (counts[index] === 0) errors.push(`Inventory did not confirm furnace ${take.source} ${take.like.name}.`);
  });
  const state = answerStates.get(answers);
  if (state) {
    state.previous.push(...takes);
    state.corrected = false;
    state.resynced = false;
  }
  return { counts, errors, answer };
}

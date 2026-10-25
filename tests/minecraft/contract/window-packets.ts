/** What a window check reads of the packets between server and client: their names in arrival order, and the slots they carry. */
import type { Bot } from "mineflayer";
import { createRequire } from "node:module";

export interface WindowPacket {
  readonly name: string;
  /** `set_cursor_item` has none: -1, the id the cursor has in `set_slot` of older versions. */
  readonly windowId: number;
  /** `set_slot` only. */
  readonly slot?: number;
}

const CURSOR_WINDOW_ID = -1;
const WINDOW_PACKETS = ["open_window", "window_items", "set_slot", "set_cursor_item", "close_window"] as const;

/** Record the window packets the client receives until `stop()`; Mineflayer's own handlers run before (registered first). */
export function recordWindowPackets(bot: Bot): { readonly packets: WindowPacket[]; stop(): void } {
  const packets: WindowPacket[] = [];
  const listeners = WINDOW_PACKETS.map((name) => {
    const listener = (packet: { windowId?: number; slot?: number }) =>
      void packets.push({ name, windowId: packet.windowId ?? CURSOR_WINDOW_ID, ...(name === "set_slot" && { slot: packet.slot }) });
    bot._client.on(name, listener);
    return [name, listener] as const;
  });
  return { packets, stop: () => listeners.forEach(([name, listener]) => bot._client.off(name, listener)) };
}

/** A stack as a check reads it: `name x count`, or null for an empty slot. */
export function stackOf(item: { readonly name: string; readonly count: number } | null | undefined): string | null {
  return item ? `${item.name} x${item.count}` : null;
}

/** A stack as `stackOf` reads it, with the custom name it carries when it has one (`name xN "first"`): the variants `ITEM_VARIANTS` names. */
export function variantStackOf(item: { readonly name: string; readonly count: number } | null | undefined): string | null {
  if (!item) return null;
  const components = (Reflect.get(item, "components") ?? []) as { type: string; data: { value?: string } }[];
  const renamed = components.find(({ type }) => type === "custom_name")?.data.value;
  return `${stackOf(item)}${renamed === undefined ? "" : ` "${renamed}"`}`;
}

/** The stacks of `slots` of a window, by slot number. */
export function slotsOf(window: { readonly slots: readonly ({ readonly name: string; readonly count: number } | null)[] }, slots: readonly number[]): Record<number, string | null> {
  return Object.fromEntries(slots.map((slot) => [slot, stackOf(window.slots[slot])]));
}

/** What the client got of one answer: the slot it carries (`set_slot` only) and the stack as `variantStackOf` reads it (`null` for an empty slot). */
export interface WindowAnswer {
  readonly name: "set_slot" | "set_cursor_item";
  /** `set_slot` only: the window the slot is in (0 is the player's). */
  readonly windowId?: number;
  readonly slot?: number;
  readonly stack: string | null;
}

/** Record the stacks the server's `set_slot` and `set_cursor_item` carry (decoded as Mineflayer decodes a window's items) until `stop()`: the server's own view of a slot and of the hand, whatever the client predicted. */
export function recordWindowAnswers(bot: Bot): { readonly answers: WindowAnswer[]; stop(): void } {
  const answers: WindowAnswer[] = [];
  const ItemClass = createRequire(import.meta.url)("prismarine-item")(bot.registry) as { fromNotch(notch: unknown): Parameters<typeof variantStackOf>[0] };
  const onSlot = (packet: { windowId: number; slot: number; item: unknown }) => void answers.push({ name: "set_slot", windowId: packet.windowId, slot: packet.slot, stack: variantStackOf(ItemClass.fromNotch(packet.item)) });
  const onCursor = (packet: { contents: unknown }) => void answers.push({ name: "set_cursor_item", stack: variantStackOf(ItemClass.fromNotch(packet.contents)) });
  bot._client.on("set_slot", onSlot);
  bot._client.on("set_cursor_item", onCursor);
  return {
    answers,
    stop: () => {
      bot._client.off("set_slot", onSlot);
      bot._client.off("set_cursor_item", onCursor);
    },
  };
}

/** Make the client's hand follow the server's `set_cursor_item` (Mineflayer has no handler for it), so the next click is predicted from the stack the server holds. */
export function followServerCursor(bot: Bot, window: { selectedItem: unknown }): () => void {
  const ItemClass = createRequire(import.meta.url)("prismarine-item")(bot.registry) as { fromNotch(notch: unknown): unknown };
  const onCursor = (packet: { contents: unknown }) => void (window.selectedItem = ItemClass.fromNotch(packet.contents));
  bot._client.on("set_cursor_item", onCursor);
  return () => bot._client.off("set_cursor_item", onCursor);
}

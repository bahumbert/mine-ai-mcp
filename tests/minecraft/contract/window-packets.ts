/** What a window check reads of the packets between server and client: their names in arrival order, and the slots they carry. */
import type { Bot } from "mineflayer";

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

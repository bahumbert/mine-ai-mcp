/** What a window check reads of the packets between server and client: their names in arrival order, and the slots they carry. */
import type { Bot } from "mineflayer";

export interface WindowPacket {
  readonly name: string;
  readonly windowId: number;
  /** `set_slot` only. */
  readonly slot?: number;
}

const WINDOW_PACKETS = ["open_window", "window_items", "set_slot", "close_window"] as const;

/** Record the window packets the client receives until `stop()`; Mineflayer's own handlers run before (registered first). */
export function recordWindowPackets(bot: Bot): { readonly packets: WindowPacket[]; stop(): void } {
  const packets: WindowPacket[] = [];
  const listeners = WINDOW_PACKETS.map((name) => {
    const listener = (packet: { windowId: number; slot?: number }) =>
      void packets.push({ name, windowId: packet.windowId, ...(name === "set_slot" && { slot: packet.slot }) });
    bot._client.on(name, listener);
    return [name, listener] as const;
  });
  return { packets, stop: () => listeners.forEach(([name, listener]) => bot._client.off(name, listener)) };
}

/** A stack as a check reads it: `name x count`, or null for an empty slot. */
export function stackOf(item: { readonly name: string; readonly count: number } | null | undefined): string | null {
  return item ? `${item.name} x${item.count}` : null;
}

/** The stacks of `slots` of a window, by slot number. */
export function slotsOf(window: { readonly slots: readonly ({ readonly name: string; readonly count: number } | null)[] }, slots: readonly number[]): Record<number, string | null> {
  return Object.fromEntries(slots.map((slot) => [slot, stackOf(window.slots[slot])]));
}

/**
 * The server's shift click (`AbstractContainerMenu.quickMoveStack` and `moveItemStackTo`): merge into the stacks of the
 * same item in the target range, then fill its empty slots. Prismarine's own `shiftClick` is the client's prediction and
 * differs from it (a hotbar stack shifted inside the player window removes itself: contract check
 * `click-window-shift-move`), so the server moves the stack by this rule and sends back what the client got wrong.
 * Not modelled: armour and the off hand taking a shifted piece, the crafting grid's slots.
 */
import type { Item } from "prismarine-item";

/** The parts of a window the move reads and writes. */
export interface QuickMoveWindow {
  readonly type: string | number;
  readonly slots: (Item | null)[];
  readonly inventoryStart: number;
  readonly inventoryEnd: number;
  updateSlot(slot: number, item: Item | null): void;
}

/** What a move needs of the library's items: a copy with another count, and whether two are the same item. */
export interface QuickMoveItems {
  withCount(item: Item, count: number): Item;
  sameItem(left: Item, right: Item): boolean;
}

const PLAYER_WINDOW_TYPE = "minecraft:inventory";
const PLAYER_MAIN_END = 36;
const PLAYER_HOTBAR_END = 45;

/** The slots a shift click on `slot` fills, as `quickMoveStack` of each menu names them, and whether the fill runs from the last. */
function targetRange(window: QuickMoveWindow, slot: number): { start: number; end: number; reverse: boolean } {
  if (window.type !== PLAYER_WINDOW_TYPE) {
    return slot < window.inventoryStart
      ? { start: window.inventoryStart, end: window.inventoryEnd, reverse: true }
      : { start: 0, end: window.inventoryStart, reverse: false };
  }
  if (slot >= window.inventoryStart && slot < PLAYER_MAIN_END) return { start: PLAYER_MAIN_END, end: PLAYER_HOTBAR_END, reverse: false };
  if (slot >= PLAYER_MAIN_END && slot < PLAYER_HOTBAR_END) return { start: window.inventoryStart, end: PLAYER_MAIN_END, reverse: false };
  return { start: window.inventoryStart, end: PLAYER_HOTBAR_END, reverse: slot === 0 };
}

/** The slot indexes of a range, first to last or last to first. */
function indexes(start: number, end: number, reverse: boolean): number[] {
  const forward = Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset);
  return reverse ? forward.reverse() : forward;
}

/** Shift click on `slot`: the stack goes to the target range as far as it fits; the rest stays where it was. */
export function quickMove(window: QuickMoveWindow, slot: number, items: QuickMoveItems): void {
  const moving = window.slots[slot];
  if (moving === null || moving === undefined) return;
  const { start, end, reverse } = targetRange(window, slot);
  let remaining = moving.count;
  for (const index of indexes(start, end, reverse)) {
    const target = window.slots[index];
    if (remaining === 0 || target === null || target === undefined || !items.sameItem(target, moving) || target.count >= target.stackSize) continue;
    const added = Math.min(remaining, target.stackSize - target.count);
    window.updateSlot(index, items.withCount(target, target.count + added));
    remaining -= added;
  }
  for (const index of indexes(start, end, reverse)) {
    if (remaining === 0) break;
    if (window.slots[index] !== null && window.slots[index] !== undefined) continue;
    const placed = Math.min(remaining, moving.stackSize);
    window.updateSlot(index, items.withCount(moving, placed));
    remaining -= placed;
  }
  window.updateSlot(slot, remaining === 0 ? null : items.withCount(moving, remaining));
}

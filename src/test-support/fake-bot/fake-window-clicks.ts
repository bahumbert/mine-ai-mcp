/**
 * The server's left and right clicks, with stacks told apart by their components. Prismarine's own `mouseClick` merges
 * two stacks when `Item.equal` says so, which reads `nbt` only (a 1.21.4 stack has none: `Window.js:72,98`), and builds
 * a split or a put-down from `new Item(type, n, metadata, nbt)`, dropping the components (`Window.js:104,182,272`). The
 * game swaps a renamed stack and a plain one (contract check `click-window-onto-variant`), and splits a renamed stack into
 * renamed halves, puts renamed items down and merges renamed stacks (contract check `click-window-variant-split`); the
 * client's prediction is Prismarine's and stays wrong until the server answers.
 */
import type { Item } from "prismarine-item";
import { sameItemVariant } from "../../world/item-variant.js";

/** The parts of a server window the clicks read and write: Prismarine's own, called by name. */
export interface ClickableWindow {
  readonly craftingResultSlot: number;
  selectedItem: Item | null;
  mouseClick(click: MouseClick): number[];
  splitSlot(item: Item | null): void;
  swapSelectedItem(slot: number, item: Item | null): void;
  fillSlotWithSelectedItem(item: Item, untilFull: boolean): void;
  updateSlot(slot: number, item: Item | null): void;
}

export interface MouseClick {
  readonly slot: number;
  readonly mouseButton: number;
  item: Item | null;
}

const DROP_OUTSIDE_SLOT = -999;
const LEFT_BUTTON = 0;

/** What the clicks need of the library's items: a copy of a stack with another count. */
export interface ClickItems {
  withCount(item: Item, count: number): Item;
}

/** Make the window's `mouseClick` and `splitSlot` merge, swap and split by variant; the crafting result slot and a click outside keep the library's own. */
export function installVariantClicks(window: ClickableWindow, items: ClickItems): void {
  const libraryMouseClick = window.mouseClick.bind(window);
  window.splitSlot = (item) => {
    if (!item) return;
    const half = items.withCount(item, Math.ceil(item.count / 2));
    window.selectedItem = half;
    item.count -= half.count;
    if (item.count === 0) window.updateSlot(item.slot, null);
  };
  window.mouseClick = (click) => {
    if (click.slot === DROP_OUTSIDE_SLOT || click.slot === window.craftingResultSlot) return libraryMouseClick(click);
    return click.mouseButton === LEFT_BUTTON ? leftClick(window, click) : rightClick(window, click, items);
  };
}

function leftClick(window: ClickableWindow, { slot, item }: MouseClick): number[] {
  const cursor = window.selectedItem;
  if (item && cursor) {
    if (sameItemVariant(item, cursor)) window.fillSlotWithSelectedItem(item, true);
    else window.swapSelectedItem(slot, item);
    return [slot];
  }
  if (!cursor && !item) return [];
  window.swapSelectedItem(slot, item);
  return [slot];
}

function rightClick(window: ClickableWindow, { slot, item }: MouseClick, items: ClickItems): number[] {
  const cursor = window.selectedItem;
  if (cursor) {
    if (!item) {
      const placed = items.withCount(cursor, 0);
      window.updateSlot(slot, placed);
      window.fillSlotWithSelectedItem(placed, false);
    } else if (sameItemVariant(item, cursor)) window.fillSlotWithSelectedItem(item, false);
    else window.swapSelectedItem(slot, item);
    return [slot];
  }
  if (!item) return [];
  window.splitSlot(item);
  return [slot];
}

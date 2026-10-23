/**
 * The fake bot's inventory: Prismarine's own player window (46 slots of real items, so `items`, `count` and
 * `emptySlotCount` are the game library's), plus the hand and the client-side equip and toss Mineflayer does on it.
 */
import type { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import type { WindowsExports } from "prismarine-windows";
import { isItemVariantName, itemWithCount, variantItemOf } from "./item-variants.js";

type Registry = ReturnType<typeof minecraftData>;
const require = createRequire(import.meta.url);

/** Mineflayer's window slot for each equipment destination (`simple_inventory.js` `armorSlots`). */
export const EQUIPMENT_SLOTS = { head: 5, torso: 6, legs: 7, feet: 8, "off-hand": 45 } as const;
export type EquipDestination = keyof typeof EQUIPMENT_SLOTS | "hand";

const HOTBAR_START = 36;
const HOTBAR_SLOTS = 9;
const MAIN_START = 9;

export interface FakeSlot {
  readonly name: string;
  /** Defaults to 1. */
  readonly count?: number;
}

export interface FakeInventoryOptions {
  /** Stacks by window slot (armour 5-8, main 9-35, hotbar 36-44, off hand 45). */
  readonly slots?: Readonly<Record<number, FakeSlot | null>>;
  /** Item name to the number carried: fills the empty slots 36-44, then 9-35, split at each item's stack size. */
  readonly carried?: Readonly<Record<string, number>>;
}

export interface TossedStack {
  readonly type: number;
  readonly count: number;
}

export interface FakeInventoryControls {
  /** The selected hotbar slot, 0-8. */
  readonly quickBarSlot: number;
  /** The stack in slot `36 + quickBarSlot`, or null. */
  readonly heldItem: Item | null;
  /** Called with the held stack each time it changes (the bot re-emits it as Mineflayer's `heldItemChanged`). */
  onHeldItemChanged(listener: (item: Item | null) => void): () => void;
  /** Select a hotbar slot. */
  setQuickBarSlot(slot: number): void;
  /** Mineflayer's `equip` (`simple_inventory.js:88-123`), applied at once as the client predicts it. */
  equip(item: Item | number | null, destination: EquipDestination): Promise<void>;
  /** Lower the stacks of `type` by `count` (one when null) at once, first slot first (client prediction); returns one drop per slot. Throws Mineflayer's error when fewer are carried. */
  toss(type: number, count: number | null): TossedStack[];
  /** Called with the new hotbar slot each time the selection moves (the bot writes `held_item_slot`). */
  onQuickBarSlotChanged(listener: (slot: number) => void): () => void;
  /** Empty the stack's slot; returns what left the window. */
  tossStack(item: Item): TossedStack[];
}

export type FakeInventory = Bot["inventory"] & FakeInventoryControls;

/** Prismarine's window as the fake drives it: slots and `updateSlot` take null, as they do at runtime. */
interface PlayerWindow extends EventEmitter {
  readonly slots: (Item | null)[];
  readonly inventoryStart: number;
  readonly inventoryEnd: number;
  updateSlot(slot: number, item: Item | null): void;
  findInventoryItem(type: number, metadata: number | null, notFull: boolean): Item | null;
  firstEmptySlotRange(start: number, end: number): number | null;
}

/** A real Prismarine item of `name`, `count` of it (a name of `ITEM_VARIANTS` gives that variant); throws naming a name the registry does not have. */
export function itemOf(registry: Registry, name: string, count = 1): Item {
  if (isItemVariantName(name)) return variantItemOf(registry, name, count);
  const known = registry.itemsByName[name];
  if (!known) throw new Error(`unknown item ${name} in ${registry.version.minecraftVersion}`);
  const ItemClass = (require("prismarine-item") as (registry: Registry) => typeof Item)(registry);
  return new ItemClass(known.id, count);
}

/** The empty slots carried stacks go to, in the order the game's pickup fills them: hotbar first. */
function carrySlotOrder(): number[] {
  const hotbar = Array.from({ length: HOTBAR_SLOTS }, (_, index) => HOTBAR_START + index);
  const main = Array.from({ length: HOTBAR_START - MAIN_START }, (_, index) => MAIN_START + index);
  return [...hotbar, ...main];
}

/** `carried` as stacks, in order, each at most the item's stack size (`give` and a pickup fill a stack before the next). */
export function stacksOf(registry: Registry, carried: Readonly<Record<string, number>>): Required<FakeSlot>[] {
  return Object.entries(carried).flatMap(([name, total]) => {
    const stackSize = itemOf(registry, name).stackSize;
    return Array.from({ length: Math.ceil(total / stackSize) }, (_, index) => ({ name, count: Math.min(stackSize, total - index * stackSize) }));
  });
}

/** Put `carried` into the window's empty slots, one stack-size piece at a time. */
function fillCarried(window: PlayerWindow, registry: Registry, carried: Readonly<Record<string, number>>): void {
  const free = carrySlotOrder().filter((slot) => window.slots[slot] === null);
  for (const { name, count } of stacksOf(registry, carried)) {
    const slot = free.shift();
    if (slot === undefined) throw new Error(`no room for ${count} more ${name}: carried stacks exceed the 36 slots`);
    window.updateSlot(slot, itemOf(registry, name, count));
  }
}

/** How many of `type` the window's inventory slots hold. */
function totalOf(window: PlayerWindow, type: number): number {
  let total = 0;
  for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot += 1) {
    if (window.slots[slot]?.type === type) total += window.slots[slot]!.count;
  }
  return total;
}

/**
 * The hotbar slot an equip to the hand selects (`simple_inventory.js:88-123`): the source itself on the hotbar, else
 * the first empty hotbar slot, else the next one of Mineflayer's round-robin (`takeLru`).
 */
function handSlotFor(window: PlayerWindow, sourceSlot: number, quickBarSlot: number, takeLru: () => number): number {
  if (sourceSlot === HOTBAR_START + quickBarSlot) return sourceSlot;
  if (sourceSlot >= HOTBAR_START && sourceSlot < HOTBAR_START + HOTBAR_SLOTS) return sourceSlot;
  return window.firstEmptySlotRange(HOTBAR_START, HOTBAR_START + HOTBAR_SLOTS) ?? HOTBAR_START + takeLru();
}

/** Swap the stacks of two slots, announcing both. */
function swapSlots(window: PlayerWindow, from: number, to: number): void {
  const moving = window.slots[from] ?? null;
  window.updateSlot(from, window.slots[to] ?? null);
  window.updateSlot(to, moving);
}

export function createFakeInventory(registry: Registry, options: FakeInventoryOptions = {}): FakeInventory {
  const windows = (require("prismarine-windows") as (registry: Registry) => WindowsExports)(registry);
  const window = windows.createWindow(0, "minecraft:inventory", "Inventory") as unknown as PlayerWindow;
  for (const [slot, stack] of Object.entries(options.slots ?? {})) {
    window.updateSlot(Number(slot), stack === null ? null : itemOf(registry, stack.name, stack.count ?? 1));
  }
  fillCarried(window, registry, options.carried ?? {});
  let quickBarSlot = 0;
  /** Mineflayer's LRU pick when the hotbar is full (`nextQuickBarSlot`). */
  let nextQuickBarSlot = 0;
  const heldItem = () => window.slots[HOTBAR_START + quickBarSlot] ?? null;
  const heldListeners = new Set<(item: Item | null) => void>();
  const quickBarListeners = new Set<(slot: number) => void>();
  const announceHeld = () => {
    for (const listener of [...heldListeners]) listener(heldItem());
  };
  window.on("updateSlot", (slot: number) => {
    if (slot === HOTBAR_START + quickBarSlot) announceHeld();
  });
  const setQuickBarSlot = (slot: number) => {
    if (!(slot >= 0 && slot < HOTBAR_SLOTS)) throw new RangeError(`quick bar slot ${slot}: 0 to 8`);
    if (slot === quickBarSlot) return;
    quickBarSlot = slot;
    for (const listener of [...quickBarListeners]) listener(slot);
    announceHeld();
  };
  const controls: FakeInventoryControls = {
    get quickBarSlot() {
      return quickBarSlot;
    },
    get heldItem() {
      return heldItem();
    },
    onHeldItemChanged(listener) {
      heldListeners.add(listener);
      return () => void heldListeners.delete(listener);
    },
    onQuickBarSlotChanged(listener) {
      quickBarListeners.add(listener);
      return () => void quickBarListeners.delete(listener);
    },
    setQuickBarSlot,
    async equip(item, destination) {
      const source = typeof item === "number" ? window.findInventoryItem(item, null, false) : item;
      if (source == null || typeof source !== "object") {
        throw new Error("Invalid item object in equip (item is null or typeof item is not object)");
      }
      if (destination !== "hand") return swapSlots(window, source.slot, EQUIPMENT_SLOTS[destination]);
      const target = handSlotFor(window, source.slot, quickBarSlot, () => {
        const lru = nextQuickBarSlot;
        nextQuickBarSlot = (nextQuickBarSlot + 1) % HOTBAR_SLOTS;
        return lru;
      });
      setQuickBarSlot(target - HOTBAR_START);
      if (target !== source.slot) swapSlots(window, source.slot, target);
    },
    toss: (type, count) => tossFromWindow(window, registry, type, count),
    tossStack: (item) => [takeFromSlot(window, registry, item.slot, item.count)],
  };
  return Object.defineProperties(window, Object.getOwnPropertyDescriptors(controls)) as unknown as FakeInventory;
}

/** Take up to `count` from a slot, leaving a new item (never the old one changed in place, as `set_slot` builds one). */
function takeFromSlot(window: PlayerWindow, registry: Registry, slot: number, count: number): TossedStack {
  const item = window.slots[slot]!;
  const taken = Math.min(item.count, count);
  window.updateSlot(slot, item.count === taken ? null : itemWithCount(registry, item, item.count - taken));
  return { type: item.type, count: taken };
}

/** `toss` as `inventory.js` `transfer` does it: a null count is one item, more than the window holds throws before any click. */
function tossFromWindow(window: PlayerWindow, registry: Registry, type: number, count: number | null): TossedStack[] {
  const wanted = count ?? 1;
  if (totalOf(window, type) < wanted) {
    const name = registry.items[type]?.name ?? String(type);
    throw new Error(`Can't find ${name} in slots [${window.inventoryStart} - ${window.inventoryEnd}], (item id: ${type})`);
  }
  const tossed: TossedStack[] = [];
  let left = wanted;
  for (let slot = window.inventoryStart; slot < window.inventoryEnd && left > 0; slot += 1) {
    if (window.slots[slot]?.type !== type) continue;
    const whole = window.slots[slot]!.count <= left;
    const stack = takeFromSlot(window, registry, slot, left);
    left -= stack.count;
    // `transfer` drops a whole slot with one left click, a part of one with a right click per item: a drop per click.
    tossed.push(...(whole ? [stack] : Array.from({ length: stack.count }, () => ({ type: stack.type, count: 1 }))));
  }
  return tossed;
}

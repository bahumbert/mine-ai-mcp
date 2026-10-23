/**
 * How many of each item a domain builder's bot carries, read from and written to the shared fake's inventory window
 * (`fake-bot/fake-inventory.ts`), so a scene that counts by item id (a craft, a furnace transfer) and the window a test
 * or the code under test reads stay one inventory. Every change is a slot update, as the server's `set_slot` is.
 */
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import { type FakeHarness, type FakeInventory, itemOf } from "./fake-bot/index.js";

const MAIN_START = 9;
const HOTBAR_START = 36;
const INVENTORY_END = 45;

/** `Window.updateSlot`, whose typings forbid the null an emptied slot takes at runtime (Prismarine's `set_slot`). */
function putInSlot(inventory: FakeInventory, slot: number, item: Item | null): void {
  (inventory.updateSlot as (slot: number, item: Item | null) => void).call(inventory, slot, item);
}

/** The inventory slots in the order a stack lands in them: the hotbar first, then the main slots. */
const LANDING_ORDER = [
  ...Array.from({ length: INVENTORY_END - HOTBAR_START }, (_, index) => HOTBAR_START + index),
  ...Array.from({ length: HOTBAR_START - MAIN_START }, (_, index) => MAIN_START + index),
];

/** Make the window hold `total` of item `type`: fewer takes from the last stacks first; more tops up the stacks there, then fills empty slots. */
export function setCarriedCount(inventory: FakeInventory, registry: Bot["registry"], type: number, total: number): void {
  const name = registry.items[type]?.name;
  if (name === undefined) throw new Error(`unknown item id ${type} in ${registry.version.minecraftVersion}`);
  const held = LANDING_ORDER.filter((slot) => inventory.slots[slot]?.type === type);
  let change = total - inventory.count(type, null);
  for (const slot of [...held].reverse()) {
    if (change >= 0) break;
    const count = inventory.slots[slot]!.count;
    const left = Math.max(0, count + change);
    change += count - left;
    putInSlot(inventory, slot, left === 0 ? null : itemOf(registry, name, left));
  }
  const stackSize = itemOf(registry, name).stackSize;
  for (const slot of [...held, ...LANDING_ORDER.filter((free) => inventory.slots[free] == null)]) {
    if (change <= 0) break;
    const count = inventory.slots[slot]?.type === type ? inventory.slots[slot]!.count : 0;
    const added = Math.min(change, stackSize - count);
    if (added <= 0) continue;
    change -= added;
    putInSlot(inventory, slot, itemOf(registry, name, count + added));
  }
  if (change > 0) throw new Error(`no room for ${change} more ${name}: the 36 inventory slots are full`);
}

/** The window's totals by item id. */
function totals(inventory: FakeInventory): Map<number, number> {
  const counts = new Map<number, number>();
  for (const item of inventory.items()) counts.set(item.type, (counts.get(item.type) ?? 0) + item.count);
  return counts;
}

/** The window's item totals as a `Map` by item id: `get` reads the window, `set` and `delete` rewrite its stacks. */
export class CarriedCounts extends Map<number, number> {
  readonly #inventory: FakeInventory;
  readonly #registry: Bot["registry"];

  constructor(inventory: FakeInventory, registry: Bot["registry"]) {
    super();
    this.#inventory = inventory;
    this.#registry = registry;
  }

  override get(type: number): number | undefined {
    return totals(this.#inventory).get(type);
  }
  override has(type: number): boolean {
    return totals(this.#inventory).has(type);
  }
  override set(type: number, total: number): this {
    // `Map`'s constructor calls no `set` here (no entries given), so the fields are always assigned.
    setCarriedCount(this.#inventory, this.#registry, type, total);
    return this;
  }
  override delete(type: number): boolean {
    const had = this.has(type);
    setCarriedCount(this.#inventory, this.#registry, type, 0);
    return had;
  }
  override clear(): void {
    for (const type of totals(this.#inventory).keys()) setCarriedCount(this.#inventory, this.#registry, type, 0);
  }
  override get size(): number {
    return totals(this.#inventory).size;
  }
  override entries(): MapIterator<[number, number]> {
    return totals(this.#inventory).entries();
  }
  override keys(): MapIterator<number> {
    return totals(this.#inventory).keys();
  }
  override values(): MapIterator<number> {
    return totals(this.#inventory).values();
  }
  override forEach(callback: (value: number, key: number, map: Map<number, number>) => void, thisArg?: unknown): void {
    totals(this.#inventory).forEach((value, key) => callback.call(thisArg, value, key, this));
  }
  override [Symbol.iterator](): MapIterator<[number, number]> {
    return this.entries();
  }
}

/** A carried item's count as a field a test reads and sets, kept in the harness's inventory window. */
export function carriedCountField(harness: FakeHarness, name: string) {
  const counts = new CarriedCounts(harness.inventory, harness.bot.registry);
  const type = harness.bot.registry.itemsByName[name]!.id;
  return {
    name,
    get count() {
      return counts.get(type) ?? 0;
    },
    set count(total: number) {
      counts.set(type, total);
    },
  };
}

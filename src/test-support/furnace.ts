/**
 * A furnace window whose cook runs on a fake clock, with the inventory it fills and empties. Tests give the clock
 * (`pause`) and the furnace to `smeltItem` through its dependencies.
 */
import { EventEmitter } from "node:events";
import type { FurnaceProperties } from "../actions/smelt-item/furnace-properties.js";
import type { SmeltItemDependencies } from "../actions/smelt-item/smelt-item.js";
import { fuelCapacity as capacityIn } from "../world/smelting.js";
import { botFixture, registry, type FakeStack } from "./bot.js";
import { startServerClock } from "./server-clock.js";

/** The fuel burning in the fake furnace, and what the server's window property packets would say about it. */
const fuelCapacity = (fuel: string) => capacityIn(fuel, registry.version.minecraftVersion!);

class FakeBurn {
  #msLeft = 0;
  constructor(readonly fuel: string, readonly cookMs: number) {}
  /** A fuel item burns `fuelCapacity` cooks long; the first one lights at once. */
  load(count: number) { this.#msLeft += count * fuelCapacity(this.fuel) * this.cookMs; }
  pass(ms: number) { this.#msLeft = Math.max(0, this.#msLeft - ms); }
  properties(elapsedInItem: number): FurnaceProperties {
    return {
      litTicks: this.#msLeft / 50,
      litTotalTicks: (fuelCapacity(this.fuel) * this.cookMs) / 50,
      cookTicks: elapsedInItem / 50,
      cookTotalTicks: this.cookMs / 50,
    };
  }
}

export interface ObservedFurnaceOptions {
  readonly cookMs: number;
  readonly stopAfter?: number;
  readonly starved?: boolean;
  readonly recoverInputCount?: number;
  readonly raw?: number;
  readonly coal?: number;
  readonly full?: boolean;
  /** Carried fuel item; `coal` is its count. */
  readonly fuel?: string;
  /** Report `properties()`, the server's ticks of burn and cook, as the game does (scenario busy-smelt-interrupted: a lit coal leaves the fuel slot at once and keeps burning). Off: silent, as before. */
  readonly reportsBurnTime?: boolean;
  /** The window shows the input and output slots as they stood before an item finished until the next tick, as Mineflayer's window is redrawn by a later `set_slot` than the server's change (live, `furnace-cook.ts` `creditMissedIngots`: "it showed 2 and the click moved 3"); a click redraws the slot it moved. Off: the window is the server. */
  readonly windowLagsCompletion?: boolean;
  /** The nth click on the output slot (1 = the first) throws, as a take whose window closed under it. */
  readonly outputClickFailsAt?: number;
}

/** Wall-clock delay of the server's correction of a mispredicted take: ten ticks at `startServerClock`'s 20 ticks per 10 ms. */
const TRAILING_SYNC_MS = 5;

/** The furnace's input and output slots as the server holds them, and as its window shows them. */
class FakeFurnaceSlots {
  input = 0;
  output = 0;
  readonly #shown = { input: 0, output: 0 };
  constructor(readonly windowLags: boolean) {}
  /** The window catches up with the server: the `set_slot` of the tick before. */
  redraw() {
    this.#shown.input = this.input;
    this.#shown.output = this.output;
  }
  get shownInput() { return this.windowLags ? this.#shown.input : this.input; }
  get shownOutput() { return this.windowLags ? this.#shown.output : this.output; }
  /** Take the input back, at most `limit`: what the server moved, and what the window predicted it would. */
  takeInput(limit = Number.POSITIVE_INFINITY): { moved: number; predicted: number } {
    const moved = Math.min(this.input, limit);
    const predicted = Math.min(this.shownInput, limit);
    this.input -= moved;
    this.redraw();
    return { moved, predicted };
  }
  /** A shift-click moves the whole output stack; its own `set_slot` redraws that slot only. */
  clickOutput(): number {
    const moved = this.output;
    this.output = 0;
    this.#shown.output = 0;
    return moved;
  }
}

/** Shift-clicks on the output slot (2) into the inventory; the `failsAt`th one throws. */
function outputSlotClicks(slots: FakeFurnaceSlots, adjust: (name: string, delta: number) => void, failsAt?: number) {
  let clicks = 0;
  return async (slot: number) => {
    if (slot !== 2 || slots.output === 0) return;
    clicks += 1;
    if (clicks === failsAt) throw new Error("window closed under the take");
    adjust("iron_ingot", slots.clickOutput());
  };
}

/** The carried stacks, and the change a furnace transfer makes to them. */
function carriedStacks(options: ObservedFurnaceOptions) {
  const items: FakeStack[] = [
    { name: "raw_iron", count: options.raw ?? 3 },
    { name: options.fuel ?? "coal", count: options.coal ?? 1 },
  ];
  const adjust = (name: string, delta: number) => {
    const stack = items.find((candidate) => candidate.name === name);
    if (stack) stack.count += delta;
    else items.push({ name, count: delta, type: registry.itemsByName[name]!.id });
    if (stack?.count === 0) items.splice(items.indexOf(stack), 1);
  };
  return { items, adjust };
}

export function observedFurnace(options: ObservedFurnaceOptions) {
  const { items, adjust } = carriedStacks(options);
  let now = 0;
  let activeFuel = 0;
  const slots = new FakeFurnaceSlots(options.windowLagsCompletion === true);
  const burn = new FakeBurn(options.fuel ?? "coal", options.cookMs);
  const furnace = Object.assign(new EventEmitter(), {
    id: 7, progress: 0,
    fuel: 0,
    properties: options.reportsBurnTime ? () => burn.properties(elapsedInItem) : undefined,
    inputItem: () => slots.shownInput > 0 ? { name: "raw_iron", count: slots.shownInput } : null,
    fuelItem: () => null,
    outputItem: () => slots.shownOutput > 0 ? { name: "iron_ingot", count: slots.shownOutput, type: registry.itemsByName.iron_ingot!.id, stackSize: 64, slot: 2 } : null,
    putInput: async (_type: number, _metadata: null, count: number) => {
      adjust("raw_iron", -count);
      slots.input = count;
      slots.redraw();
    },
    putFuel: async (_type: number, _metadata: null, count: number) => {
      adjust(options.fuel ?? "coal", -count);
      activeFuel = options.starved ? 0 : 1;
      furnace.fuel = activeFuel;
      burn.load(count);
    },
    takeInput: async () => {
      const taken = { name: "raw_iron", count: slots.input };
      const { moved, predicted } = slots.takeInput(options.recoverInputCount);
      // The inventory first holds what the window predicted (mineflayer `copyInventory` on close); the server's
      // trailing `set_slot` for the closed window corrects it a moment later (inventory.js, `lastClosedWindow`).
      adjust(taken.name, predicted);
      if (predicted !== moved) setTimeout(() => adjust(taken.name, moved - predicted), TRAILING_SYNC_MS);
      return taken;
    },
    takeFuel: async () => null,
    takeOutput: async () => {
      const taken = { name: "iron_ingot", count: slots.output };
      adjust(taken.name, taken.count);
      slots.output = 0;
      slots.redraw();
      return taken;
    },
    close: () => undefined,
  });
  const bot = botFixture({ items, blocks: { "2,64,0": "furnace" } }, { version: "1.21.4" });
  if (options.full) (bot.inventory as { emptySlotCount?: () => number }).emptySlotCount = () => 0;
  // The world age moves on while an attempt waits for the server's answer to its takes.
  startServerClock(bot);
  bot.clickWindow = outputSlotClicks(slots, adjust, options.outputClickFailsAt);
  let elapsedInItem = 0;
  const dependencies: SmeltItemDependencies = {
    createMovements: () => ({}) as never,
    navigate: async () => ({ status: "completed", elapsedMs: 0 }),
    // A window just opened shows the server's slots (`window_items`).
    openFurnace: async () => {
      slots.redraw();
      return furnace as never;
    },
    now: () => now,
    pause: async (milliseconds, signal) => {
      signal?.throwIfAborted();
      slots.redraw();
      now += milliseconds;
      if (slots.output === options.stopAfter) return;
      if (activeFuel === 0) return;
      elapsedInItem += milliseconds; burn.pass(milliseconds);
      furnace.progress = Math.min(1, elapsedInItem / options.cookMs);
      furnace.fuel = activeFuel > 0 ? Math.max(0, 1 - now / (options.cookMs * 8 * (options.coal ?? 1))) : 0;
      if (elapsedInItem < options.cookMs) return;
      elapsedInItem = 0;
      furnace.progress = 0;
      slots.input -= 1;
      slots.output += 1;
      if (slots.input === 0) activeFuel = 0;
    },
  };
  return { bot, dependencies, furnace, get now() { return now; } };
}

/**
 * A furnace window whose cook runs on a fake clock, with the inventory it fills and empties. Tests give the clock
 * (`pause`) and the furnace to `smeltItem` through its dependencies.
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import minecraftData from "minecraft-data";
import type { FurnaceProperties } from "../actions/smelt-item/furnace-properties.js";
import type { SmeltItemDependencies } from "../actions/smelt-item/smelt-item.js";
import { fuelCapacity as capacityIn } from "../world/smelting.js";
import { CarriedCounts } from "./carried-counts.js";
import { type FakeClock, createFakeBot, itemOf } from "./fake-bot/index.js";

const FURNACE_VERSION = "1.21.4";
const registry = minecraftData(FURNACE_VERSION);
const FURNACE_CELL = "2,64,0";

/**
 * Harness clock one smelt attempt may take. The cook runs on the fixture's `pause`, not on that clock, so the clock
 * carries only the attempt's waits for the server's answers: 40 ticks of world age (2 s at 20 ticks a second).
 * Each take now waits for its own answer (a4 B1 Branch R, 2026-11-15); the original 1.5 s margin stays.
 */
export const answeredAttemptMs = (answerWaits: number) => 2_000 * answerWaits + 1_500;
/** Compatibility for the out-of-task runner test: its two attempts now take 8 s of harness clock (B3b). */
export const ANSWERED_ATTEMPT_MS = answeredAttemptMs(2);

const windowLibrary = createRequire(import.meta.url)("prismarine-windows")(FURNACE_VERSION);
type Stack = { readonly name: string; readonly count: number };
type FurnaceContents = { inputItem(): Stack | null; fuelItem(): Stack | null; outputItem(): Stack | null; close(): void };
type CookWindow<T> = Omit<T, keyof FurnaceContents> & EventEmitter & {
  readonly id: number; readonly inventoryStart: number; readonly inventoryEnd: number; readonly slots: (Item | null)[];
  inputItem(): Item | null; fuelItem(): Item | null; outputItem(): Item | null; close(): void;
};

/** Give cook doubles the measured furnace menu and source items used by shift-clicks (16a, a4 B1). */
export function furnaceWindow<T extends FurnaceContents>(bot: Bot, contents: T): CookWindow<T> {
  const menu = windowLibrary.createWindow(7, "minecraft:furnace", "Furnace");
  const read = (source: "inputItem" | "fuelItem" | "outputItem", slot: number) => {
    const stack = contents[source]();
    return stack ? Object.assign(itemOf(bot.registry, stack.name, stack.count), { slot }) : null;
  };
  const window = Object.assign(new EventEmitter(), contents, new EventEmitter(), {
    id: menu.id, inventoryStart: menu.inventoryStart, inventoryEnd: menu.inventoryEnd,
    slots: [] as (Item | null)[],
    inputItem: () => read("inputItem", 0), fuelItem: () => read("fuelItem", 1), outputItem: () => read("outputItem", 2),
    close() {
      contents.close();
      if (bot.currentWindow === window as never) bot.currentWindow = null;
      window.emit("close");
    },
  });
  Object.defineProperty(window, "slots", { get: () => {
    const slots = Array(menu.slots.length).fill(null);
    slots[0] = window.inputItem(); slots[1] = window.fuelItem(); slots[2] = window.outputItem();
    // Stopgap: cook doubles change carried counts while open, unlike Mineflayer's stale inventory until close (16a).
    for (let slot = menu.inventoryStart; slot < menu.inventoryEnd; slot++) slots[slot] = bot.inventory.slots[slot - menu.inventoryStart + bot.inventory.inventoryStart];
    return slots;
  } });
  bot.currentWindow = window as never;
  return window;
}

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
  /** The harness's clock (a mocked one the test drives); a new manual clock otherwise. The world age is the server's own, which only the clock moves. */
  readonly clock?: FakeClock;
}

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

/** Shift-click all three sources, without a window packet for an accepted prediction (16a). */
function furnaceSlotClicks(slots: FakeFurnaceSlots, adjust: (name: string, delta: number) => void, takes: { input(): Promise<unknown>; fuel(): Promise<unknown> }, failsAt?: number) {
  let clicks = 0;
  return async (slot: number) => {
    if (slot === 0) { await takes.input(); return; }
    if (slot === 1) { await takes.fuel(); return; }
    if (slot !== 2 || slots.output === 0) return;
    clicks += 1;
    if (clicks === failsAt) throw new Error("window closed under the take");
    adjust("iron_ingot", slots.clickOutput());
  };
}

/** What the bot carries at the start: the ore and the fuel. */
const carriedAtStart = (options: ObservedFurnaceOptions) => ({ raw_iron: options.raw ?? 3, [options.fuel ?? "coal"]: options.coal ?? 1 });

/**
 * The bot on the shared fake, carrying the ore and the fuel in its window, a furnace beside it, and the change a
 * furnace transfer makes to what it carries.
 */
function sceneOnHarness(options: ObservedFurnaceOptions) {
  const harness = createFakeBot({ version: FURNACE_VERSION, clock: options.clock, cells: { [FURNACE_CELL]: "furnace" }, carried: carriedAtStart(options) });
  const counts = new CarriedCounts(harness.inventory, harness.bot.registry);
  const adjust = (name: string, delta: number) => {
    const id = registry.itemsByName[name]!.id;
    counts.set(id, (counts.get(id) ?? 0) + delta);
  };
  // The server's trailing `set_slot` is one of its answers: it comes on the harness clock, and not while it is stopped.
  return { bot: harness.bot, harness, adjust, later: (fix: () => void) => harness.server.answer(fix) };
}

export function observedFurnace(options: ObservedFurnaceOptions) {
  const { bot, harness, adjust, later } = sceneOnHarness(options);
  let now = 0;
  let activeFuel = 0;
  const slots = new FakeFurnaceSlots(options.windowLagsCompletion === true);
  const burn = new FakeBurn(options.fuel ?? "coal", options.cookMs);
  let furnace = furnaceWindow(bot, {
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
      if (predicted !== moved) later(() => adjust(taken.name, moved - predicted));
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
  if (options.full) bot.inventory.emptySlotCount = () => 0;
  bot.clickWindow = furnaceSlotClicks(slots, adjust, { input: furnace.takeInput, fuel: furnace.takeFuel }, options.outputClickFailsAt);
  let elapsedInItem = 0;
  const dependencies: SmeltItemDependencies = {
    createMovements: () => ({}) as never,
    navigate: async () => ({ status: "completed", elapsedMs: 0 }),
    // A window just opened shows the server's slots (`window_items`).
    openFurnace: async () => {
      slots.redraw();
      if (bot.currentWindow !== furnace as never) furnace = furnaceWindow(bot, { ...furnace, close: () => undefined });
      bot.currentWindow = furnace as never;
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
  return { bot, dependencies, get furnace() { return furnace; }, harness, get now() { return now; } };
}

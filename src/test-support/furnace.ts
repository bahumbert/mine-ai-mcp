/**
 * A furnace window whose cook runs on a fake clock, with the inventory it fills and empties. Tests give the clock
 * (`pause`) and the furnace to `smeltItem` through its dependencies.
 */
import { EventEmitter } from "node:events";
import type { FurnaceProperties } from "../actions/smelt-item/furnace-properties.js";
import type { SmeltItemDependencies } from "../actions/smelt-item/smelt-item.js";
import { fuelCapacity as capacityIn } from "../world/smelting.js";
import { botFixture, registry, type FakeStack } from "./bot.js";

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

export function observedFurnace(options: { readonly cookMs: number; readonly stopAfter?: number; readonly starved?: boolean; readonly recoverInputCount?: number; readonly raw?: number; readonly coal?: number; readonly full?: boolean; /** Carried fuel item; `coal` is its count. */ readonly fuel?: string; /** Report `properties()`, the server's ticks of burn and cook, as the game does (scenario busy-smelt-interrupted: a lit coal leaves the fuel slot at once and keeps burning). Off: silent, as before. */ readonly reportsBurnTime?: boolean }) {
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
  let now = 0;
  let input = 0;
  let output = 0;
  let activeFuel = 0;
  const burn = new FakeBurn(options.fuel ?? "coal", options.cookMs);
  const furnace = Object.assign(new EventEmitter(), {
    id: 7, progress: 0,
    fuel: 0,
    properties: options.reportsBurnTime ? () => burn.properties(elapsedInItem) : undefined,
    inputItem: () => input > 0 ? { name: "raw_iron", count: input } : null,
    fuelItem: () => null,
    outputItem: () => output > 0 ? { name: "iron_ingot", count: output, type: registry.itemsByName.iron_ingot!.id, stackSize: 64, slot: 2 } : null,
    putInput: async (_type: number, _metadata: null, count: number) => {
      adjust("raw_iron", -count);
      input = count;
    },
    putFuel: async (_type: number, _metadata: null, count: number) => {
      adjust(options.fuel ?? "coal", -count);
      activeFuel = options.starved ? 0 : 1;
      furnace.fuel = activeFuel;
      burn.load(count);
    },
    takeInput: async () => {
      const taken = { name: "raw_iron", count: input };
      const moved = Math.min(input, options.recoverInputCount ?? input);
      adjust(taken.name, moved);
      input -= moved;
      return taken;
    },
    takeFuel: async () => null,
    takeOutput: async () => {
      const taken = { name: "iron_ingot", count: output };
      adjust(taken.name, taken.count);
      output = 0;
      return taken;
    },
    close: () => undefined,
  });
  const bot = botFixture({ items, blocks: { "2,64,0": "furnace" } }, { version: "1.21.4" });
  if (options.full) (bot.inventory as { emptySlotCount?: () => number }).emptySlotCount = () => 0;
  bot.clickWindow = async (slot) => {
    if (slot !== 2 || output === 0) return;
    adjust("iron_ingot", output);
    output = 0;
  };
  let elapsedInItem = 0;
  const dependencies: SmeltItemDependencies = {
    createMovements: () => ({}) as never,
    navigate: async () => ({ status: "completed", elapsedMs: 0 }),
    openFurnace: async () => furnace as never,
    now: () => now,
    pause: async (milliseconds, signal) => {
      signal?.throwIfAborted();
      now += milliseconds;
      if (output === options.stopAfter) return;
      if (activeFuel === 0) return;
      elapsedInItem += milliseconds; burn.pass(milliseconds);
      furnace.progress = Math.min(1, elapsedInItem / options.cookMs);
      furnace.fuel = activeFuel > 0 ? Math.max(0, 1 - now / (options.cookMs * 8 * (options.coal ?? 1))) : 0;
      if (elapsedInItem < options.cookMs) return;
      elapsedInItem = 0;
      furnace.progress = 0;
      input -= 1;
      output += 1;
      if (input === 0) activeFuel = 0;
    },
  };
  return { bot, dependencies, furnace, get now() { return now; } };
}

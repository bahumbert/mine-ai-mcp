// A furnace window's cook: what it holds, the ingots taken while it burns, the wait for it, and the recovery of what is left.
import type { Bot } from "mineflayer";
import { carriedCount } from "../../world/inventory-count.js";
import { waitForSignal } from "../../utils/signals.js";

const COOK_MS_PER_ITEM = 10_000;
const COOK_STALL_MS = 15_000;
const FUEL_START_SETTLEMENT_MS = 1_000;
const HARVEST_STACK = 8;
const HARVEST_INTERVAL_MS = 30_000;
export const SLOT_RECOVERY_MS = 2_000;

export type FurnaceWindow = Awaited<ReturnType<Bot["openFurnace"]>>;

/** The clock a cook is timed with: monotonic in production, a fake one in tests. */
export interface CookClock {
  readonly now: () => number;
  readonly pause: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface Recovery {
  readonly input: number;
  readonly fuel: number;
  readonly output: { readonly name: string; readonly count: number; readonly inventoryBefore: number } | null;
  readonly errors: readonly string[];
}

async function boundedTake<T>(operation: () => Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${SLOT_RECOVERY_MS} ms.`)), SLOT_RECOVERY_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function hasInventoryRoom(bot: Bot, item: ReturnType<FurnaceWindow["outputItem"]>): boolean {
  if (!item) return false;
  if (bot.inventory.items().some((stack) => stack.type === item.type && stack.count < stack.stackSize)) return true;
  const inventory = bot.inventory as Bot["inventory"] & { emptySlotCount?: () => number };
  return (inventory.emptySlotCount?.() ?? 1) > 0;
}

async function takeOutputOnce(bot: Bot, window: FurnaceWindow) {
  const item = window.outputItem();
  if (!item) return null;
  if (!hasInventoryRoom(bot, item)) throw new Error(`No inventory room for furnace output ${item.name} x${item.count}.`);
  const inventoryBefore = carriedCount(bot, item.name);
  // Shift-clicking into an existing stack mutates this same Item's count.
  // Retain the pre-click quantity or a successful transfer looks like 0 removed.
  const outputBefore = item.count;
  // Furnace slot 2 is marked as a crafting result by prismarine-windows, so
  // Furnace.takeOutput uses a cursor pickup followed by another click. A
  // single shift-click is safe here: cooking itself cannot repeat on click.
  await bot.clickWindow(item.slot, 0, 1);
  // While a container is open, Mineflayer's player inventory can lag behind
  // the window packet even after the server accepted this click. The furnace
  // output slot is the direct witness for this one-slot transaction.
  const removed = await waitForSignal(
    () => Math.max(0, outputBefore - (window.outputItem()?.count ?? 0)),
    window,
    "updateSlot",
    { timeoutMs: SLOT_RECOVERY_MS },
  );
  const count = removed ?? 0;
  return { name: item.name, count, inventoryBefore, confirmed: count > 0 };
}

async function takeResidualOnce(window: FurnaceWindow, slot: "inputItem" | "fuelItem") {
  const item = window[slot]();
  if (!item) return null;
  if (slot === "inputItem") await window.takeInput();
  else await window.takeFuel();
  const remaining = window[slot]()?.count ?? 0;
  return { name: item.name, count: Math.max(0, item.count - remaining), confirmed: remaining < item.count };
}

export async function recover(bot: Bot, window: FurnaceWindow): Promise<Recovery> {
  let input = 0;
  let fuel = 0;
  let output: Recovery["output"] = null;
  const errors: string[] = [];
  for (const [read, take] of [
    ["outputItem", "takeOutput"],
    ["inputItem", "takeInput"],
    ["fuelItem", "takeFuel"],
  ] as const) {
    try {
      const slotItem = window[read]();
      if (!slotItem) continue;
      if (!hasInventoryRoom(bot, slotItem)) {
        errors.push(`No inventory room for furnace ${read === "outputItem" ? "output" : read === "inputItem" ? "input" : "fuel"} ${slotItem.name} x${slotItem.count}.`);
        break;
      }
      if (take === "takeOutput") {
        const taken = await boundedTake(() => takeOutputOnce(bot, window), take);
        if (!taken) continue;
        output = { name: taken.name, count: taken.count, inventoryBefore: taken.inventoryBefore };
        if (!taken.confirmed) {
          errors.push(`Inventory did not confirm furnace output ${taken.name}.`);
          break;
        }
      } else {
        const taken = await boundedTake(() => takeResidualOnce(window, read), take);
        if (!taken) continue;
        if (take === "takeInput") input += taken.count;
        else fuel += taken.count;
      }
    } catch (cause) {
      errors.push(cause instanceof Error ? cause.message : String(cause));
      // A timed-out transfer can still be pending inside Mineflayer. Do not
      // start a second slot mutation against the same window.
      break;
    }
  }
  return { input, fuel, output, errors };
}

/** Ingots taken out while the furnace still cooks, so the carried count rises as they come. */
export interface Harvest {
  readonly taken: () => number;
  readonly item: () => { readonly name: string; readonly inventoryBefore: number } | null;
  readonly takeReady: (outputCount: number) => Promise<void>;
}

export function midCookHarvest(bot: Bot, window: FurnaceWindow, now: () => number): Harvest {
  let taken = 0;
  let item: { name: string; inventoryBefore: number } | null = null;
  let lastTakeAt = now();
  let disabled = false;
  return {
    taken: () => taken,
    item: () => item,
    async takeReady(outputCount) {
      const at = now();
      if (disabled || outputCount === 0) return;
      if (outputCount < HARVEST_STACK && at - lastTakeAt < HARVEST_INTERVAL_MS) return;
      lastTakeAt = at;
      try {
        const out = await boundedTake(() => takeOutputOnce(bot, window), "takeOutput");
        if (!out) return;
        item ??= { name: out.name, inventoryBefore: out.inventoryBefore };
        taken += out.count;
        if (!out.confirmed) disabled = true;
      } catch {
        // No room or a transfer that did not settle: leave the output in the furnace; the final
        // recovery tries once more and reports the reason. No second mutation on a pending window.
        disabled = true;
      }
    },
  };
}

export interface FurnaceObservation {
  readonly output: number;
  readonly input: number;
  readonly fuelItems: number;
  readonly cookProgress: number | null;
  readonly fuelProgress: number | null;
}

export type CookVerdict = "completed" | "fuel_starved" | "stalled" | "safety_timeout";

export function furnaceObservation(window: FurnaceWindow): FurnaceObservation {
  const state = window as FurnaceWindow & { progress?: number | null; fuel?: number | null };
  return {
    output: window.outputItem()?.count ?? 0,
    input: window.inputItem()?.count ?? 0,
    fuelItems: window.fuelItem()?.count ?? 0,
    cookProgress: typeof state.progress === "number" ? state.progress : null,
    fuelProgress: typeof state.fuel === "number" ? state.fuel : null,
  };
}

export async function waitForCook(
  window: FurnaceWindow,
  requested: number,
  dependencies: CookClock,
  signal?: AbortSignal,
  observe?: (observation: FurnaceObservation, stalledForMs: number) => void,
  harvest?: Harvest,
): Promise<{ readonly verdict: CookVerdict; readonly observation: FurnaceObservation }> {
  const startedAt = dependencies.now();
  const safetyDeadline = startedAt + Math.max(60_000, requested * COOK_MS_PER_ITEM * 4 + COOK_STALL_MS);
  let lastAdvanceAt = startedAt;
  let previous = furnaceObservation(window);
  while (true) {
    signal?.throwIfAborted();
    const current = furnaceObservation(window);
    const now = dependencies.now();
    if (current.output !== previous.output || current.cookProgress !== previous.cookProgress) lastAdvanceAt = now;
    const stalledForMs = Math.max(0, now - lastAdvanceAt);
    observe?.(current, stalledForMs);
    if ((harvest?.taken() ?? 0) + current.output >= requested && current.input === 0 && (current.cookProgress ?? 0) === 0)
      return { verdict: "completed", observation: current };
    if (
      now - startedAt >= FUEL_START_SETTLEMENT_MS &&
      current.input > 0 &&
      current.fuelItems === 0 &&
      current.fuelProgress === 0 &&
      (current.cookProgress ?? 0) === 0
    ) return { verdict: "fuel_starved", observation: current };
    if (stalledForMs >= COOK_STALL_MS) return { verdict: "stalled", observation: current };
    if (now >= safetyDeadline) return { verdict: "safety_timeout", observation: current };
    await harvest?.takeReady(current.output);
    previous = furnaceObservation(window);
    await dependencies.pause(100, signal);
  }
}

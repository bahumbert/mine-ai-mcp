// The ingots one smelt attempt made: counted from the input it loaded and got back, not from the window's take deltas.
import type { Bot } from "mineflayer";
import { carriedCount, INVENTORY_SETTLE_WALL_MS, type SettledInventoryCount } from "../../world/inventory-count.js";
import { waitForServerAnswer } from "../../world/world-age.js";
import { ingotsFromInput, type CookVerdict, type Harvest, type Recovery } from "./furnace-cook.js";

/** The input an attempt put in the furnace: the carried count just before, and how many went in. */
export interface LoadedInput {
  readonly carriedBefore: number;
  readonly count: number;
}

/** What one attempt's load, cook and recovery left behind, once its furnace window is closed. */
export interface CookAttempt {
  readonly verdict: CookVerdict | "execution_failed";
  readonly executionError: string;
  readonly recovery: Recovery;
  readonly harvest: Harvest;
  /** Null when `putInput` did not resolve: what went in is unknown. */
  readonly loaded: LoadedInput | null;
  /** What the window last showed in the input slot, after the recovery and before the close. */
  readonly inputLeft: number;
  /** World age when the recovery's takes went out. */
  readonly recoveredAtAge: number | undefined;
}

/** The output the attempt took, for the check that the inventory received it. */
export interface AttemptOutput {
  /** What the takes moved by the window's count: the least the inventory holds more. */
  readonly taken: number;
  readonly inventoryBefore: number;
}

export interface AttemptIngots {
  readonly produced: number;
  /**
   * Whether ingots still in the output slot are in `produced`: counted from the input with nothing left in the input
   * slot (the furnace cooks nothing more of ours), so an ingot the window hid from the takes is counted once, here.
   */
  readonly outputLeftCounted: boolean;
  /** The output item the attempt took, if it took any. */
  readonly outputItem: string | null;
  /** Null when the attempt took no output. */
  readonly output: AttemptOutput | null;
  /** The carried input once the furnace's give-back landed; null when it was not waited for. */
  readonly inputAfter: SettledInventoryCount | null;
}

/**
 * The carried input once what the recovery gave back has landed. Closing the window copies its predicted slots into the
 * inventory (mineflayer `copyInventory`); a take of the input that moved one item fewer than the window showed (one the
 * server cooked in the take's tick) is corrected by a trailing `set_slot`. So after an input take the server's answer
 * is waited for: the correction, or the world age moving `SERVER_ANSWER_TICKS` on. No abort signal: an aborted attempt
 * still recovers, and must read the count after the server's answer, not before.
 */
async function settleReturnedInput(bot: Bot, itemName: string, loaded: LoadedInput, cook: CookAttempt): Promise<SettledInventoryCount> {
  const shown = loaded.carriedBefore - loaded.count + cook.recovery.input;
  const lowest = cook.recovery.input > 0 ? shown - 1 : shown;
  if (lowest < shown) {
    await waitForServerAnswer(bot, cook.recoveredAtAge, {
      wallMs: INVENTORY_SETTLE_WALL_MS,
      until: () => carriedCount(bot, itemName) === lowest,
    });
  }
  const count = carriedCount(bot, itemName);
  return { count, confirmed: count >= lowest && count <= shown };
}

/**
 * What the attempt cooked. From the input (`ingotsFromInput`) when the recovery gave everything back and the inventory
 * settled; from the window's take deltas otherwise (a failed take leaves ingots in the furnace; fuel that is also the
 * input burns out of the same carried count).
 */
export async function countAttemptIngots(
  bot: Bot,
  request: { readonly itemName: string; readonly fuelItemName: string },
  cook: CookAttempt,
): Promise<AttemptIngots> {
  const harvested = cook.harvest.item();
  const { recovery, loaded } = cook;
  const taken = cook.harvest.taken() + (recovery.output?.count ?? 0);
  const countable = loaded !== null && recovery.errors.length === 0 && request.itemName !== request.fuelItemName;
  const inputAfter = countable ? await settleReturnedInput(bot, request.itemName, loaded, cook) : null;
  const fromInput = countable && inputAfter?.confirmed === true;
  const produced = fromInput ? ingotsFromInput(loaded.carriedBefore, inputAfter.count, cook.inputLeft) : taken;
  const takenItem = recovery.output ?? harvested;
  return {
    produced,
    outputLeftCounted: fromInput && cook.inputLeft === 0,
    outputItem: takenItem?.name ?? null,
    output: takenItem ? { taken, inventoryBefore: (harvested ?? recovery.output)!.inventoryBefore } : null,
    inputAfter,
  };
}

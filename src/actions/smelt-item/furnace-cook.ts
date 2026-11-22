// A furnace window's cook: what it holds, the ingots taken while it burns, the wait for it, and the recovery of what is left.
import type { Bot } from "mineflayer";
import type { FurnaceProperties } from "./furnace-properties.js";
import { answerTakes, sendTake, watchWindowAnswers } from "./furnace-take.js";
import { STANDARD_COOK_TICKS } from "../../world/smelting.js";

const COOK_STALL_MS = 15_000;
const FUEL_START_SETTLEMENT_MS = 1_000;
/** How long a reopened furnace has to report the fuel still burning in it: ten server ticks. */
const BURN_REPORT_MS = 500;
const TICK_MS = 50;
const HARVEST_STACK = 8;
const HARVEST_INTERVAL_MS = 30_000;

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

/** Recover each source only after the preceding take's server answer (a4 B1 Branch R, 2026-11-15). */
export async function recover(bot: Bot, window: FurnaceWindow, signal?: AbortSignal): Promise<Recovery> {
  let input = 0;
  let fuel = 0;
  let output: Recovery["output"] = null;
  const errors: string[] = [];
  const answers = watchWindowAnswers(bot, window);
  try {
    for (const source of ["output", "input", "fuel"] as const) {
      try {
        const take = await sendTake(bot, window, source);
        if (!take) continue;
        const result = await answerTakes(bot, window, [take], answers, signal);
        const count = result.counts[0] ?? 0;
        if (source === "output") output = { name: take.like.name, count, inventoryBefore: take.inventoryBefore };
        else if (source === "input") input += count;
        else fuel += count;
        errors.push(...result.errors);
        if (result.answer === "closed" || result.answer === "stalled" || result.errors.length > 0) break;
      } catch (cause) {
        errors.push(cause instanceof Error ? cause.message : String(cause));
        break;
      }
    }
  } finally {
    answers.dispose();
  }
  return { input, fuel, output, errors };
}

/**
 * The items an attempt cooked, from the furnace's input: every item it loaded that neither came back to the inventory
 * nor stays in the input slot became an output (the item being cooked stays in the slot until done, and comes back).
 * The window's take deltas can be an ingot behind the server (see `creditMissedIngots`); the carried input is not.
 */
export function ingotsFromInput(carriedBefore: number, carriedAfter: number, leftInSlot: number): number {
  return Math.max(0, carriedBefore - carriedAfter - leftInSlot);
}

/** Ingots taken out while the furnace still cooks, so the carried count rises as they come. */
export interface Harvest {
  readonly taken: () => number;
  readonly item: () => { readonly name: string; readonly inventoryBefore: number } | null;
  readonly takeReady: (outputCount: number) => Promise<boolean>;
  /** Count ingots a take moved beyond what the window showed when it clicked (see `waitForCook`). */
  readonly credit: (count: number) => void;
}

export function midCookHarvest(bot: Bot, window: FurnaceWindow, now: () => number, signal?: AbortSignal): Harvest {
  let taken = 0;
  let item: { name: string; inventoryBefore: number } | null = null;
  let lastTakeAt = now();
  let disabled = false;
  return {
    taken: () => taken,
    item: () => item,
    credit: (count) => {
      taken += count;
    },
    async takeReady(outputCount) {
      const at = now();
      if (disabled || outputCount === 0) return false;
      if (outputCount < HARVEST_STACK && at - lastTakeAt < HARVEST_INTERVAL_MS) return false;
      lastTakeAt = at;
      const answers = watchWindowAnswers(bot, window);
      try {
        const take = await sendTake(bot, window, "output");
        if (!take) return false;
        item ??= { name: take.like.name, inventoryBefore: take.inventoryBefore };
        const result = await answerTakes(bot, window, [take], answers, signal);
        taken += result.counts[0] ?? 0;
        if (result.errors.length > 0 || result.answer === "stalled" || result.answer === "closed") disabled = true;
        signal?.throwIfAborted();
        return true;
      } catch {
        // The final recovery reports the failure; an abort retains the prediction before handing the body over.
        disabled = true;
        signal?.throwIfAborted();
        return false;
      } finally {
        answers.dispose();
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

/** The window's own fractions, or the server's counters when the window carries them (they do not lose a packet). */
export function furnaceObservation(window: FurnaceWindow): FurnaceObservation {
  const state = window as WithProperties & { progress?: number | null; fuel?: number | null };
  const said = state.properties?.() ?? null;
  const fraction = (done: number, total: number) => (total > 0 ? done / total : 0);
  return {
    output: window.outputItem()?.count ?? 0,
    input: window.inputItem()?.count ?? 0,
    fuelItems: window.fuelItem()?.count ?? 0,
    cookProgress: said ? fraction(said.cookTicks, said.cookTotalTicks) : typeof state.progress === "number" ? state.progress : null,
    fuelProgress: said ? fraction(said.litTicks, said.litTotalTicks) : typeof state.fuel === "number" ? state.fuel : null,
  };
}

/** A furnace window that tells what the server says it is doing, from the raw packets (see `furnace-properties.ts`). */
type WithProperties = FurnaceWindow & { readonly properties?: () => FurnaceProperties | null };

/**
 * How many more items the fuel already burning in the furnace will cook, whole items only: a lit fuel item leaves the
 * fuel slot at once and burns on, so a resumed attempt that has put its last coal in still has fuel (scenario
 * busy-smelt-interrupted). A window that has not reported its burn time counts as none.
 */
export function burningItems(window: FurnaceWindow, cookTicks = STANDARD_COOK_TICKS): number {
  const ticks = (window as WithProperties).properties?.()?.litTicks;
  return typeof ticks === "number" ? Math.floor(ticks / cookTicks) : 0;
}

/**
 * Wait until a furnace just opened has reported its properties: the server sends them with the window, a moment after
 * the window itself. A window without them (a test double) reports at once; one that stays silent is read as not burning.
 */
export async function settleBurnReport(window: FurnaceWindow, dependencies: CookClock, signal?: AbortSignal): Promise<void> {
  const properties = (window as WithProperties).properties;
  if (properties === undefined) return;
  const startedAt = dependencies.now();
  while (properties() === null && dependencies.now() - startedAt < BURN_REPORT_MS) await dependencies.pause(50, signal);
}

/** Observations in a row that must find the cook over: the input and output slots update in separate packets. */
const COOK_OVER_OBSERVATIONS = 2;

/**
 * A mid-cook take shift-clicks the whole output stack, and the window it counts from can be one ingot behind the
 * server's (live, busy-smelt-interrupted: it showed 2 and the click moved 3; smelt-batch-normal, 16 items: "retrieved
 * 14/16", on the base too), so the cook never reaches its count and ends `SMELT_STALLED`. The furnace itself settles it:
 * input seen and now gone and nothing cooking for `COOK_OVER_OBSERVATIONS` observations means every item loaded became
 * an ingot; those in the output slot are counted, the others left through a take, and what the takes did not count is
 * credited. Only after a take (there is one to blame) and only for an input this wait saw.
 */
function creditMissedIngots(harvest: Harvest | undefined, requested: number, output: number, cookOverFor: number): void {
  if (!harvest || cookOverFor < COOK_OVER_OBSERVATIONS || harvest.item() === null) return;
  const missed = requested - harvest.taken() - output;
  if (missed > 0) harvest.credit(missed);
}

export async function waitForCook(
  window: FurnaceWindow,
  requested: number,
  dependencies: CookClock,
  signal?: AbortSignal,
  observe?: (observation: FurnaceObservation, stalledForMs: number) => void,
  harvest?: Harvest,
  cookTicks = STANDARD_COOK_TICKS,
): Promise<{ readonly verdict: CookVerdict; readonly observation: FurnaceObservation }> {
  const startedAt = dependencies.now();
  // Four times the time the recipe says the cook takes, so a lagging server does not end a cook that is going on.
  const safetyDeadline = startedAt + Math.max(60_000, requested * cookTicks * TICK_MS * 4 + COOK_STALL_MS);
  let lastAdvanceAt = startedAt;
  let previous = furnaceObservation(window);
  let sawInput = false;
  let cookOverFor = 0;
  while (true) {
    signal?.throwIfAborted();
    const current = furnaceObservation(window);
    const now = dependencies.now();
    if (current.input > 0) sawInput = true;
    cookOverFor = sawInput && current.input === 0 && (current.cookProgress ?? 0) === 0 ? cookOverFor + 1 : 0;
    creditMissedIngots(harvest, requested, current.output, cookOverFor);
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
    if (await harvest?.takeReady(current.output)) lastAdvanceAt = dependencies.now();
    previous = furnaceObservation(window);
    await dependencies.pause(100, signal);
  }
}

import { smeltCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { createMovements, nearGoal, type Navigate, type NavigationRuntime } from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import type { ObserveRequest, RequestEvidence } from "../../session/request.js";
import { carriedCount, settledNow, settleInventoryCount, settleInventoryMinimum } from "../../world/inventory-count.js";
import { startOwnPlacement } from "../../world/own-placement.js";
import { cookingTicksOf, fuelCapacity, STANDARD_COOK_TICKS } from "../../world/smelting.js";
import { SMELTING_STATION } from "../../world/workstations.js";
import { defineAction, type ActionContext } from "../action.js";
import { describeNavigation } from "../navigation-result.js";
import {
  formatWorkstation,
  useTemporaryWorkstation,
  workstationOperations,
  type WorkstationOperations,
} from "../temporary-workstation.js";
import type { ExistingFurnaceRequest } from "./contract.js";
import { countAttemptIngots, type AttemptIngots, type CookAttempt, type LoadedInput } from "./attempt-ingots.js";
import { openFurnaceWithProperties } from "./furnace-properties.js";
import {
  burningItems,
  furnaceObservation,
  midCookHarvest,
  recover,
  settleBurnReport,
  SLOT_RECOVERY_MS,
  waitForCook,
  type FurnaceObservation,
  type FurnaceWindow,
  type Recovery,
} from "./furnace-cook.js";
import {
  parseSmeltItemRequest,
  SMELT_ITEM,
  SMELT_ITEM_DESCRIPTION,
  smeltItemInputSchema,
  smeltItemResultSchema,
  smeltItemAnnotations,
  smeltItemOutcomes,
  type SmeltItemRequest,
  type SmeltItemResult,
  type SmeltEvidence,
} from "./contract.js";

const FURNACE_REACH = 4.5;

type FurnaceBlock = NonNullable<ReturnType<Bot["blockAt"]>>;

export interface SmeltItemDependencies {
  readonly createMovements: typeof createMovements;
  readonly navigate: Navigate;
  readonly openFurnace: (bot: Bot, block: FurnaceBlock) => Promise<FurnaceWindow>;
  readonly now: () => number;
  readonly pause: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function abortablePause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const aborted = () => done(signal?.reason ?? new Error("Smelting was cancelled."));
    function done(cause?: unknown) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (cause !== undefined) reject(cause);
      else resolve();
    }
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
  });
}

function productionDependencies(navigate: Navigate): SmeltItemDependencies {
  return {
    createMovements,
    navigate,
    openFurnace: openFurnaceWithProperties,
    now: () => performance.now(),
    pause: abortablePause,
  };
}

function evidence(
  bot: Bot,
  request: SmeltItemRequest,
  before: { readonly input: number; readonly fuel: number },
  observed: {
    readonly fuelInserted?: number;
    readonly outputItem?: string | null;
    readonly produced?: number;
    readonly rawRecovered?: number;
    readonly fuelRecovered?: number;
    readonly finalCookProgress?: number | null;
    readonly finalFuelProgress?: number | null;
    /** The settled input count, once the furnace has given back what it did not burn. */
    readonly inputAfter?: number;
  } = {},
): SmeltEvidence {
  return {
    dimension: bot.game.dimension,
    furnace: request.temporaryWorkstation === true ? null : { x: request.x, y: request.y, z: request.z },
    inputItem: request.itemName,
    fuelItem: request.fuelItemName,
    requested: request.count,
    fuelInserted: observed.fuelInserted ?? 0,
    outputItem: observed.outputItem ?? null,
    produced: observed.produced ?? 0,
    inputInventoryBefore: before.input,
    inputInventoryAfter: observed.inputAfter ?? carriedCount(bot, request.itemName),
    fuelInventoryBefore: before.fuel,
    fuelInventoryAfter: carriedCount(bot, request.fuelItemName),
    rawRecovered: observed.rawRecovered ?? 0,
    fuelRecovered: observed.fuelRecovered ?? 0,
    finalCookProgress: observed.finalCookProgress ?? null,
    finalFuelProgress: observed.finalFuelProgress ?? null,
  };
}

async function approach(
  bot: Bot,
  request: ExistingFurnaceRequest,
  context: ActionContext,
  dependencies: SmeltItemDependencies,
): Promise<string | null> {
  const target = new Vec3(request.x, request.y, request.z);
  if (bot.entity.position.distanceTo(target) <= FURNACE_REACH) return null;
  const route = await dependencies.navigate({
    movements: dependencies.createMovements(bot),
    goal: nearGoal(target, 2),
    signal: context.signal,
  });
  return bot.entity.position.distanceTo(target) <= FURNACE_REACH ? null : describeNavigation(route);
}

/** What one smelt request has done so far, kept across the attempts a reflex splits it into. */
interface SmeltProgress {
  /** Carried counts when the request began: the evidence and the final input check compare against these. */
  readonly before: { readonly input: number; readonly fuel: number };
  produced: number;
  outputItem: string | null;
  /** Summed over attempts (the unburnt part of an attempt's fuel comes back with that attempt's recovery). */
  fuelInserted: number;
  /** What the latest attempt took back out of the furnace. */
  rawRecovered: number;
  fuelRecovered: number;
  /** The furnace cell an attempt loaded: what it still holds there, of our items, is this request's own. */
  loadedAt: string | null;
  ownsSlots: boolean;
  /** Whether ingots still in the furnace's output slot are already in `produced` (`AttemptIngots.outputLeftCounted`). */
  outputLeftCounted: boolean;
  current: FurnaceObservation;
  stalledForMs: number;
}

function newSmeltProgress(bot: Bot, request: SmeltItemRequest): SmeltProgress {
  return {
    before: { input: carriedCount(bot, request.itemName), fuel: carriedCount(bot, request.fuelItemName) },
    produced: 0,
    outputItem: null,
    fuelInserted: 0,
    rawRecovered: 0,
    fuelRecovered: 0,
    loadedAt: null,
    ownsSlots: false,
    outputLeftCounted: false,
    current: { output: 0, input: 0, fuelItems: 0, cookProgress: null, fuelProgress: null },
    stalledForMs: 0,
  };
}

function progressEvidence(bot: Bot, request: SmeltItemRequest, progress: SmeltProgress): SmeltEvidence {
  return evidence(bot, request, progress.before, {
    fuelInserted: progress.fuelInserted,
    outputItem: progress.outputItem,
    produced: progress.produced,
    rawRecovered: progress.rawRecovered,
    fuelRecovered: progress.fuelRecovered,
    finalCookProgress: progress.current.cookProgress,
    finalFuelProgress: progress.current.fuelProgress,
  });
}

/** An early stop of an attempt: a request that already produced something ends partial, not failed. */
function stoppedAttempt(bot: Bot, request: SmeltItemRequest, progress: SmeltProgress, error: string): SmeltItemResult {
  return { status: progress.produced > 0 ? "partial" : "failed", error, smelt: progressEvidence(bot, request, progress) };
}

function smeltRequestEvidence(request: SmeltItemRequest, progress: SmeltProgress): RequestEvidence {
  const { current } = progress;
  return {
    baseline: { ...progress.before },
    checkpoint: {
      phase: progress.ownsSlots ? "smelting_or_collecting" : "loading_furnace",
      requested: request.count,
      produced: progress.produced,
      outputItem: progress.outputItem,
      furnaceOutput: current.output,
      fuelInserted: progress.fuelInserted,
      furnaceInput: current.input,
      furnaceFuel: current.fuelItems,
      cookProgress: current.cookProgress,
      fuelProgress: current.fuelProgress,
      stalledForMs: progress.stalledForMs,
    },
    completion: {
      kind: "event",
      observed: progress.produced >= request.count,
      owes: "Requested cooked output retrieved with confirmed furnace cleanup.",
    },
  };
}

type RegistryItem = NonNullable<Bot["registry"]["itemsByName"][string]>;

type Supplies =
  | {
      readonly kind: "ready";
      readonly input: RegistryItem;
      readonly fuel: RegistryItem;
      /** Input still to smelt: the request's count less what earlier attempts produced. */
      readonly remaining: number;
      readonly requiredFuel: number;
    }
  | { readonly kind: "refused"; readonly result: SmeltItemResult };

/** The ticks the furnace takes per item of `input`: the recipe's, else the ordinary smelting time (a version with no shipped recipes). */
function cookTicksFor(bot: Pick<Bot, "version">, input: string): number {
  return cookingTicksOf(input, bot.version) ?? STANDARD_COOK_TICKS;
}

/**
 * The registry items, the fuel capacity and the carried counts this attempt needs; a refusal names what is missing.
 * `burning` is how many items the fuel already lit in the furnace will still cook: it is not carried, but it is fuel.
 */
function checkSupplies(bot: Bot, request: SmeltItemRequest, progress: SmeltProgress, burning = 0): Supplies {
  const refuse = (error: string): Supplies => ({ kind: "refused", result: stoppedAttempt(bot, request, progress, error) });
  const input = bot.registry.itemsByName[request.itemName];
  const fuel = bot.registry.itemsByName[request.fuelItemName];
  if (!input) return refuse(smeltItemOutcomes.unknownItem(request.itemName));
  if (!fuel) return refuse(smeltItemOutcomes.unknownItem(request.fuelItemName));
  const capacity = fuelCapacity(request.fuelItemName, bot.version, cookTicksFor(bot, request.itemName));
  if (capacity === 0) return refuse(smeltItemOutcomes.unsupportedFuel(request.fuelItemName));
  const remaining = request.count - progress.produced;
  const carriedInput = carriedCount(bot, request.itemName);
  if (carriedInput < remaining) return refuse(smeltItemOutcomes.inputMissing(request.itemName, carriedInput, remaining));
  const requiredFuel = Math.ceil(Math.max(0, remaining - burning) / capacity);
  const availableFuel = carriedCount(bot, request.fuelItemName) - (request.itemName === request.fuelItemName ? remaining : 0);
  if (availableFuel < requiredFuel)
    return refuse(smeltItemOutcomes.fuelMissing(request.fuelItemName, Math.max(0, availableFuel), requiredFuel));
  return { kind: "ready", input, fuel, remaining, requiredFuel };
}

type OpenedFurnace =
  | { readonly kind: "open"; readonly furnace: FurnaceWindow }
  | { readonly kind: "stopped"; readonly result: SmeltItemResult };

/** Walk into reach, check the cell holds a furnace and open it. */
async function openRequestedFurnace(
  bot: Bot,
  request: ExistingFurnaceRequest,
  progress: SmeltProgress,
  context: ActionContext,
  dependencies: SmeltItemDependencies,
): Promise<OpenedFurnace> {
  const stop = (error: string): OpenedFurnace => ({ kind: "stopped", result: stoppedAttempt(bot, request, progress, error) });
  let routeFailure: string | null;
  try {
    routeFailure = await approach(bot, request, context, dependencies);
  } catch (cause) {
    context.signal?.throwIfAborted();
    routeFailure = cause instanceof Error ? cause.message : String(cause);
  }
  if (routeFailure !== null) return stop(smeltItemOutcomes.routeStopped(routeFailure));
  const block = bot.blockAt(new Vec3(request.x, request.y, request.z));
  if (!block) return stop(smeltItemOutcomes.blockUnloaded);
  if (block.name !== SMELTING_STATION) return stop(smeltItemOutcomes.furnaceMissing(block.name));
  try {
    return { kind: "open", furnace: await dependencies.openFurnace(bot, block) };
  } catch (cause) {
    context.signal?.throwIfAborted();
    return stop(smeltItemOutcomes.openFailed(cause));
  }
}

function furnaceCellKey(request: ExistingFurnaceRequest): string {
  return `${request.x},${request.y},${request.z}`;
}

/**
 * Whether every slot the furnace holds is what an earlier attempt of this request left in it: the input and fuel we
 * loaded there, or the output we already know the name of. Anything else is a stranger's (a bot sharing the furnace).
 */
function holdsOnlyOurLeftovers(furnace: FurnaceWindow, request: ExistingFurnaceRequest, progress: SmeltProgress): boolean {
  if (progress.loadedAt !== furnaceCellKey(request)) return false;
  const input = furnace.inputItem();
  const fuel = furnace.fuelItem();
  const output = furnace.outputItem();
  return (
    (!input || input.name === request.itemName) &&
    (!fuel || fuel.name === request.fuelItemName) &&
    (!output || output.name === progress.outputItem)
  );
}

/** Empty the furnace of this request's own leftovers; the error is set when something else is in it, or the take failed. */
async function clearFurnaceForAttempt(
  bot: Bot,
  furnace: FurnaceWindow,
  request: ExistingFurnaceRequest,
  progress: SmeltProgress,
): Promise<string | null> {
  const occupied = [
    furnace.inputItem() && "input",
    furnace.fuelItem() && "fuel",
    furnace.outputItem() && "output",
  ].filter((slot): slot is string => Boolean(slot));
  if (occupied.length === 0) return null;
  if (!holdsOnlyOurLeftovers(furnace, request, progress)) return smeltItemOutcomes.occupied(occupied);
  const recovery = await recover(bot, furnace);
  if (recovery.output) {
    if (!progress.outputLeftCounted) progress.produced += recovery.output.count;
    progress.outputItem = recovery.output.name;
  }
  return recovery.errors.length > 0 ? smeltItemOutcomes.executionFailed(recovery.errors.join(" ")) : null;
}

/** Load this attempt's input and fuel, wait for the cook, and give back what the furnace still holds. */
async function loadAndCook(
  bot: Bot,
  furnace: FurnaceWindow,
  request: ExistingFurnaceRequest,
  supplies: Extract<Supplies, { kind: "ready" }>,
  progress: SmeltProgress,
  context: ActionContext,
  dependencies: SmeltItemDependencies,
): Promise<CookAttempt> {
  const harvest = midCookHarvest(bot, furnace, dependencies.now);
  let verdict: CookAttempt["verdict"] = "execution_failed";
  let executionError = "";
  let recovery: Recovery = { input: 0, fuel: 0, output: null, errors: [] };
  let loaded: LoadedInput | null = null;
  let inputLeft = 0;
  let recoveredAtAge: number | undefined;
  progress.ownsSlots = false;
  try {
    progress.loadedAt = furnaceCellKey(request);
    const carriedBefore = carriedCount(bot, request.itemName);
    await furnace.putInput(supplies.input.id, null, supplies.remaining);
    loaded = { carriedBefore, count: supplies.remaining };
    progress.ownsSlots = true;
    context.signal?.throwIfAborted();
    if (supplies.requiredFuel > 0) await furnace.putFuel(supplies.fuel.id, null, supplies.requiredFuel);
    progress.fuelInserted += supplies.requiredFuel;
    context.signal?.throwIfAborted();

    const waited = await waitForCook(furnace, supplies.remaining, dependencies, context.signal, (observation, idleMs) => {
      progress.current = observation;
      progress.stalledForMs = idleMs;
    }, harvest, cookTicksFor(bot, request.itemName));
    verdict = waited.verdict;
    progress.current = waited.observation;
  } catch (cause) {
    executionError = smeltItemOutcomes.executionFailed(cause);
  } finally {
    if (progress.ownsSlots) {
      recoveredAtAge = bot.time?.age;
      recovery = await recover(bot, furnace);
      inputLeft = furnace.inputItem()?.count ?? 0;
    }
    furnace.close();
  }
  return { verdict, executionError, recovery, harvest, loaded, inputLeft, recoveredAtAge };
}

/**
 * Count what the attempt cooked into the request's progress, before an abort can throw: a resume smelts only the rest.
 */
async function recordAttemptOutput(
  bot: Bot,
  request: SmeltItemRequest,
  progress: SmeltProgress,
  cook: CookAttempt,
): Promise<AttemptIngots> {
  progress.rawRecovered = cook.recovery.input;
  progress.fuelRecovered = cook.recovery.fuel;
  const ingots = await countAttemptIngots(bot, request, cook);
  progress.produced += ingots.produced;
  progress.outputLeftCounted = ingots.outputLeftCounted;
  if (ingots.outputItem) progress.outputItem = ingots.outputItem;
  return ingots;
}

/** The result of a settled attempt: the request's totals, and why it stopped when it did not finish. */
async function settleAttempt(
  bot: Bot,
  request: ExistingFurnaceRequest,
  progress: SmeltProgress,
  cook: CookAttempt,
  recorded: AttemptIngots,
  context: ActionContext,
): Promise<SmeltItemResult> {
  let { recovery } = cook;
  const { output } = recorded;
  if (output) {
    const outputAfter = await settleInventoryMinimum(
      bot,
      progress.outputItem!,
      output.inventoryBefore + output.taken,
      { timeoutMs: SLOT_RECOVERY_MS, signal: context.signal },
    );
    if (!outputAfter.confirmed) {
      recovery = {
        ...recovery,
        errors: [...recovery.errors, `Player inventory did not confirm furnace output ${progress.outputItem} x${output.taken} after close.`],
      };
    }
  }
  // The furnace's take operations resolve on that window's packets; the player
  // inventory that receives the leftovers is redrawn on a later broadcast. The
  // transaction's own invariant is that the input loses exactly what was
  // smelted, so that is the count worth waiting for, and the fuel count is
  // read once it has landed.
  // A failed recovery left an unknown part in the furnace: no count is worth waiting for.
  const inputAfter =
    recorded.inputAfter ??
    (cook.recovery.errors.length > 0
      ? settledNow(bot, request.itemName)
      : await settleInventoryCount(bot, request.itemName, progress.before.input - progress.produced, { signal: context.signal }));
  const observed = { ...progressEvidence(bot, request, progress), inputInventoryAfter: inputAfter.count };
  if (cook.verdict === "completed" && progress.produced >= request.count && recovery.errors.length === 0)
    return { status: "succeeded", smelt: observed };
  const { produced, rawRecovered, fuelRecovered, current } = progress;
  const recoveryError = recovery.errors.length > 0 ? ` Recovery: ${recovery.errors.join(" ")}` : "";
  const error = cook.verdict === "fuel_starved"
    ? smeltItemOutcomes.fuelStarved(produced, request.count, rawRecovered, fuelRecovered)
    : cook.verdict === "stalled"
      ? smeltItemOutcomes.stalled(produced, request.count, rawRecovered, fuelRecovered, current.cookProgress)
      : cook.verdict === "safety_timeout"
        ? smeltItemOutcomes.safetyTimeout(produced, request.count, rawRecovered, fuelRecovered, current.cookProgress)
        : cook.executionError || smeltItemOutcomes.executionFailed("Cook completed but furnace contents were not recovered.");
  return { status: produced > 0 ? "partial" : "failed", error: `${error}${recoveryError}`, smelt: observed };
}

/** One attempt at the request in one furnace: smelts what earlier attempts left, whatever stops it. */
async function smeltAttempt(
  bot: Bot,
  request: ExistingFurnaceRequest,
  progress: SmeltProgress,
  context: ActionContext,
  dependencies: SmeltItemDependencies,
): Promise<SmeltItemResult> {
  context.signal?.throwIfAborted();
  if (progress.produced >= request.count) return { status: "succeeded", smelt: progressEvidence(bot, request, progress) };
  // Input an earlier attempt left in the furnace only counts as carried once it is taken back (below).
  const early = progress.loadedAt === null ? checkSupplies(bot, request, progress) : null;
  if (early?.kind === "refused") return early.result;
  const opened = await openRequestedFurnace(bot, request, progress, context, dependencies);
  if (opened.kind === "stopped") return opened.result;
  const { furnace } = opened;
  progress.ownsSlots = false;
  const blocked = await clearFurnaceForAttempt(bot, furnace, request, progress);
  // A resumed attempt: the fuel it put in earlier may still be burning, and a window just opened has not said so yet.
  if (blocked === null && progress.fuelInserted > 0) await settleBurnReport(furnace, dependencies, context.signal);
  const supplies = blocked === null ? checkSupplies(bot, request, progress, burningItems(furnace, cookTicksFor(bot, request.itemName))) : null;
  if (blocked !== null || supplies?.kind !== "ready") {
    furnace.close();
    return supplies?.kind === "refused" ? supplies.result : stoppedAttempt(bot, request, progress, blocked!);
  }
  if (progress.produced >= request.count) {
    furnace.close();
    return { status: "succeeded", smelt: progressEvidence(bot, request, progress) };
  }
  progress.current = furnaceObservation(furnace);
  const cook = await loadAndCook(bot, furnace, request, supplies, progress, context, dependencies);
  const recorded = await recordAttemptOutput(bot, request, progress, cook);
  context.signal?.throwIfAborted();
  return settleAttempt(bot, request, progress, cook, recorded, context);
}

/**
 * Start a smelt request: take the baselines once and return the executor the runner calls for each attempt. A reflex
 * that takes the body mid-cook aborts an attempt; the next smelts only what is left, with the fuel for that.
 */
export function beginSmeltItem(
  bot: Bot,
  navigation: NavigationRuntime,
  request: SmeltItemRequest,
  dependencies: SmeltItemDependencies,
  observe: ObserveRequest,
  operations: WorkstationOperations = workstationOperations(bot, navigation),
): (context: ActionContext) => Promise<SmeltItemResult> {
  const progress = newSmeltProgress(bot, request);
  observe(() => smeltRequestEvidence(request, progress));
  if (request.temporaryWorkstation !== true) {
    return (context) => smeltAttempt(bot, request, progress, context, dependencies);
  }
  const hold = startOwnPlacement();
  const { itemName, count, fuelItemName } = request;
  return (context) =>
    useTemporaryWorkstation(
      bot,
      SMELTING_STATION,
      context,
      operations,
      (block) =>
        smeltAttempt(
          bot,
          { itemName, count, fuelItemName, x: block.position.x, y: block.position.y, z: block.position.z },
          progress,
          context,
          dependencies,
        ),
      (error) => stoppedAttempt(bot, request, progress, error),
      hold,
    );
}

/** Use one caller-selected empty furnace as a bounded, observed inventory transaction, in one attempt. */
export async function smeltItem(
  bot: Bot,
  navigation: NavigationRuntime,
  request: SmeltItemRequest,
  context: ActionContext,
  dependencies: SmeltItemDependencies,
): Promise<SmeltItemResult> {
  return beginSmeltItem(bot, navigation, request, dependencies, context.observeProgress ?? (() => {}))(context);
}

export function formatSmeltItemResult(result: SmeltItemResult): string {
  const { smelt } = result;
  const lines = [
    `Smelted **${smelt.produced}/${smelt.requested} ${smelt.inputItem}**${smelt.outputItem ? ` into **${smelt.outputItem}**` : ""}.`,
    ...formatWorkstation(result.workstation),
    `- Furnace: ${smelt.furnace ? `${smelt.furnace.x}, ${smelt.furnace.y}, ${smelt.furnace.z}` : "not placed"} in ${smelt.dimension}`,
    `- Fuel: ${smelt.fuelItem} x${smelt.fuelInserted}; inventory ${smelt.fuelInventoryBefore} → ${smelt.fuelInventoryAfter}`,
    `- Input inventory: ${smelt.inputInventoryBefore} → ${smelt.inputInventoryAfter}`,
    `- Recovered from furnace: raw x${smelt.rawRecovered}; fuel x${smelt.fuelRecovered}`,
    `- Final furnace state: cook ${smelt.finalCookProgress === null ? "unknown" : `${Math.round(smelt.finalCookProgress * 100)}%`}; fuel ${smelt.finalFuelProgress === null ? "unknown" : `${Math.round(smelt.finalFuelProgress * 100)}%`}`,
  ];
  if (result.status !== "succeeded") lines.push("", `**Observed stop:** ${result.error}`);
  return lines.join("\n");
}

export function createSmeltItemAction(
  bot: Bot,
  navigation: NavigationRuntime,
  dependencies: SmeltItemDependencies = productionDependencies(navigation.navigate),
) {
  return defineAction({
    checkpointSchema: smeltCheckpointSchema,
    name: SMELT_ITEM,
    description: SMELT_ITEM_DESCRIPTION,
    inputSchema: smeltItemInputSchema,
    resultSchema: smeltItemResultSchema,
    formatResult: formatSmeltItemResult,
    execution: { kind: "resumable_task", prepare: (signal) => prepareBotForMovement(bot, navigation, signal) },
    annotations: smeltItemAnnotations,
    parse: parseSmeltItemRequest,
    begin: (request, _lifetime, observe) => beginSmeltItem(bot, navigation, request, dependencies, observe),
  });
}

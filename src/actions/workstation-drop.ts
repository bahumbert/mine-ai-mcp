import type { Bot } from "mineflayer";
import { createMovements, type MovementPolicy, type NavigationRuntime } from "../navigation/index.js";
import { carriedCount } from "../world/inventory-count.js";
import { findNewItemEntity, pickupObservedItem } from "../world/item-pickup.js";
import type { ActionContext, ActionResult } from "./action.js";

/**
 * How long a broken workstation's drop gets to appear. Mining waits 250 ms for a spawn; a server 1500 s behind
 * (run 14b: 43 `WORKSTATION_NOT_RECOVERED` on 13 bots) delivers it seconds later, and by then the collect had ended.
 */
export const WORKSTATION_DROP_SPAWN_WAIT_MS = 20_000;
/** How long a seen drop gets to be walked onto and enter the inventory. */
export const WORKSTATION_DROP_PICKUP_MS = 15_000;
const DROP_SEARCH_RADIUS = 4;
const POLL_MS = 100;

/** Time and waiting, injectable so a test steps them by hand. */
export interface DropClock {
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const REAL_DROP_CLOCK: DropClock = {
  now: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      // The listener goes with the timer: a poll loop must not leave one on the action's signal per round.
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

/**
 * The workstation block is gone but its item is not in the inventory: wait for the drop to appear, walk onto it, and
 * say which step failed when it does not arrive.
 */
export async function recoverWorkstationDrop(
  bot: Bot,
  navigation: NavigationRuntime,
  name: "crafting_table" | "furnace",
  source: { readonly x: number; readonly y: number; readonly z: number },
  carriedBefore: number,
  context: ActionContext,
  options: { readonly clock?: DropClock; readonly movements?: MovementPolicy } = {},
): Promise<ActionResult> {
  const clock = options.clock ?? REAL_DROP_CLOCK;
  const recovered = (): boolean => carriedCount(bot, name) > carriedBefore;
  if (recovered()) return { status: "succeeded" };
  const waitStart = clock.now();
  // No baseline: only the drop of this block is a crafting_table/furnace item lying within reach of its cell.
  let found = findNewItemEntity(bot, { baseline: new Set(), itemName: name, source, maxDistance: DROP_SEARCH_RADIUS });
  while (!found && !recovered() && clock.now() - waitStart < WORKSTATION_DROP_SPAWN_WAIT_MS) {
    await clock.sleep(POLL_MS, context.signal);
    context.signal?.throwIfAborted();
    found = findNewItemEntity(bot, { baseline: new Set(), itemName: name, source, maxDistance: DROP_SEARCH_RADIUS });
  }
  if (recovered()) return { status: "succeeded" };
  if (!found) {
    return {
      status: "failed",
      error: `the dropped ${name} never appeared within ${Math.round(WORKSTATION_DROP_SPAWN_WAIT_MS / 1000)} s of breaking it (drop spawn wait)`,
    };
  }
  const entityId = found.id;
  const result = await pickupObservedItem(bot, {
    entityId,
    navigate: (options) => navigation.navigate(options),
    movements: options.movements ?? createMovements(bot),
    hasArrived: recovered,
    signal: context.signal,
    timeoutMs: WORKSTATION_DROP_PICKUP_MS,
  });
  if (result.kind === "collected" || recovered()) return { status: "succeeded" };
  const reason =
    result.kind === "inventory_full"
      ? result.reason
      : result.kind === "item_gone"
        ? "it vanished before entering the inventory"
        : "the walk onto it did not reach it";
  return { status: "failed", error: `the dropped ${name} was seen but not picked up: ${reason} (drop pickup walk)` };
}

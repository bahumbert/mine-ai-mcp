// The watch that stops a step showing no sign of life or gaining nothing (moved out of agent.ts, behaviour unchanged).
import { targetItems, type Step } from "./actions.ts";
import type { BotRuntime, BotSnapshot } from "./runtime-client.ts";

/** A step out to obtain items is stopped when none of them increased in the inventory for this long (owner, 2026-10-10), looked at every {@link GAIN_SAMPLE_MS}. */
export const NO_GAIN_MINUTES = 5;
/** A fetch travelling to a known source that gets this much nearer counts as progress for the no-gain stop (owner, 2026-10-11). */
const NEARER_BLOCKS = 16;
export const GAIN_SAMPLE_MS = 30_000;

/** The no-gain watch of a running step (see {@link watchGain}). */
export interface GainWatch {
  readonly stop: () => void;
  readonly stalled: () => string | null;
  readonly heading: (target: { readonly x: number; readonly z: number } | null) => void;
  readonly alive: () => void;
}

/** What the watch needs of its agent: the runtime it reads the inventory from, where it logs, and its limits. */
export interface GainWatchDeps {
  readonly runtime: BotRuntime;
  readonly log: (line: string) => void;
  readonly minutes: number;
  readonly sampleMs: number;
}

/**
 * A step is aborted when it shows no result and no progress for {@link NO_GAIN_MINUTES} minutes (live 2026-10-09:
 * single steps ran 10-22 minutes, a squid hunt gained nothing for 30; run 14: a step with no item target waited for
 * ever). A step out to obtain items (see `targetItems`) progresses when an item rises in the inventory or a fetch
 * gets nearer to the place it travels to; any other step, on any sign of life: an action ending, a phase or a
 * progress fact from the skill, a changed inventory, or the bot moving. The deadline is checked on every tick by the
 * monotonic clock (a wall clock that steps, as WSL's does after the host wakes, would cut the window: review V3),
 * whether or not the inventory read answers. `view_status` only reads, so the inventory is looked at while
 * the action runs. `stalled` says why it was stopped.
 */
export function watchGain(step: Step, before: BotSnapshot, controller: AbortController, { runtime, log, minutes, sampleMs }: GainWatchDeps): GainWatch {
  const targets = targetItems(step);
  const carried = (snapshot: BotSnapshot, item: string) => snapshot.inventory.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);
  const totals = (snapshot: BotSnapshot) => {
    const counts = new Map<string, number>();
    for (const stack of snapshot.inventory) counts.set(stack.name, (counts.get(stack.name) ?? 0) + stack.count);
    return counts;
  };
  const start = new Map(targets.map(({ item }) => [item, carried(before, item)]));
  // Any item rising above its best counts, not only the targets: a chain still gathering the logs for the planks for
  // the stairs is progressing (live 2026-10-10 run 8: "get 48 dark_oak_stairs" was stopped with 20 logs gathered).
  const best = totals(before);
  let lastGainAt = performance.now();
  let stalled: string | null = null;
  let sampling = false;
  let latest = before;
  // A fetch walking or sailing to a place it saw the block gains no item on the way: getting nearer is progress.
  let target: { readonly x: number; readonly z: number } | null = null;
  let nearest: number | null = null;
  // Any other step: the inventory as last seen and the place last counted as moved from.
  const signature = (snapshot: BotSnapshot) => JSON.stringify([...totals(snapshot)].sort());
  let seen = signature(before);
  let anchor = before.position;
  const stall = () => {
    if (stalled !== null || performance.now() - lastGainAt < minutes * 60_000) return;
    stalled = targets.length === 0
      ? `the action gave no sign of life for ${minutes} minutes`
      : `nothing gained in ${minutes} minutes: ${targets.map(({ item, count }) => `${Math.max(0, carried(latest, item) - (start.get(item) ?? 0))} of ${count} ${item}`).join(", ")} so far (the rest is in your inventory)`;
    controller.abort(new Error(stalled));
  };
  const timer = setInterval(() => {
    stall();
    if (sampling || stalled !== null) return;
    sampling = true;
    runtime.status().then((snapshot) => {
      const now = performance.now();
      latest = snapshot;
      for (const [item, have] of totals(snapshot)) {
        if (have > (best.get(item) ?? 0)) {
          best.set(item, have);
          lastGainAt = now;
        }
      }
      if (target !== null) {
        const away = Math.hypot(snapshot.position.x - target.x, snapshot.position.z - target.z);
        if (nearest === null) nearest = away;
        else if (away <= nearest - NEARER_BLOCKS) {
          nearest = away;
          lastGainAt = now;
        }
      }
      if (targets.length === 0) {
        const inventory = signature(snapshot);
        if (inventory !== seen || Math.hypot(snapshot.position.x - anchor.x, snapshot.position.y - anchor.y, snapshot.position.z - anchor.z) >= NEARER_BLOCKS) {
          seen = inventory;
          anchor = snapshot.position;
          lastGainAt = now;
        }
      }
      stall();
    }).catch((error: unknown) => log(`could not look at the inventory during a step: ${String(error)}`)).finally(() => { sampling = false; });
  }, sampleMs);
  return {
    stop: () => clearInterval(timer),
    stalled: () => stalled,
    heading: (next) => {
      target = next;
      nearest = null;
    },
    // A sign of life from the skill itself; a step out for items answers to its inventory and its way only.
    alive: () => {
      if (targets.length === 0) lastGainAt = performance.now();
    },
  };
}

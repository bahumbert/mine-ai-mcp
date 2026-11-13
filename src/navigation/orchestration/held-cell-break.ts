/**
 * Breaking the one block that holds the body where it stands, and waiting for the world to show the body free.
 *
 * Two escapes share it: the release of an overhead pin (`NavigationRun.#releaseOverheadPin`) and the dig-out of a partial
 * cell (`partial-cell-dig-out.ts`). The guards are the same for both: the cell is loaded, the policy may dig and the
 * block is safe to break, the policy prices the dig (protected regions refuse it) as exactly one dig (a falling column is
 * refused), and the break is confirmed in the world. What each escape counts, says and tries again stays with it.
 */
import { executeWorldEffect } from "../execution/world-effect.js";
import type { AttemptToken } from "../execution/mutations.js";
import { priceExcavation } from "../movements/excavation.js";
import { airMatcher, stateMatcher } from "../movements/movement.js";
import type { MovementPolicy } from "../movements/policy.js";
import { monotonicNow } from "../../utils/monotonic-clock.js";
import { markPhase } from "../../diagnostics/freeze-watch.js";
import type { BlockPosition } from "../world/world.js";
import type { RunContext } from "./navigation-run.js";

/** How long a break to free a held body may take: a hand on a leaf is instant, a hand on stone is not. */
const HELD_CELL_DEADLINE_MS = 15_000;
/** Ticks to wait for the world to show the body free once the break has completed. */
const SETTLE_TICKS = 40;
/** A real-time bound on the wait: the physics ticks stop when the server does. */
const TICK_MS = 50;

/**
 * What the break came to. `clause` reads after the cell ("which is not safe to break"), `sentence` stands alone (what
 * the world effect reported), `pricing` is the policy's own sentence for a cell it will not let this run dig.
 */
export type HeldCellBreak =
  | "confirmed"
  | "stopped"
  | { readonly refused: string; readonly kind: "clause" | "sentence" | "pricing" };

const clause = (refused: string): HeldCellBreak => ({ refused, kind: "clause" });

/**
 * Break `cell`. `admit` is asked once the cheap guards pass and before the cell is priced: it returns the attempt token
 * the break is made under, or the clause that refuses another attempt (the pin's limit). "stopped": the run's signal
 * fired during the break.
 */
export async function breakHeldCell(options: {
  readonly context: RunContext;
  readonly policy: MovementPolicy;
  readonly cell: BlockPosition;
  readonly admit: () => AttemptToken | string;
}): Promise<HeldCellBreak> {
  const { context, policy, cell } = options;
  const { bot, world, signal } = context;
  const block = world.blockAt(cell.x, cell.y, cell.z);
  if (block.kind !== "loaded") return clause("which is not loaded");
  if (!policy.allowDigging) return clause("which this route may not dig");
  if (!block.traits.safeToBreak) return clause("which is not safe to break");
  const token = options.admit();
  if (typeof token === "string") return clause(token);
  const observation = bot.observe();
  const excavation = priceExcavation({
    world, policy, position: cell,
    digContext: {
      submergedAtEyes: observation.stance === "swimming",
      onGround: observation.stance === "supported",
      aquaAffinity: observation.player.aquaAffinity,
      effects: observation.player.effects,
    },
  });
  if (excavation.kind === "unavailable") return { refused: excavation.reason, kind: "pricing" };
  // A collapsing column needs its own reachable excavation. Do not release a cell into falling blocks while the body
  // has nowhere to move.
  if (excavation.digs.length !== 1) return clause("which supports a falling column");
  const dig = excavation.digs[0]!;
  bot.clearOwnedControls();
  const { result } = await executeWorldEffect({
    ...context,
    token,
    operation: { kind: "break", position: cell, expectedStateId: dig.stateId, toolType: dig.toolType, brings: [] },
    targets: [{ position: cell, before: stateMatcher(dig.stateId), after: airMatcher }],
    deadlineMs: monotonicNow() + Math.max(HELD_CELL_DEADLINE_MS, dig.expectedTicks * 100),
  });
  if (signal.aborted) return "stopped";
  if (result.kind === "confirmed") return "confirmed";
  return result.kind === "effect_failed"
    ? { refused: result.observation, kind: "sentence" }
    : clause(`whose break was ${result.kind}`);
}

/**
 * Whether `clear` holds within SETTLE_TICKS physics ticks (or the real-time bound), true as soon as it does. False when
 * it never did or the run was aborted; the caller reads the signal to tell them apart. Listeners and timer are released
 * on every path.
 */
export function awaitBodyClear(context: Pick<RunContext, "bot" | "signal">, clear: () => boolean): Promise<boolean> {
  const { bot, signal } = context;
  if (clear()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const resources = new DisposableStack();
    const finish = () => {
      resources.dispose();
      resolve(!signal.aborted && clear());
    };
    let ticks = 0;
    resources.defer(bot.subscribePhysicsTick(() => {
      markPhase("physicsTick: held cell release");
      if (clear() || ++ticks >= SETTLE_TICKS) finish();
    }));
    signal.addEventListener("abort", finish, { once: true });
    resources.defer(() => signal.removeEventListener("abort", finish));
    const timer = setTimeout(finish, SETTLE_TICKS * TICK_MS);
    resources.defer(() => clearTimeout(timer));
    if (signal.aborted) finish();
  });
}

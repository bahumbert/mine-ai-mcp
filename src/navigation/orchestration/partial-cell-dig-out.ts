/**
 * The way out of a partial cell with no free side: break the blocks that hold the body there.
 *
 * A bot standing inside a bamboo stalk's cell with stalks or leaves on every side never escapes by stepping out
 * (`partialCellExit`), and search never plans from a partial cell. A run whose policy allows digging breaks the feet
 * cell, then the head cell if its box still stands beside the body, and plans from where it stands (live 2026-11-10,
 * Ayla, 90 minutes at 344,83,298). Each break is the guarded one the overhead-pin release makes (`held-cell-break.ts`).
 */
import type { MovementPolicy } from "../movements/policy.js";
import { partialCellBlockers, partialCellExit } from "../world/body-clearance.js";
import { blockLabel, samePosition, type BlockPosition, type Position3 } from "../world/world.js";
import { awaitBodyClear, breakHeldCell, type HeldCellBreak } from "./held-cell-break.js";
import type { RunContext } from "./navigation-run.js";
import type { NavigationFailure, NavigationOutcome, NavigationStatus } from "./outcome.js";

/** The stepId the dig-out's breaks and its failure carry. */
const STEP_ID = "leave_partial_cell";

export type PartialCellDigOut =
  /** The cells that held the body are broken (or no longer hold it): observe again. */
  | "left"
  /** The run's signal fired. */
  | "stopped"
  /** Why the body is still held, as one sentence for the failure's observation. */
  | { readonly refused: string };

async function digOutOfPartialCell(options: {
  readonly context: RunContext;
  readonly policy: MovementPolicy;
  /**
   * Open the bot's own protected regions to this run when `cell` lies in one and they are not open yet (once per run,
   * as the search's own-region escape does); true when it did, so the cell is priced again.
   */
  readonly openOwnRegions: (cell: BlockPosition) => boolean;
  /** Called after each confirmed break, for the run's counters. */
  readonly onBreak: () => void;
}): Promise<PartialCellDigOut> {
  const { context, policy, openOwnRegions, onBreak } = options;
  const { bot, world, signal } = context;
  const holding = () => partialCellBlockers(world, bot.observe().position);
  const cells = holding();
  let attempts = 0;
  const admit = () => ({ runId: context.runId, planId: STEP_ID, stepId: STEP_ID, attempt: (attempts += 1) });
  const breakCell = async (cell: BlockPosition): Promise<HeldCellBreak> => {
    const broken = await breakHeldCell({ context, policy, cell, admit });
    return typeof broken === "object" && broken.kind === "pricing" && openOwnRegions(cell)
      ? breakHeldCell({ context, policy, cell, admit })
      : broken;
  };
  for (const [index, cell] of cells.entries()) {
    // The feet break may have taken the stalk above with it: a box no longer beside the body is left alone.
    if (index > 0 && !holding().some((held) => samePosition(held, cell))) continue;
    const broken = await breakCell(cell);
    if (broken === "stopped") return "stopped";
    if (broken !== "confirmed") return { refused: describeRefusal(cell, broken) };
    onBreak();
    const rest = cells.slice(index + 1);
    if (rest.length === 0) continue;
    await awaitBodyClear(context, () => !holding().some((held) => rest.some((later) => samePosition(held, later))));
    if (signal.aborted) return "stopped";
  }
  return "left";
}

function describeRefusal(cell: BlockPosition, refusal: Exclude<HeldCellBreak, "confirmed" | "stopped">): string {
  return refusal.kind === "clause" ? `${blockLabel(cell)}, ${refusal.refused}.` : refusal.refused;
}

/** Whether the run already stepped out of a partial cell, and already dug out of one: the run's budgets. */
export interface PartialCellState {
  leftPartialCell: boolean;
  partialCellDug: boolean;
}

/** What leaving a partial cell reads from its run: the live state, the policy and the run's outcomes and counters. */
export interface PartialCellRun {
  readonly context: RunContext;
  readonly policy: MovementPolicy;
  /** The run's one mutable object, read live. */
  readonly state: PartialCellState;
  readonly status: (status: NavigationStatus | null) => void;
  readonly openOwnRegions: (inside: BlockPosition) => boolean;
  readonly countBreak: () => void;
  readonly stopped: () => NavigationOutcome;
  readonly failed: (failure: NavigationFailure) => NavigationOutcome;
}

/**
 * Leave a blocked cell the body stands in beside a box (a bamboo stalk, which stands off centre): search never plans
 * from such a cell and the straight first step can cross the box. Step out to a free side when there is one; with none
 * (or the step out already spent) and a policy that allows digging, dig out. Each once per run, so a second partial
 * cell is a failure and never a loop. "left": observe again.
 */
export async function leavePartialCell(
  run: PartialCellRun,
  cell: BlockPosition,
  position: Position3,
): Promise<"left" | NavigationOutcome> {
  const { context, policy, state } = run;
  const exit = state.leftPartialCell ? null : partialCellExit(context.world, position);
  if (exit !== null) {
    state.leftPartialCell = true;
    run.status({ kind: "stabilizing", runId: context.runId, reason: "inside_partial_block" });
    const arrived = await context.bot.centerOnCell(exit, context.signal);
    if (context.signal.aborted) return run.stopped();
    if (arrived) return "left";
  }
  let digOutRefusal = "";
  if (policy.allowDigging && state.partialCellDug) {
    digOutRefusal = " Digging out: this run has already dug out of one partial block.";
  } else if (policy.allowDigging) {
    run.status({ kind: "stabilizing", runId: context.runId, reason: "inside_partial_block" });
    const dug = await digOutOfPartialCell({
      context,
      policy,
      openOwnRegions: run.openOwnRegions,
      // The budget is spent by the first break: a dig-out that found nothing left to break (the failed step out moved
      // the body clear) leaves it for a later partial cell, and cannot loop, since no break means no partial cell.
      onBreak: () => {
        state.partialCellDug = true;
        run.countBreak();
      },
    });
    if (dug === "stopped") return run.stopped();
    if (dug === "left") return "left";
    digOutRefusal = ` Digging out: ${dug.refused}`;
  }
  return run.failed({
    kind: "movement_failed",
    movement: {
      kind: "unstable",
      stepId: "leave_partial_cell",
      phase: "moving",
      observation: `Standing inside the partial block at ${cell.x},${cell.y},${cell.z} with no clear side to step out to.${digOutRefusal}`,
    },
  });
}

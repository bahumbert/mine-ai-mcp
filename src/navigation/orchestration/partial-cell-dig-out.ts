/**
 * The way out of a partial cell with no free side: break the blocks that hold the body there.
 *
 * A bot standing inside a bamboo stalk's cell with stalks or leaves on every side never escapes by stepping out
 * (`partialCellExit`), and search never plans from a partial cell. A run whose policy allows digging breaks the feet
 * cell, then the head cell if its box still stands beside the body, and plans from where it stands (live 2026-11-10,
 * Ayla, 90 minutes at 344,83,298). Each break is the guarded one the overhead-pin release makes (`held-cell-break.ts`).
 */
import type { MovementPolicy } from "../movements/policy.js";
import { partialCellBlockers } from "../world/body-clearance.js";
import { blockLabel, samePosition, type BlockPosition } from "../world/world.js";
import { awaitBodyClear, breakHeldCell, type HeldCellBreak } from "./held-cell-break.js";
import type { RunContext } from "./navigation-run.js";

/** The stepId the dig-out's breaks and its failure carry. */
const STEP_ID = "leave_partial_cell";

export type PartialCellDigOut =
  /** The cells that held the body are broken (or no longer hold it): observe again. */
  | "left"
  /** The run's signal fired. */
  | "stopped"
  /** Why the body is still held, as one sentence for the failure's observation. */
  | { readonly refused: string };

export async function digOutOfPartialCell(options: {
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

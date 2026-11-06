// Sending a planned house to the runtime part by part, shared by build and improve_house.
import type { MaterialCount } from "../building/blueprint.ts";
import type { HousePlan } from "../building/plan.ts";
import { ToolLosses } from "../building/tool-loss.ts";
import type { SkillContext, SkillResult } from "../skills.ts";
import { getItems } from "./get-items.ts";
import { auditSuffix, refusedCells, sameCell, type Cell } from "./structure-audit.ts";

/** What stops {@link buildParts} short, and what it tells the model. */
interface PartsOptions {
  /** Blocks a remade tool must not use up: the house's bill. */
  readonly reserved: readonly MaterialCount[];
  /** Told the part (batch index) to start again from when the work stops before the end, and the cells the runtime refused (none given: the stop was not a refusal). */
  readonly leave: (part: number, refused?: readonly Cell[]) => void;
  /** The cells refused when the house was last left: refused again, the house is given up. */
  readonly refusedBefore?: readonly Cell[];
  /** Ends the failure sentence: how the house is asked again. */
  readonly again: string;
  /** Forgets the unfinished house, when resuming it keeps meeting the same refused cell. */
  readonly abandon?: () => void;
}

/**
 * Sends a planned house to the runtime part by part, twice over: null when every part is built and checked, else the
 * result that ends the step. Shared by `build` and `improve_house`, which send the same cells (the second with other
 * blocks in some roles) and rely on `remove_wrong_blocks` to skip what is right and swap what is not.
 */
export async function buildParts(context: SkillContext, plan: HousePlan, what: string, options: PartsOptions): Promise<SkillResult | null> {
  // A resumed house is checked again from its first part: `build_structure` skips the cells already right, and anything
  // dug out since (the doorstep under the door, by the gathering next to it: live 2026-10-01) is put back. The second
  // pass is the final check: anything a later part disturbed is put back before the house counts as built.
  const parts = [...plan.batches, ...plan.batches];
  // Each cell is built with its final intent only: the doorway is listed as air in an early part and as the door in
  // the last one, and checking the parts again must not dig the hung door out (live 2026-10-02).
  const lastPart = new Map<string, number>();
  plan.batches.forEach((batch, part) => batch.forEach((cell) => {
    lastPart.set(`${cell.x},${cell.y},${cell.z}`, part);
    // A door fills the cell above its own too.
    if (cell.block.endsWith("_door")) lastPart.set(`${cell.x},${cell.y + 1},${cell.z}`, part);
  }));
  // A tool worn out mid-build is made again once per kind, and the part is built again (live 2026-10-09: Tom's house
  // stopped at part 1/9, "stone_pickaxe was lost").
  const toolLosses = new ToolLosses();
  for (let index = 0; index < parts.length; index += 1) {
    const partIndex = index % plan.batches.length;
    const blocks = (parts[index] ?? []).filter((cell) => lastPart.get(`${cell.x},${cell.y},${cell.z}`) === partIndex).map(({ x, y, z, block, facing, half, axis }) => ({
      x, y, z, block_name: block,
      ...(facing !== undefined && { facing }),
      ...(half !== undefined && { half }),
      ...(axis !== undefined && { axis }),
    }));
    if (blocks.length === 0) continue;
    const auditing = index >= plan.batches.length;
    const part = auditing ? `final check ${index - plan.batches.length + 1}/${plan.batches.length}` : `part ${index + 1}/${plan.batches.length}`;
    context.progress?.(auditing ? `checking every block of ${what} is right` : `building ${what}, ${part}`);
    // What earlier parts built stays: a route to this part may not dig through it (live 2026-10-01: 11 cells dug).
    const keep = auditing ? [] : builtBefore(plan.batches, index, lastPart);
    const input = { blocks, remove_wrong_blocks: true, ...(keep.length > 0 && { keep }) };
    const outcome = await context.body.act("build_structure", input, `Build ${what}, ${part}.`, { signal: context.signal });
    if (context.signal.aborted) {
      options.leave(Math.min(index, plan.batches.length - 1));
      return { status: "stopped" };
    }
    if (outcome.status !== "succeeded") {
      const lost = await toolLosses.handle(outcome.error, { reserved: options.reserved, inventory: async () => (await context.runtime.status()).inventory, getItems: (items, purpose) => getItems(context, items, purpose) });
      if (lost.status === "remade") {
        index -= 1;
        continue;
      }
      if (lost.status === "stopped" || context.signal.aborted) {
        options.leave(Math.min(index, plan.batches.length - 1));
        return { status: "stopped" };
      }
      const why = lost.status === "refused" || lost.status === "failed" ? `; ${lost.note}` : "";
      // A refusal is read from the audit's structured groups, not from the error text. One refusal may be transient
      // (an animal in the cell, a route that timed out): the house is kept with the refused cells; the same cell
      // refused again on a resume is the one that would be refused for good, so the site is given up.
      // A stop that is no refusal keeps the cells an earlier one named (refusal A, a tool failure, refusal A again is a repeat).
      const refused = refusedCells(outcome.result);
      options.leave(Math.min(index, plan.batches.length - 1), refused.length > 0 ? refused : undefined);
      const repeated = options.again !== "" && refused.some((cell) => options.refusedBefore?.some((before) => sameCell(before, cell)) === true);
      if (repeated) options.abandon?.();
      const again = repeated ? "; building here again would be refused at the same cell: build somewhere else, or clear that cell first" : options.again;
      return { status: "failed", detail: `${what} stopped at ${part}: ${outcome.error ?? outcome.status}${auditSuffix(outcome.error, outcome.result)}${why}${again}` };
    }
  }
  return null;
}

/** The non-air cells of the parts before `index`: what a later part's routes must keep. */
function builtBefore(batches: readonly (readonly { x: number; y: number; z: number; block: string }[])[], index: number, lastPart: ReadonlyMap<string, number>): { x: number; y: number; z: number }[] {
  const seen = new Set<string>();
  const cells: { x: number; y: number; z: number }[] = [];
  for (const cell of batches.slice(0, index).flat()) {
    const key = `${cell.x},${cell.y},${cell.z}`;
    // Only what stays as built: a cell a later part changes again (the doorway) is not kept.
    if (cell.block === "air" || seen.has(key) || (lastPart.get(key) ?? -1) >= index) continue;
    seen.add(key);
    cells.push({ x: cell.x, y: cell.y, z: cell.z });
  }
  return cells;
}

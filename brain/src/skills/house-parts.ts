// Sending a planned house to the runtime part by part, shared by build and improve_house.
import type { MaterialCount } from "../building/blueprint.ts";
import type { HousePlan } from "../building/plan.ts";
import { ToolLosses } from "../building/tool-loss.ts";
import type { ActOutcome } from "../body.ts";
import type { SkillContext, SkillResult } from "../skills.ts";
import type { ItemCount, Position } from "../runtime-client.ts";
import { NO_KEEP } from "../walk-keep.ts";
import { houseScaffoldReserveFrom } from "../walks.ts";
import { getItems } from "./get-items.ts";
import { auditSuffix, endedForWantOfRoute, refusedCells, sameCell, type Cell } from "./structure-audit.ts";

/** What stops {@link buildParts} short, and what it tells the model. */
interface PartsOptions {
  /** Blocks a remade tool must not use up: the house's bill. */
  readonly reserved: readonly MaterialCount[];
  /** Claim cells stay protected during construction and the final audit alike. */
  readonly keepAlways?: readonly Position[];
  /** Told the part (batch index) to start again from when the work stops before the end, and the cells the runtime refused (none given: the stop was not a refusal). */
  readonly leave: (part: number, refused?: readonly Cell[]) => void;
  /** The cells refused when the house was last left: refused again, the house is given up. */
  readonly refusedBefore?: readonly Cell[];
  /** Ends the failure sentence: how the house is asked again. */
  readonly again: string;
  /** Forgets the unfinished house, when resuming it keeps meeting the same refused cell. */
  readonly abandon?: () => void;
  /** The parts (batch indexes, inclusive) built in the first pass: a stage's (default: all of them; `to` below `from`: none). */
  readonly from?: number;
  readonly to?: number;
  /** Blocks the routes of the first pass may place only while more are carried (`build_structure`'s `reserve_items`: the scaffold a later stage stands on). A call that ends for want of a route is sent once more without it. */
  readonly reserve?: readonly { readonly item: string; readonly count: number }[];
  /** Whether the second pass over every part, the final check, follows (default: yes; a stage that is not the last one has none). */
  readonly audit?: boolean;
  /** The tools made again from carried items (none near to replace them) in the whole step: the step's caller adds them to its result (`remadeClause`). */
  readonly remadeNotes: { readonly item: string; readonly note: string }[];
}

/**
 * One part's `build_structure` call with `reserve` as `reserve_items` (the scaffold a later stage stands on). A call with a
 * reserve that ends for want of a route is sent once more without it: the stage goes on, and the next stage's check says what is short.
 */
async function sendPart(context: SkillContext, input: Record<string, unknown>, reserve: readonly ItemCount[], why: string): Promise<ActOutcome> {
  const act = (call: Record<string, unknown>) => context.body.act("build_structure", call, why, { signal: context.signal });
  if (reserve.length === 0) return act(input);
  const outcome = await act({ ...input, reserve_items: reserve });
  return outcome.status !== "succeeded" && !context.signal.aborted && endedForWantOfRoute(outcome.error, outcome.result) ? act(input) : outcome;
}

/**
 * Sends a planned house to the runtime part by part, twice over: null when every part is built and checked, else the
 * result that ends the step. Shared by `build` and `improve_house`, which send the same cells (the second with other
 * blocks in some roles) and rely on `remove_wrong_blocks` to skip what is right and swap what is not.
 */
export async function buildParts(context: SkillContext, plan: HousePlan, what: string, options: PartsOptions): Promise<SkillResult | null> {
  const conflict = await claimSupportConflict(context, plan, options.keepAlways ?? []);
  if (context.signal.aborted || conflict !== null) {
    options.leave(0);
    return context.signal.aborted ? { status: "stopped" } : { status: "failed", detail: `${what}: ${conflict}; keep the claim sign and its support; choose other parts to improve or resolve its support before resuming` };
  }
  // A resumed house is checked again from its first part: `build_structure` skips the cells already right, and anything
  // dug out since (the doorstep under the door, by the gathering next to it: live 2026-10-01) is put back. The second
  // pass is the final check: anything a later part disturbed is put back before the house counts as built.
  const parts = [...plan.batches, ...plan.batches];
  // The first pass builds the parts `from`..`to` (a stage's); the second, the final check of every part, runs unless `audit` is false.
  const inPasses = (index: number) => (index < plan.batches.length ? index >= (options.from ?? 0) && index <= (options.to ?? plan.batches.length - 1) : options.audit !== false);
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
  // A call that throws (`BodyDown`, a restart) records the part reached before it goes on up (run 17b: only returns did).
  const recordingThrows = async <T>(index: number, call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      options.leave(Math.min(index, plan.batches.length - 1));
      throw error;
    }
  };
  for (let index = 0; index < parts.length; index += 1) {
    const partIndex = index % plan.batches.length;
    if (!inPasses(index)) continue;
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
    const keep = [...(options.keepAlways ?? []), ...(auditing ? [] : builtBefore(plan.batches, index, lastPart))];
    const input = { blocks, remove_wrong_blocks: true, ...(keep.length > 0 && { keep }) };
    const outcome = await recordingThrows(index, () => sendPart(context, input, auditing ? [] : options.reserve ?? [], `Build ${what}, ${part}.`));
    if (context.signal.aborted) {
      options.leave(Math.min(index, plan.batches.length - 1));
      return { status: "stopped" };
    }
    if (outcome.status !== "succeeded") {
      const lost = await recordingThrows(index, () => toolLosses.handle(outcome.error, { reserved: options.reserved, ...(context.owed !== undefined && { owed: context.owed }), inventory: async () => (await context.runtime.status()).inventory, getItems: async (items, purpose) => getItems(context, items, { purpose, walkKeep: { ...NO_KEEP, scaffold: await houseScaffoldReserveFrom(context, plan, partIndex, options.reserved) }, means: true }) }));
      if (lost.status === "remade" && lost.note !== undefined) options.remadeNotes.push({ item: lost.item, note: lost.note });
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

/** The runtime cannot replace a kept support: refuse before it reports an impossible build as progress. */
async function claimSupportConflict(context: SkillContext, plan: HousePlan, keep: readonly Position[]): Promise<string | null> {
  const targets = plan.cells.filter((cell) => keep.some((kept) => sameCell(kept, cell)));
  if (targets.length === 0) return null;
  const observed = await context.runtime.cellsAt(targets);  const conflict = targets.find((target, index) => {
    const cell = observed[index];
    return cell?.loaded !== true || cell.name !== target.block;
  });
  if (conflict === undefined) return null;
  const cell = observed[targets.indexOf(conflict)];
  const why = cell?.loaded === true ? `would need replacement by ${conflict.block}` : "is not loaded; move closer to inspect it";
  return `the claim sign's support at ${conflict.x} ${conflict.y} ${conflict.z} ${why}`;
}

/** The non-air cells of the parts before `index`: what a later part's routes must keep. */
export function builtBefore(batches: readonly (readonly { x: number; y: number; z: number; block: string }[])[], index: number, lastPart: ReadonlyMap<string, number>): { x: number; y: number; z: number }[] {
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

// A house is built stage by stage: what a stage asks the bot to carry now, and what the step tells the model when it stops
// between two stages (spec 2026-11-09-house-templates section 4). Pure over a `HousePlan`, besides the one box read.
import { areaKey, BodyDown, type BotRuntime } from "../runtime-client.ts";
import { billOfMaterials, cellsCountedOnce, describeMaterials, type MaterialCount, type WorldCell } from "./blueprint.ts";
import type { HousePlan } from "./plan.ts";
import { resumeStep, type Stage, type Template } from "./templates.ts";

/** The step that goes on with a house of `template` (`resumeStep`'s, given the template's own id, whatever registry it is in). */
const buildAgain = (template: Template): string => resumeStep({ kind: template.kind, template: template.id });

/** The stage that holds call `part` (the last one when `part` is past the end). */
export function stageAt(plan: HousePlan, part: number): number {
  const found = plan.stages.findIndex((stage) => part <= stage.last);
  return found === -1 ? plan.stages.length - 1 : found;
}

/** The blocks still to place from call `first` on, each cell counted once: what the rest of the house takes. */
export function billFrom(plan: HousePlan, first: number): MaterialCount[] {
  return billOfMaterials(cellsCountedOnce(plan.batches).slice(first).flat());
}

/** The cells a stage places, counted in their last call only (as {@link HousePlan.stageBill} does), air left out. */
function stageCells(plan: HousePlan, stage: Stage): WorldCell[] {
  return cellsCountedOnce(plan.batches).slice(stage.first, stage.last + 1).flat().filter((cell) => cell.block !== "air");
}

/**
 * What a stage takes now. With `runtime`, the stage's box is read and the cells whose block is already right (a stage
 * a stop cut in the middle) are not billed; the read gives block names, not states, so a stair facing wrong counts as right
 * and `build_structure`'s audit still turns it. A read that fails bills the whole stage; a body that is down is not a failed read.
 */
export async function stageBillNow(plan: HousePlan, stage: Stage, runtime: Pick<BotRuntime, "blocksIn"> | null): Promise<MaterialCount[]> {
  if (runtime === null) return plan.stageBill(stage);
  const cells = stageCells(plan, stage);
  if (cells.length === 0) return [];
  const axis = (pick: (cell: WorldCell) => number) => [Math.min(...cells.map(pick)), Math.max(...cells.map(pick))] as const;
  const [[minX, maxX], [minY, maxY], [minZ, maxZ]] = [axis((cell) => cell.x), axis((cell) => cell.y), axis((cell) => cell.z)];
  try {
    const { blocks } = await runtime.blocksIn({ x: minX, y: minY, z: minZ }, { x: maxX, y: maxY, z: maxZ });
    return billOfMaterials(cells.filter((cell) => blocks.get(areaKey(cell.x, cell.y, cell.z)) !== cell.block));
  } catch (error) {
    if (error instanceof BodyDown) throw error;
    return plan.stageBill(stage);
  }
}

/** The phrase naming stage `index` ("the walls (stage 2)"). */
const stageName = (plan: HousePlan, index: number) => `the ${plan.stages[index]!.name} (stage ${index + 1})`;

/** The failure of a stage whose blocks are not carried and no stage was built by this step. */
export function missingForStage(plan: HousePlan, index: number, what: string, missing: readonly MaterialCount[], owedNote: string): string {
  return `missing ${describeMaterials(missing)} for stage ${index + 1} of ${plan.stages.length} (${plan.stages[index]!.name}) of ${what} (the rest is carried${owedNote === "" ? "" : `; ${owedNote}`}): fetch exactly the missing items with get_items, then ${buildAgain(plan.template)} again`;
}

/**
 * The result of a step that built stages `from`..`index - 1` (0-based) and stops before stage `index`, whose blocks are
 * not carried. It never starts with "built": the run analysis counts `done` + "built…" as a finished house.
 */
export function stagesBuilt(plan: HousePlan, from: number, index: number, missing: readonly MaterialCount[], owedNote: string): string {
  const { door } = plan.site;
  return `stages ${from + 1}-${index} of ${plan.stages.length} of the ${plan.template.kind} are built (door at ${door.x} ${door.y} ${door.z}): ${stageName(plan, index)} needs ${describeMaterials(missing)}${owedNote === "" ? "" : ` (${owedNote})`}: fetch exactly those with get_items, then ${buildAgain(plan.template)} again to go on`;
}

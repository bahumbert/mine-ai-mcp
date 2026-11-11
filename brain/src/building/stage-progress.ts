// A house is built stage by stage: what a stage asks the bot to carry now, and what the step tells the model when it stops
// between two stages (spec 2026-11-09-house-templates section 4). Pure over a `HousePlan`, besides the one box read.
import { areaKey, BodyDown, type BotRuntime } from "../runtime-client.ts";
import { billOfMaterials, cellsCountedOnce, describeMaterials, type MaterialCount, type WorldCell } from "./blueprint.ts";
import type { HousePlan } from "./plan.ts";
import { resumeStep, type Stage } from "./templates.ts";

/** The step that goes on with the house of `plan` at its door (`resumeStep`'s, given the template's own id, whatever registry it is in). */
export const buildAgain = (plan: HousePlan): string => resumeStep({ kind: plan.template.kind, template: plan.template.id, site: plan.site });

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
export function stageCells(plan: HousePlan, stage: Stage): WorldCell[] {
  return cellsCountedOnce(plan.batches).slice(stage.first, stage.last + 1).flat().filter((cell) => cell.block !== "air");
}

/**
 * The cells a stage still has to place. With `runtime`, the stage's box is read and the cells whose block is already right
 * (a stage a stop cut in the middle) are left out; the read gives block names, not states, so a stair facing wrong counts
 * as right and `build_structure`'s audit still turns it. A read that fails gives the whole stage; a body that is down is
 * not a failed read.
 */
export async function stageCellsNow(plan: HousePlan, stage: Stage, runtime: Pick<BotRuntime, "blocksIn"> | null): Promise<WorldCell[]> {
  const cells = stageCells(plan, stage);
  if (runtime === null || cells.length === 0) return cells;
  const axis = (pick: (cell: WorldCell) => number) => [Math.min(...cells.map(pick)), Math.max(...cells.map(pick))] as const;
  const [[minX, maxX], [minY, maxY], [minZ, maxZ]] = [axis((cell) => cell.x), axis((cell) => cell.y), axis((cell) => cell.z)];
  try {
    const { blocks } = await runtime.blocksIn({ x: minX, y: minY, z: minZ }, { x: maxX, y: maxY, z: maxZ });
    return cells.filter((cell) => blocks.get(areaKey(cell.x, cell.y, cell.z)) !== cell.block);
  } catch (error) {
    if (error instanceof BodyDown) throw error;
    return cells;
  }
}

/**
 * How far above the bot's feet a block is placed from where it stands: the runtime's `BUILD_REACH`
 * (`src/navigation/processes/building/build-process.ts:67`, used at `:258`). `brain/` does not import `src/`; the Mine Labs
 * scenario `template-roof-no-scaffold-*` (plan 2026-11-11-house-templates-live-fixes Task 5) measures it against the runtime.
 */
export const BUILD_REACH = 4;

/** Blocks to stand on that a stage lacks: the column the routes' scaffold needs for its cells out of reach of the ground. */
export interface ScaffoldNeed {
  /** About how many blocks the column takes (one more than the height the cells lack, for the route's own step). */
  readonly count: number;
  /** How far above the ground the highest cell is. */
  readonly height: number;
  /** The kinds the movement policy admits as scaffold, besides the house's own blocks. */
  readonly admitted: readonly string[];
}

/**
 * What a stage needs to stand on, from where the bot's feet are (`walkingY`, the site's level): the cells `BUILD_REACH` or
 * more above it are reached only by the routes' scaffold (live 2026-11-10: Bruno's roof passed the material check and
 * failed mid-stage, both his scaffold-able blocks spent on the foundation). Null when every cell is within reach, when
 * enough of a block the policy admits is carried, or when none could be used: `scaffoldBlocks` unread, or every admitted
 * kind one of `kept` (the house's own blocks, kept off the list while it is built): fetching one cannot help, and the
 * runtime's own refusal says why. `cells` are the cells still to place (a resumed stage's wrong ones).
 */
export function scaffoldNeed(cells: readonly WorldCell[], walkingY: number, inventory: readonly { readonly name: string; readonly count: number }[], scaffoldBlocks: readonly string[] | undefined, kept: readonly string[]): ScaffoldNeed | null {
  // A cell dug clear places nothing: only the blocks of the bill (`billOfMaterials` leaves the air out) are placed from a height.
  const placed = new Set(billOfMaterials(cells).map(({ item }) => item));
  const high = cells.filter((cell) => placed.has(cell.block) && cell.y - walkingY >= BUILD_REACH);
  if (high.length === 0 || scaffoldBlocks === undefined) return null;
  const admitted = scaffoldBlocks.filter((block) => !kept.includes(block));
  if (admitted.length === 0) return null;
  const height = Math.max(...high.map((cell) => cell.y)) - walkingY;
  const count = height - BUILD_REACH + 2;
  const carried = inventory.filter((stack) => admitted.includes(stack.name)).reduce((sum, stack) => sum + stack.count, 0);
  return carried >= count ? null : { count, height, admitted };
}

/** What a stage lacks to be built now: items not carried, and blocks to stand on. */
export interface StageShortfall {
  readonly missing: readonly MaterialCount[];
  /** Said after the missing items: what a trade owes of what is carried. */
  readonly owedNote: string;
  readonly scaffold: ScaffoldNeed | null;
}

/** The words of a shortfall that are not items ("about 3 blocks to stand on for ..."): a result holding them lacks what an inventory list cannot show. */
export const STAND_ON_WORDS = "blocks to stand on";

/** "7 spruce_slab and about 3 blocks to stand on for its cells 5 above the ground (...)": what is lacking, as the model reads it. */
export function describeShortfall({ missing, scaffold }: Pick<StageShortfall, "missing" | "scaffold">): string {
  const standOn = scaffold === null ? "" : `about ${scaffold.count} ${STAND_ON_WORDS} for its cells ${scaffold.height} above the ground (scaffold the build lays and takes back: one of ${scaffold.admitted.join(", ")})`;
  return [describeMaterials(missing), standOn].filter((part) => part !== "").join(" and ");
}

/** The phrase naming stage `index` ("the walls (stage 2)"). */
const stageName = (plan: HousePlan, index: number) => `the ${plan.stages[index]!.name} (stage ${index + 1})`;

/** The other ways out of a stop besides fetching: another house, which a resumed house's record the model gives up first. */
const OTHER_HOUSE = '; or choose another house ({"skill":"abandon_house"} gives this one up)';
/** A new house's first stage may be built from other blocks the model carries (`build` ignores a step's `materials` on a resumed house). */
const OTHER_BLOCKS = '; or build that stage from blocks you carry with "materials", or choose another house';

/**
 * The failure of a stage whose blocks are not carried and no stage was built by this step. `fresh`: the first stage of a
 * house not yet started, the only stop where the step's `materials` still count (and then only for items: other blocks do
 * not remove a need to stand on). `newSite`, when it is not empty, is the
 * note of an unfinished house this refusal would leave untracked: it goes before the step to fetch and go on, so the old
 * house's step is read first (the model follows the first step it reads) and never inside the list `nowCarried` parses.
 */
export function missingForStage(plan: HousePlan, index: number, what: string, shortfall: StageShortfall, how: { readonly fresh: boolean; readonly newSite?: string }): string {
  const { owedNote } = shortfall;
  return `missing ${describeShortfall(shortfall)} for stage ${index + 1} of ${plan.stages.length} (${plan.stages[index]!.name}) of ${what} (the rest is carried${owedNote === "" ? "" : `; ${owedNote}`})${how.newSite ?? ""}: fetch exactly the missing items with get_items, then ${buildAgain(plan)} again${how.fresh && shortfall.scaffold === null ? OTHER_BLOCKS : OTHER_HOUSE}`;
}

/**
 * The result of a step that built stages `from`..`index - 1` (0-based) and stops before stage `index`, whose blocks are
 * not carried. It never starts with "built": the run analysis counts `done` + "built…" as a finished house.
 */
export function stagesBuilt(plan: HousePlan, from: number, index: number, shortfall: StageShortfall): string {
  const { door } = plan.site;
  const { owedNote } = shortfall;
  return `stages ${from + 1}-${index} of ${plan.stages.length} of the ${plan.template.kind} are built (door at ${door.x} ${door.y} ${door.z}): ${stageName(plan, index)} needs ${describeShortfall(shortfall)}${owedNote === "" ? "" : ` (${owedNote})`}: fetch exactly those with get_items, then ${buildAgain(plan)} again to go on${OTHER_HOUSE}`;
}

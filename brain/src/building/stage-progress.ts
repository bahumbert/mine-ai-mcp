// A house is built stage by stage: what a stage asks the bot to carry now, and what the step tells the model when it stops
// between two stages (spec 2026-11-09-house-templates section 4). Pure over a `HousePlan`, besides the one box read.
import { areaKey, BodyDown, type BotRuntime, type ItemCount } from "../runtime-client.ts";
import { billOfMaterials, cellsCountedOnce, describeMaterials, type MaterialCount, type WorldCell } from "./blueprint.ts";
import type { HousePlan } from "./plan.ts";
import { columnsForCells, outOfReachFromGround } from "./stand-columns.ts";
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
export function stageCells(plan: HousePlan, stage: Pick<Stage, "first" | "last">): WorldCell[] {
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

/** One `build_structure` call's work: the cells it still places and the cells standing around them, which its stand columns cannot pass through. */
export interface CallWork {
  /** The cells the call still places. */
  readonly cells: readonly WorldCell[];
  /** The cells of the house standing when the call runs, air left out: those of the calls before, and the house's own already right (a resumed or swapped house). The terrain is not known here. */
  readonly built: readonly WorldCell[];
}

const cellKey = (cell: WorldCell): string => `${cell.x},${cell.y},${cell.z}`;

/**
 * The calls of parts `range` that still place `wrong` cells (each cell in its last call, as `buildParts` sends it), the way the
 * runtime plans each: the calls before are built, the cells not in `wrong` stand (a resumed stage's right cells, the unchanged
 * cells of a house swapped in place), and the cells of the calls after are not yet there (plan 2026-11-14-house-build-fixes-2
 * Task 2d; the runtime's `keep` is every non-air cell of the earlier calls). From the house's own plan: no world read.
 */
export function callWorks(plan: HousePlan, range: { readonly first: number; readonly last: number }, wrong: readonly WorldCell[]): CallWork[] {
  const stillWrong = new Set(wrong.map(cellKey));
  const works: CallWork[] = [];
  for (let part = range.first; part <= range.last && part < plan.batches.length; part += 1) {
    const cells = stageCells(plan, { first: part, last: part }).filter((cell) => stillWrong.has(cellKey(cell)));
    if (cells.length === 0) continue;
    const standing = stageCells(plan, { first: part, last: range.last }).filter((cell) => !stillWrong.has(cellKey(cell)));
    works.push({ cells, built: [...stageCells(plan, { first: 0, last: part - 1 }), ...standing] });
  }
  return works;
}

/** The calls of a house `after` standing whole but for the cells `changed` (a swap in place): {@link callWorks} over all its calls. */
export const inPlaceWorks = (after: HousePlan, changed: readonly WorldCell[]): CallWork[] => callWorks(after, { first: 0, last: after.batches.length - 1 }, changed);

/** Blocks to stand on that a stage lacks: the stand columns the routes' scaffold builds for its cells out of the eye's reach from the ground. */
export interface ScaffoldNeed {
  /** The blocks of the stand columns the runtime's cover gives for the stage's out-of-reach cells: their heights summed (`columnsForCells`). */
  readonly count: number;
  /** How far above the ground the highest out-of-reach cell is. */
  readonly height: number;
  /** The kinds the movement policy admits as scaffold, besides the house's own blocks. */
  readonly admitted: readonly string[];
}

/** The middle of the cells' footprint: where the bot may stand among them, as the cover's tie-break (the bot's own place is not known here). */
function footprintCentre(cells: readonly WorldCell[]): { x: number; z: number } {
  const middle = (axis: "x" | "z") => (Math.min(...cells.map((cell) => cell[axis])) + Math.max(...cells.map((cell) => cell[axis]))) / 2;
  return { x: middle("x"), z: middle("z") };
}

/**
 * What a stage needs to stand on, from where the bot's feet are (`walkingY`, the site's level): the cells the eye cannot reach
 * from the ground (`outOfReachFromGround`) are worked from the top of stand columns, each laid by the routes as blocks of a
 * kind the policy admits (live 2026-11-10: Bruno's roof passed the material check and failed mid-stage, both his
 * scaffold-able blocks spent on the foundation); `count` is the blocks of those columns, as the runtime plans them
 * (plan 2026-11-14-house-build-fixes-2 Task 2c). Null when every cell is within reach (the hanok and medieval-small roofs),
 * when no column could serve one, when enough of a block the policy admits is carried, or when none could be used:
 * `scaffoldBlocks` unread, or every admitted kind one of `kept` (the house's own blocks, kept off the list while it is
 * built): fetching one cannot help, and the runtime's own refusal says why. `works` are the calls still to place cells
 * ({@link callWorks}): the runtime plans the columns of each call alone, with the calls before it built, and the scaffold is
 * taken back between calls, so `count` is the largest of the calls' (a roof's last layer, its lower layers standing, needs
 * taller columns than the whole roof planned at once: saltbox 11 against 10).
 */
export function scaffoldNeed(works: readonly CallWork[], walkingY: number, inventory: readonly { readonly name: string; readonly count: number }[], scaffoldBlocks: readonly string[] | undefined, kept: readonly string[]): ScaffoldNeed | null {
  // A cell dug clear places nothing: only the blocks of the bill (`billOfMaterials` leaves the air out) are placed from a height.
  const needs = works.map(({ cells, built }) => {
    const placed = new Set(billOfMaterials(cells).map(({ item }) => item));
    const placing = cells.filter((cell) => placed.has(cell.block));
    const high = placing.filter((cell) => outOfReachFromGround(cell, walkingY));
    if (high.length === 0) return { count: 0, top: walkingY };
    const count = columnsForCells(placing, walkingY, footprintCentre(placing), built).reduce((sum, column) => sum + column.height, 0);
    return { count, top: Math.max(...high.map((cell) => cell.y)) };
  });
  const admitted = (scaffoldBlocks ?? []).filter((block) => !kept.includes(block));
  const count = Math.max(0, ...needs.map((need) => need.count));
  if (count === 0 || admitted.length === 0) return null;
  const carried = inventory.filter((stack) => admitted.includes(stack.name)).reduce((sum, stack) => sum + stack.count, 0);
  // The height is the one a call that asks for blocks reaches: a call no column serves says nothing of what to fetch.
  return carried >= count ? null : { count, height: Math.max(...needs.filter((need) => need.count > 0).map((need) => need.top)) - walkingY, admitted };
}

/**
 * What a walk must keep of each kind the cells still to place need to stand on (`navigate`'s `reserve_items`: the route lays
 * a reserved kind only while it carries more than the count, its fallback scaffold included): every admitted kind besides
 * `kept` at the count {@link scaffoldNeed} gives for none carried, whatever is carried (5 dirt for a count of 4 keep 4: the
 * spare may bridge; a kind carried later on the same walk is kept too). `works` may span stages (a floor's walk keeps what the
 * roof takes): the count is the largest call's, the same function as the stage's own check. `[]` when {@link scaffoldNeed}
 * gives none: no placed cell out of the eye's reach from `walkingY`, the policy unread, or every admitted kind one of `kept`.
 */
export function scaffoldReserve(works: readonly CallWork[], walkingY: number, scaffoldBlocks: readonly string[] | undefined, kept: readonly string[]): ItemCount[] {
  const needed = scaffoldNeed(works, walkingY, [], scaffoldBlocks, kept);
  return needed === null ? [] : needed.admitted.map((item) => ({ item, count: needed.count }));
}

/** What a stage lacks to be built now: items not carried, and blocks to stand on. */
export interface StageShortfall {
  readonly missing: readonly MaterialCount[];
  /** Said after the missing items: what a trade owes of what is carried. */
  readonly owedNote: string;
  readonly scaffold: ScaffoldNeed | null;
}

/** The words of a shortfall that are not items ("about 4 blocks to stand on for ..."): a result holding them lacks what an inventory list cannot show. */
export const STAND_ON_WORDS = "blocks to stand on";

/** "7 spruce_slab and about 4 blocks to stand on for its cells 5 above the ground (...)": what is lacking, as the model reads it. */
export function describeShortfall({ missing, scaffold }: Pick<StageShortfall, "missing" | "scaffold">): string {
  const standOn = scaffold === null ? "" : `about ${scaffold.count} ${STAND_ON_WORDS} for its cells ${scaffold.height} above the ground (scaffold the build lays and takes back: one of ${scaffold.admitted.join(", ")})`;
  return [describeMaterials(missing), standOn].filter((part) => part !== "").join(" and ");
}

/**
 * What to fetch, as the model reads it: "exactly" only for the items (the bill is exact), "N or more" for the blocks to
 * stand on (the count is about: the routes lay and take back what they need, review 2026-11-11 S4).
 */
export function fetchClause({ missing, scaffold }: Pick<StageShortfall, "missing" | "scaffold">): string {
  if (scaffold === null) return "fetch exactly the missing items with get_items";
  const standOn = `${scaffold.count} or more ${STAND_ON_WORDS} with get_items`;
  return missing.length === 0 ? `fetch ${standOn}` : `fetch exactly the missing items and ${standOn}`;
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
  return `missing ${describeShortfall(shortfall)} for stage ${index + 1} of ${plan.stages.length} (${plan.stages[index]!.name}) of ${what} (the rest is carried${owedNote === "" ? "" : `; ${owedNote}`})${how.newSite ?? ""}: ${fetchClause(shortfall)}, then ${buildAgain(plan)} again${how.fresh && shortfall.scaffold === null ? OTHER_BLOCKS : OTHER_HOUSE}`;
}

/**
 * The result of a step that built stages `from`..`index - 1` (0-based) and stops before stage `index`, whose blocks are
 * not carried. It never starts with "built": the run analysis counts `done` + "built…" as a finished house.
 */
export function stagesBuilt(plan: HousePlan, from: number, index: number, shortfall: StageShortfall): string {
  const { door } = plan.site;
  const { owedNote } = shortfall;
  return `stages ${from + 1}-${index} of ${plan.stages.length} of the ${plan.template.kind} are built (door at ${door.x} ${door.y} ${door.z}): ${stageName(plan, index)} needs ${describeShortfall(shortfall)}${owedNote === "" ? "" : ` (${owedNote})`}: ${fetchClause(shortfall)}, then ${buildAgain(plan)} again to go on${OTHER_HOUSE}`;
}

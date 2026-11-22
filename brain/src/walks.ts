// How the skills ask for a walk: the `navigate` input, the walk that keeps what the work at its end needs
// (plan 2026-11-12-house-build-fixes Task 1), and the way back a failed fetch names (Task 3).
import type { ActOutcome } from "./body.ts";
import { planTemplate, type HousePlan } from "./building/plan.ts";
import { callWorks, scaffoldReserve, stageAt, stageCellsNow } from "./building/stage-progress.ts";
import { templateFor, templateOfKind, TEMPLATES } from "./building/templates.ts";
import { billOfMaterials, type MaterialCount } from "./building/blueprint.ts";
import { sameDimension } from "./bot-data-sql.ts";
import { describeWay } from "./gathering/fetch-farther.ts";
import type { ItemCount, Position } from "./runtime-client.ts";
import type { SkillContext } from "./skills.ts";
import { navigateInput } from "./skills/positions.ts";
import { isNoPath, NO_KEEP, walkKeepInput, walkRelaxing, type WalkKeep } from "./walk-keep.ts";

/** `get_items` walks back to where it started when it ends farther than this, and a failed one names the way back past it. */
export const RETURN_RANGE = 3;

/**
 * Walks to `to` (within `range`, default 1) without laying what the work there needs: `keep` goes to `navigate` as `keep_items` (names: never
 * placed) and `reserve_items` (counts: placed only above them), which the route and its fallback scaffold both honour. When the
 * keep leaves the pathfinder no way (`[NAVIGATION_STOPPED]`), one more walk follows {@link relaxedKeep} (`countsBefore`: the bill
 * at its need), and the stage check after the walk says what is short.
 */
export async function walkKeeping(context: Pick<SkillContext, "body" | "signal" | "runtime">, to: Position, why: string, keep: WalkKeep, countsBefore: readonly ItemCount[], range = 1): Promise<ActOutcome> {
  const walk = (kept: WalkKeep) => context.body.act("navigate", { ...navigateInput(to, range), ...walkKeepInput(kept) }, why, { signal: context.signal });
  return walkRelaxing(context, keep, countsBefore, walk, isNoPath);
}

/**
 * The blocks the cells of parts `first`..`last` still to place need carried to stand on, by count (`scaffoldReserve`): what a
 * walk must not lay below it. `read`: the world is read, so a cell already right (a resumed stage) asks nothing.
 */
export async function scaffoldReserveBetween(context: Pick<SkillContext, "runtime">, plan: HousePlan, range: { readonly first: number; readonly last: number }, kept: readonly string[], read: boolean): Promise<ItemCount[]> {
  const cells = await stageCellsNow(plan, { ...plan.stages[stageAt(plan, range.first)]!, ...range }, read ? context.runtime : null);
  const status = await context.runtime.status();
  return scaffoldReserve(callWorks(plan, range, cells), plan.site.door.y, status.policy?.scaffoldBlocks, kept);
}

/**
 * The blocks the cells of the whole house still to place from `part` on (this stage's rest and every later stage) need carried to
 * stand on, by count: what a tool-loss refetch's walks must not lay below it (live 2026-11-17: the floor's own count was none, the
 * roof's 11 were laid on the way to a table).
 */
export const houseScaffoldReserveFrom = (context: Pick<SkillContext, "runtime">, plan: HousePlan, part: number, kept: readonly MaterialCount[]) =>
  scaffoldReserveBetween(context, plan, { first: part, last: plan.stages.at(-1)!.last }, kept.map((entry) => entry.item), true);

/** What an unfinished house still takes: `bill` the blocks of the cells still wrong from the record's part on, `keep` what a walk carrying them must not spend. */
export interface HouseReserve {
  readonly keep: WalkKeep;
  readonly bill: readonly ItemCount[];
}

const NO_HOUSE_RESERVE: HouseReserve = { keep: NO_KEEP, bill: [] };

/**
 * What the bot's unfinished house still takes (spec 2026-11-14 section 4): the blocks of the cells still wrong in the world
 * from the record's part to the end (the box read once), and a keep that holds them by count, so a spare may still bridge,
 * plus the blocks its cells out of reach need to stand on. Empty with no unfinished house, or none whose template is known
 * (as `resumable` reads them). For the walks and fetches of a bot that is not building now: `get_items`, `craft_item`'s table.
 */
export async function houseReserve(context: Pick<SkillContext, "runtime" | "building" | "templates">): Promise<HouseReserve> {
  const unfinished = context.building?.unfinished;
  if (unfinished === null || unfinished === undefined) return NO_HOUSE_RESERVE;
  const templates = context.templates ?? TEMPLATES;
  const template = templateFor(unfinished.template ?? templateOfKind(unfinished.kind, templates)?.id ?? "", templates);
  if (template === undefined) return NO_HOUSE_RESERVE;
  const plan = planTemplate(template, unfinished.site, unfinished.materials ?? {});
  const first = plan.stages[stageAt(plan, unfinished.part)]!;
  const cells = await stageCellsNow(plan, { ...first, last: plan.stages.at(-1)!.last }, context.runtime);
  const bill = billOfMaterials(cells).map(({ item, count }) => ({ item, count }));
  const status = await context.runtime.status();
  const scaffold = scaffoldReserve(callWorks(plan, { first: first.first, last: plan.stages.at(-1)!.last }, cells), plan.site.door.y, status.policy?.scaffoldBlocks, bill.map((entry) => entry.item));
  return { keep: { items: [], reserve: bill, scaffold }, bill };
}

/**
 * What the walks of a means fetch (a lost tool, a craft's table, the levelling's tools and fill) keep of the unfinished house: its
 * whole scaffold by count and nothing else, since a means fetch keeps no bill (`GatherContext.means`) but its walks must not lay
 * the blocks the later stages stand on. Nothing with no unfinished house.
 */
export async function houseScaffoldKeep(context: Pick<SkillContext, "runtime" | "building" | "templates">): Promise<WalkKeep> {
  return { ...NO_KEEP, scaffold: (await houseReserve(context)).keep.scaffold };
}

/** Whether a fetch that ended at `here` is more than {@link RETURN_RANGE} (3D) from where it started. */
export const awayFrom = (start: Position, here: Position): boolean => Math.hypot(here.x - start.x, here.y - start.y, here.z - start.z) > RETURN_RANGE;

/**
 * What a failed fetch adds to its detail: where it started, as a `go_to` step the model may take. A failure leaves a choice
 * the success does not (fetch from another source near here, give up, go back), so nothing walks (spec 2026-11-12 section 5).
 * Empty near the start, and in another dimension (the coordinates would mislead).
 */
export function failedFetchNote(start: Position, startDimension: string, after: { readonly position: Position; readonly dimension: string }): string {
  return awayFrom(start, after.position) && sameDimension(startDimension, after.dimension) ? `; you are ${wayBack(start, after.position)} from where you started fetching: ${backStep(start)} walks back` : "";
}

/** How far `here` is from `start` as the model reads it: "40 blocks east", plus " and 12 below" past {@link RETURN_RANGE} of height; "12 below" alone when straight under or over it. */
export function wayBack(start: Position, here: Position): string {
  const height = Math.round(here.y - start.y);
  const up = Math.abs(here.y - start.y) > RETURN_RANGE ? `${Math.abs(height)} ${height < 0 ? "below" : "above"}` : "";
  if (Math.hypot(here.x - start.x, here.z - start.z) < RETURN_RANGE && up !== "") return up;
  return up === "" ? describeWay(start, here) : `${describeWay(start, here)} and ${up}`;
}

/** The `go_to` step to the block `at` stands in. */
export const backStep = (at: Position): string => JSON.stringify({ skill: "go_to", x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) });

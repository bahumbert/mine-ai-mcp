// How the skills ask for a walk: the `navigate` input, the walk that keeps what the work at its end needs
// (plan 2026-11-12-house-build-fixes Task 1), and the way back a failed fetch names (Task 3).
import type { ActOutcome } from "./body.ts";
import type { HousePlan } from "./building/plan.ts";
import { scaffoldKinds, stageAt, stageCellsNow } from "./building/stage-progress.ts";
import type { MaterialCount } from "./building/blueprint.ts";
import { sameDimension } from "./bot-data-sql.ts";
import { describeWay } from "./gathering.ts";
import type { Position } from "./runtime-client.ts";
import type { SkillContext } from "./skills.ts";

/** `get_items` walks back to where it started when it ends farther than this, and a failed one names the way back past it. */
export const RETURN_RANGE = 3;

/** The `navigate` input that walks to the block `target` stands in, within `range` blocks. */
export function navigateInput(target: Position, range: number): Record<string, unknown> {
  return { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z), range };
}

/**
 * Walks to `to` (range 1) without laying what the work there needs: `keep.bill` (the house's blocks) and `keep.scaffold` (the
 * kinds its cells out of reach need to stand on, `scaffoldKinds`) go to `navigate` as `keep_items`, which the route and its
 * fallback scaffold both honour. When keeping the scaffold leaves the pathfinder no way (`[NAVIGATION_STOPPED]`, the one
 * failure keeping blocks can cause: deep water, a boat or a dimension change keep their result), one more walk keeps the
 * bill only: the scaffold may then bridge, and the stage check after the walk says what is short.
 */
export async function walkKeeping(context: Pick<SkillContext, "body" | "signal" | "runtime">, to: Position, why: string, keep: { readonly bill: readonly string[]; readonly scaffold: readonly string[] }): Promise<ActOutcome> {
  const walk = (kept: readonly string[]) => context.body.act("navigate", { ...navigateInput(to, 1), ...(kept.length > 0 && { keep_items: kept }) }, why, { signal: context.signal });
  const outcome = await walk([...new Set([...keep.bill, ...keep.scaffold])]);
  if (outcome.status === "succeeded" || context.signal.aborted || keep.scaffold.length === 0 || outcome.error?.startsWith("[NAVIGATION_STOPPED]") !== true) return outcome;
  // Only a carried scaffold block can have been the reason: with none carried the second walk would be the same walk.
  if (!(await context.runtime.status()).inventory.some((stack) => keep.scaffold.includes(stack.name))) return outcome;
  return walk([...new Set(keep.bill)]);
}

/**
 * The kinds the cells of parts `first`..`last` still to place need carried to stand on (`scaffoldKinds`): what a walk must
 * not lay. `read`: the world is read, so a cell already right (a resumed stage) asks nothing.
 */
export async function scaffoldKindsBetween(context: Pick<SkillContext, "runtime">, plan: HousePlan, range: { readonly first: number; readonly last: number }, kept: readonly string[], read: boolean): Promise<readonly string[]> {
  const cells = await stageCellsNow(plan, { ...plan.stages[stageAt(plan, range.first)]!, ...range }, read ? context.runtime : null);
  const status = await context.runtime.status();
  return scaffoldKinds(cells, plan.site.door.y, status.inventory, status.policy?.scaffoldBlocks, kept);
}

/** The kinds the cells of the stage holding `part`, from that part on, need carried to stand on: what a tool-loss refetch's walks must not lay. */
export const stageScaffoldKinds = (context: Pick<SkillContext, "runtime">, plan: HousePlan, part: number, kept: readonly MaterialCount[]) =>
  scaffoldKindsBetween(context, plan, { first: part, last: plan.stages[stageAt(plan, part)]!.last }, kept.map((entry) => entry.item), true);

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

import { z } from "zod";
import { FARM_RANGE, type Step } from "../actions.ts";
import { describeMaterials } from "../building/blueprint.ts";
import type { KnownFarm } from "../memory.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";
import { describeWay } from "../gathering.ts";
import { describeOverlaps, findPlayer, levelZone, navigateInput, nearestClearSpot, noteArea, overlapsOf, releaseArea, SITE_SEARCH, type SkillContext, type SkillResult } from "../skills.ts";
import { farmPlot, plotBehind, type FarmPlot } from "./plot.ts";

/** Farther than this from a new farm's middle, she walks there before leveling it. */
const WALK_RANGE = 8;
/** Seeds suggested when she carries none: enough to start, the farm grows from its own harvests. */
const STARTING_SEEDS = 16;

/** What `tend_crops` reports of the plot afterwards (src/actions/tend-crops/contract.ts). */
const tendedSchema = z.object({
  tended: z.object({
    after: z.object({ crops: z.record(z.string(), z.number()), emptyFarmland: z.number() }),
    skipped: z.record(z.string(), z.array(z.unknown())).optional(),
  }),
});

/**
 * Cells `tend_crops` left as they were, counted by reason ("6 not tillable (cobblestone)"); null when none. Live
 * 2026-10-03: told only "11 cells could not be farmed; see skipped" (a list the model never sees), she guessed she
 * needed a hoe, fetched one, dropped both she carried and fetched them again.
 */
function skippedCells(skipped: Readonly<Record<string, readonly unknown[]>> | undefined): string | null {
  const reasons = Object.entries(skipped ?? {}).filter(([, cells]) => cells.length > 0);
  if (reasons.length === 0) return null;
  const total = reasons.reduce((sum, [, cells]) => sum + cells.length, 0);
  return `${total} cell${total === 1 ? "" : "s"} left as they were: ${reasons.map(([reason, cells]) => `${cells.length} ${reason}`).join(", ")}`;
}

function carried(snapshot: BotSnapshot, item: string): number {
  return snapshot.inventory.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);
}

function horizontal(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Makes a crop farm the way a player starts one, or tends one she made (ADR-014): near a farm she knows (within
 * {@link FARM_RANGE} of its middle) the plot is tended, so ripe crops are harvested and replanted; elsewhere a new
 * square of soil is protected, leveled, watered in its middle from a bucket, tilled and planted. When to farm, where
 * and what to plant are the model's choices (Rule #0).
 */
export async function farm(context: SkillContext, step: Extract<Step, { skill: "farm" }>): Promise<SkillResult> {
  const snapshot = await context.runtime.status();
  const at = step.x !== undefined && step.y !== undefined && step.z !== undefined ? { x: step.x, y: step.y, z: step.z } : null;
  const known = context.farms?.find((candidate) => horizontal(candidate.centre, at ?? snapshot.position) <= FARM_RANGE);
  if (known !== undefined) return tendKnown(context, snapshot, known, step.crop);
  const crop = step.crop;
  if (crop === undefined) return { status: "failed", detail: "a new farm needs a crop to plant: say which item (wheat_seeds, carrot, potato, beetroot_seeds)" };
  const toward = context.requester === undefined ? null : findPlayer(snapshot, context.requester)?.position ?? null;
  const plot = at === null ? plotBehind(snapshot.position, toward, step.size) : farmPlot({ x: at.x, y: at.y - 1, z: at.z }, step.size);
  return makeFarm(context, snapshot, plot, crop);
}

async function makeFarm(context: SkillContext, snapshot: BotSnapshot, plot: FarmPlot, crop: string): Promise<SkillResult> {
  const what = `a ${plot.size}x${plot.size} ${crop} farm`;
  const { water } = plot;
  const waterKey = `${water.x},${water.y},${water.z}`;
  const middleBefore = (await context.runtime.blocksIn(water, water)).blocks.get(waterKey);
  const hasHoe = snapshot.inventory.some((stack) => stack.name.endsWith("_hoe"));
  const needsBucket = middleBefore !== "water" && carried(snapshot, "water_bucket") === 0 && carried(snapshot, "bucket") === 0;
  const missing = [
    ...(hasHoe ? [] : [{ item: "wooden_hoe", count: 1 }]),
    ...(needsBucket ? [{ item: "bucket", count: 1 }] : []),
    ...(carried(snapshot, crop) === 0 ? [{ item: crop, count: STARTING_SEEDS }] : []),
  ];
  // Named as the step that fetches them, as a build does: get_items adds to what she carries.
  if (missing.length > 0) return { status: "failed", detail: `${what} needs ${describeMaterials(missing)} (not carried): fetch exactly those with get_items, then farm again` };

  if (horizontal(snapshot.position, water) > WALK_RANGE) {
    context.progress?.(`walking to the site of ${what} at ${water.x} ${water.y} ${water.z}`);
    const there = await context.body.act("navigate", navigateInput({ x: water.x, y: water.y + 1, z: water.z }, 3), `Walk to the site of ${what}.`, { signal: context.signal });
    if (context.signal.aborted) return { status: "stopped" };
    if (there.status !== "succeeded") return { status: "failed", detail: `could not reach the site of ${what}: ${there.error ?? there.status}` };
  }
  // A plot clear of every protected area before anything is protected or dug, and if not, where the nearest clear one
  // is (live 2026-10-10: a farm protected over her own house, then leveling failed, and the house was undone).
  const areas = await context.runtime.protectedRegions();
  const boxAt = (middle: Position) => ({
    min: { x: plot.min.x - 1 + middle.x - water.x, y: water.y - 1, z: plot.min.z - 1 + middle.z - water.z },
    max: { x: plot.max.x + 1 + middle.x - water.x, y: water.y + 2, z: plot.max.z + 1 + middle.z - water.z },
  });
  const blocked = overlapsOf(areas, boxAt(water));
  if (blocked.length > 0) {
    const clear = nearestClearSpot(areas, water, boxAt);
    const where = clear === null
      ? `no plot clear of protected areas within ${SITE_SEARCH} blocks: ask whoever asked you, or farm somewhere else`
      : `the nearest plot clear of them has its middle ${describeWay(snapshot.position, clear)}, at ${clear.x} ${clear.y + 1} ${clear.z}: farm there with those coordinates`;
    return { status: "failed", detail: `the site of ${what} (middle at ${water.x} ${water.y + 1} ${water.z}) ${describeOverlaps(context, blocked)}; ${where}` };
  }
  // Protected before the first change, ring included: her own gathering never digs or tramples into it (ADR-012).
  const protection = await context.runtime.protectRegion({
    ...boxAt(water),
    label: `farm ${crop}`,
    reason: `Keep my own digging out of the ${crop} farm I am making.`,
  });
  if (protection.status === "failed") return { status: "failed", detail: `could not protect the site of ${what}: ${protection.error}` };
  noteArea(context, protection.area);
  // A farm that cannot be finished gives its plot back (live 2026-10-03: a worn-out shovel stopped the leveling, the
  // plot stayed protected, and every new try from a step aside was refused over it).
  let result: SkillResult = { status: "stopped" };
  try {
    result = await prepareAndPlant(context, plot, crop, what, protection.area.regionId);
    return result;
  } finally {
    if (result.status !== "done") await releaseArea(context, protection.area.regionId);
  }
}

/** A protected new plot leveled, watered in its middle, tilled and planted. */
async function prepareAndPlant(context: SkillContext, plot: FarmPlot, crop: string, what: string, regionId: number): Promise<SkillResult> {
  const { water } = plot;
  const waterKey = `${water.x},${water.y},${water.z}`;
  context.progress?.(`making ${what}: leveling its ground`);
  // The middle cell is left as it is: water already there stays, the hole for the water is dug next.
  const leveled = await levelZone(context, { minX: plot.min.x, maxX: plot.max.x, minZ: plot.min.z, maxZ: plot.max.z }, water.y + 1, `the site of ${what}`, {
    below: 1,
    placedLater: new Set([waterKey]),
    // Soil a hoe can till (live 2026-10-03: hollows filled with spare cobblestone were "not tillable").
    fillWith: "dirt",
  }, [], [regionId]);
  if (leveled.status !== "done") return leveled.status === "stopped" ? leveled : { status: "failed", detail: `could not level the site of ${what}: ${leveled.detail}` };

  const middle = (await context.runtime.blocksIn(water, water)).blocks.get(waterKey);
  if (middle !== "water") {
    if (middle !== undefined && middle !== "air") {
      // An air cell of build_structure, which works inside her own farm region (live 2026-10-03: collect_block refused
      // the hole there, the farm being protected before it is dug).
      const hole = { blocks: [{ x: water.x, y: water.y, z: water.z, block_name: "air" }], remove_wrong_blocks: true };
      const dug = await context.body.act("build_structure", hole, `Dig the hole for the water of ${what}.`, { signal: context.signal });
      if (context.signal.aborted) return { status: "stopped" };
      if (dug.status !== "succeeded") return { status: "failed", detail: `could not dig the water hole of ${what}: ${dug.error ?? dug.status}` };
    }
    if (carried(await context.runtime.status(), "water_bucket") === 0) {
      context.progress?.(`making ${what}: fetching water in a bucket`);
      const filled = await context.body.act("use_bucket", { action: "fill", liquid: "water" }, `Fill a bucket with water for ${what}.`, { signal: context.signal });
      if (context.signal.aborted) return { status: "stopped" };
      if (filled.status !== "succeeded") return { status: "failed", detail: `could not fill a bucket with water for ${what}: ${filled.error ?? filled.status}` };
    }
    const poured = await context.body.act("use_bucket", { action: "pour", liquid: "water", x: water.x, y: water.y, z: water.z }, `Pour the water in the middle of ${what}.`, { signal: context.signal });
    if (context.signal.aborted) return { status: "stopped" };
    if (poured.status !== "succeeded") return { status: "failed", detail: `could not pour the water of ${what}: ${poured.error ?? poured.status}` };
  }

  context.progress?.(`making ${what}: tilling and planting it`);
  const now = new Date().toISOString();
  return tend(context, plot, crop, crop, { madeAt: now }, `made ${what} around ${water.x} ${water.y} ${water.z}`);
}

async function tendKnown(context: SkillContext, snapshot: BotSnapshot, known: KnownFarm, asked: string | undefined): Promise<SkillResult> {
  const plot = farmPlot(known.centre, known.size as FarmPlot["size"]);
  const wanted = asked ?? known.crop;
  // Planting is asked only with the item carried: without it the harvest still replants its own cells from the drops.
  const plant = carried(snapshot, wanted) > 0 ? wanted : null;
  context.progress?.(`tending your ${known.crop} farm: harvesting what is ripe and replanting`);
  return tend(context, plot, known.crop, plant, { madeAt: known.madeAt }, `tended your ${known.crop} farm around ${known.centre.x} ${known.centre.y} ${known.centre.z}`);
}

/** One `tend_crops` over the plot, then the farm remembered as it stands. */
async function tend(context: SkillContext, plot: FarmPlot, crop: string, plant: string | null, made: { madeAt: string }, doneDetail: string): Promise<SkillResult> {
  const input = { x1: plot.min.x, z1: plot.min.z, x2: plot.max.x, z2: plot.max.z, y: plot.water.y, ...(plant !== null && { plant }) };
  const outcome = await context.body.act("tend_crops", input, `Farm my ${crop} plot.`, { signal: context.signal });
  if (context.signal.aborted) return { status: "stopped" };
  const tended = tendedSchema.safeParse(outcome.result).data?.tended;
  const after = tended?.after;
  const left = skippedCells(tended?.skipped);
  const crops = Object.entries(after?.crops ?? {});
  const state = {
    planted: crops.reduce((sum, [, count]) => sum + count, 0),
    ripe: crops.filter(([key]) => key.endsWith(" ripe")).reduce((sum, [, count]) => sum + count, 0),
    empty: after?.emptyFarmland ?? 0,
  };
  if (after !== undefined) {
    context.rememberFarm?.({ crop, size: plot.size, centre: plot.water, madeAt: made.madeAt, tendedAt: new Date().toISOString(), state });
  }
  // Why farmland stays empty, as the step that fixes it (live 2026-10-03: told only "4 farmland empty", the model
  // tended the farm three more times).
  const seeds = carried(await context.runtime.status(), crop);
  const empty = state.empty > 0 && seeds === 0
    ? `${state.empty} farmland empty because you carry no ${crop}: get_items ${crop} ${state.empty}, then farm again to plant them`
    : `${state.empty} farmland empty`;
  const summary = `${state.planted} planted, ${state.ripe} ripe, ${empty}`;
  if (outcome.status === "succeeded") return { status: "done", detail: `${doneDetail}: ${summary}` };
  if (outcome.status === "partial") return { status: "done", detail: `${doneDetail}, partly: ${summary}; ${left ?? outcome.error ?? ""}` };
  // Ground of air: the plot hangs in a cave or over a pit (live 2026-10-09: Ayla, in a cave at y 10, farmed "near my
  // current position" 20 times, each "25 not tillable (air)").
  const noGround = (tended?.skipped?.["not tillable (air)"]?.length ?? 0) >= plot.size * plot.size
    ? `; there is no ground at y ${plot.water.y} here (a cave or a pit): farm on grass or dirt under the open sky, at its height`
    : "";
  return { status: "failed", detail: `farming the ${crop} plot around ${plot.water.x} ${plot.water.y} ${plot.water.z} stopped: ${left === null ? (outcome.error ?? outcome.status) : `${summary}; ${left}`}${noGround}` };
}

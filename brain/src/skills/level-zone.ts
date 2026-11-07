// Making a zone flat at a walking level: the protection of its margin, the plan, the tools and fill, the batches.
import { SUPPORT_REACH, levelBox, levelPlan, type LevelOptions, type TerrainCell, type Zone } from "../building/terrain.ts";
import { lostToolClass, ToolLosses, toolToMake } from "../building/tool-loss.ts";
import type { Stacks } from "../gathering/stacks.ts";
import { carriesFamily } from "../inventory-room.ts";
import { areaKey, errorCode, type BotRuntime } from "../runtime-client.ts";
import type { SkillContext, SkillResult } from "../skills.ts";
import { getItems } from "./get-items.ts";
import { releaseArea } from "./protect-area.ts";
import { describeOverlaps, LEVELING_LABEL, noteArea, overlapsOf } from "./protected-areas.ts";
import { auditSuffix, onlyRefused } from "./structure-audit.ts";

/** Tools a leveling job replaces when they wear out before it gives up (in all, and of one class). */
const LEVEL_TOOL_LOSSES = { perClass: 6, total: 6 };
/** Blocks around a leveling zone where she never digs her fill, and how deep under its level. */
const FILL_MARGIN = 4;
const FILL_MARGIN_BELOW = 8;

/**
 * Makes `zone` flat with its walking level at `level` (feet height), the way a player would: carries the right tool
 * for every kind of block to dig (owner, 2026-10-02: "ALWAYS use tools, the corresponding best one available"), fills
 * the liquid above the level, digs from the top down, then fills the holes from the bottom up with what the dig
 * brought, fetching only what is still short (`terrain.ts`).
 */
export async function levelZone(context: SkillContext, zone: Zone, level: number, what: string, options: LevelOptions & { readonly fillWith?: string } = {}, reserved: readonly { readonly item: string; readonly count: number }[] = [], ownRegions: readonly number[] = []): Promise<SkillResult> {
  const { min, max } = levelBox(zone, level);
  // Leveling digs inside her own regions too (it runs as a build): never over an area she protects, her other houses
  // included, except the house being prepared (live 2026-10-02: a zone "between the oak_log markers" reached her house).
  const overlapping = overlapsOf(await context.runtime.protectedRegions(), { min, max }, ownRegions);
  if (overlapping.length > 0) {
    return { status: "failed", detail: `${what} ${describeOverlaps(context, overlapping)}: choose another zone clear of ${overlapping.length === 1 ? "it" : "them"}, or ask whoever asked you` };
  }
  // Her own region while she works, with a margin: fill is dug a safe distance away, never at the zone's edge or
  // under it (owner, 2026-10-02: she dug right below the zone she was leveling). A house site gets it too.
  const margin = await context.runtime.protectRegion({
    min: { x: min.x - FILL_MARGIN, y: level - FILL_MARGIN_BELOW, z: min.z - FILL_MARGIN },
    max: { x: max.x + FILL_MARGIN, y: max.y, z: max.z + FILL_MARGIN },
    label: `${LEVELING_LABEL}${zone.maxX - zone.minX + 1}x${zone.maxZ - zone.minZ + 1}`,
    reason: "Keep my own digging for fill away from the zone I am leveling.",
  });
  if (margin.status === "failed") return { status: "failed", detail: `could not set the zone aside: ${margin.error}` };
  noteArea(context, margin.area);
  try {
    return await levelInside(context, zone, level, what, options, reserved, { min, max });
  } finally {
    await releaseArea(context, margin.area.regionId);
  }
}

/** {@link levelZone}'s work, once the zone and its margin are set aside. */
async function levelInside(context: SkillContext, zone: Zone, level: number, what: string, options: LevelOptions & { readonly fillWith?: string }, reserved: readonly { readonly item: string; readonly count: number }[], { min, max }: ReturnType<typeof levelBox>): Promise<SkillResult> {
  const inventory = (await context.runtime.status()).inventory;
  const spare = spareOf(inventory, reserved);
  const planFor = (area: LevelArea) => levelPlan(zone, level, area, fillBlockFor(cellCount(levelPlan(zone, level, area, "dirt", options).phases.fillFirst), spare, options.fillWith), options);
  let area = await readLevelArea(context, min, max, 0);
  let plan = planFor(area);
  if (plan.floating) {
    // A platform in the air: the ground to build its support column from is further down than the zone's own layers.
    area = await readLevelArea(context, min, max, SUPPORT_REACH);
    plan = planFor(area);
    if (plan.floating) return { status: "failed", detail: `leveling ${what} would build a platform in the air with no solid ground within ${SUPPORT_REACH} blocks under it: choose a nearer height` };
  }
  if (plan.batches.length === 0) return { status: "done", detail: `${what} is already level` };
  const moved = plan.dug + plan.filled;
  // A pit is told whatever the count (run 13: a cellar dug by repeated small levels passed silently under the budget).
  const pitNote = plan.pit > 0 ? ` (this digs a pit ${plan.pit} deep)` : "";
  if (options.budget !== undefined && moved > options.budget) return overBudget(what, plan, pitNote, moved, options.budget);
  const needs = toolsMissing(plan, inventory, reserved);
  const first = cellCount(plan.phases.fillFirst);
  const firstFill = plan.phases.fillFirst[0]?.[0]?.block;
  if (firstFill !== undefined && spare(firstFill) < first) needs.push({ item: firstFill, count: first - Math.max(0, spare(firstFill)) });
  if (needs.length > 0) {
    const got = await getItems(context, needs, `the tools${firstFill === undefined ? "" : " and fill"} to level ${what}`);
    if (got.status !== "done") return got;
  }
  // Cells it may not touch (someone's crafting table, a block under water) are left and leveled around, as a player
  // would (live 2026-10-02: one table on a treetop stopped a whole site); anything else stops the job.
  const levelRun: LevelRun = { context, what, plan, area, reserved, toolLosses: new ToolLosses(LEVEL_TOOL_LOSSES), counts: { left: 0, done: 0 } };
  const run = (batches: readonly (readonly TerrainCell[])[]) => buildLevelBatches(levelRun, batches);
  context.progress?.(`leveling ${what}: ${plan.dug > 0 ? "digging what stands above it" : "filling it"}`);
  const dug = await run([...plan.phases.fillFirst, ...plan.phases.dig]);
  if (dug !== null) return dug;
  const holes = cellCount(plan.phases.fillAfter);
  if (holes > 0) {
    const filled = await fillHoles(context, what, plan.phases.fillAfter, holes, (stacks) => spareOf(stacks, reserved), (count, has) => fillBlockFor(count, has, options.fillWith), run);
    if (filled !== null) return filled;
  }
  const { left } = levelRun.counts;
  const around = left === 0 ? "" : ` (left ${left} cell${left === 1 ? "" : "s"} it may not dig, leveled around)`;
  const column = plan.support === 0 ? "" : ` (${plan.support} of them a support column up from the ground)`;
  return { status: "done", detail: `leveled ${what}: dug ${plan.dug - left}, filled ${plan.filled}${column}${around}${pitNote}` };
}

type LevelPlan = ReturnType<typeof levelPlan>;
type LevelArea = Awaited<ReturnType<typeof readLevelArea>>;
type LevelBox = ReturnType<typeof levelBox>;
type Reserved = readonly { readonly item: string; readonly count: number }[];
type Batches = readonly (readonly TerrainCell[])[];

/** The zone's box read from the runtime, with the game's tags on every kind of block. */
async function readLevelArea(context: SkillContext, min: LevelBox["min"], max: LevelBox["max"], below: number) {
  // One column past the zone on every side: what a layer can be placed against, and the ground around it (a pit's walls).
  const area = await context.runtime.blocksIn({ x: min.x - 1, y: min.y - below, z: min.z - 1 }, { x: max.x + 1, y: max.y, z: max.z + 1 });
  // A box read names no block tags; the game's tags tell a tree (a pit wall stops at it) from planks or a chest. A lookup that fails leaves them untagged.
  const tagged = await context.runtime.blockKinds(Object.keys(area.kinds)).catch(() => ({}) as Awaited<ReturnType<BotRuntime["blockKinds"]>>);
  return { ...area, kinds: Object.fromEntries(Object.entries(area.kinds).map(([name, kind]) => [name, { ...kind, tags: tagged[name]?.tags ?? [] }])) };
}

/** How many of an item the stacks hold beyond the blocks reserved for what comes next. */
function spareOf(stacks: Stacks, reserved: Reserved): (item: string) => number {
  // What it may spend: never the blocks reserved for what comes next (the house's own cobblestone).
  return (item: string) =>
    stacks.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0) - (reserved.find((entry) => entry.item === item)?.count ?? 0);
}

/** The block that fills `count` holes: the one the request names, else cobblestone when enough is spare, else dirt. */
function fillBlockFor(count: number, has: (item: string) => number, fillWith: string | undefined): string {
  // Dirt is the fill: quick to dig with a shovel and everywhere. Cobblestone only when enough of it is spare already;
  // fetching it means mining stone (live 2026-10-02: a 42-block fill sent her mining for half an hour).
  // A fill the request names (owner, 2026-10-02: "tell her with what materials to fill") is always used.
  return fillWith ?? (has("cobblestone") >= count && has("cobblestone") > has("dirt") ? "cobblestone" : "dirt");
}

function cellCount(batches: Batches): number {
  return batches.reduce((sum, batch) => sum + batch.length, 0);
}

/** The tool of each class the plan's dig needs and the stacks do not hold: stone when the cobblestone is spare, else wood. */
function toolsMissing(plan: LevelPlan, stacks: Stacks, reserved: Reserved): { item: string; count: number }[] {
  const has = spareOf(stacks, reserved);
  return plan.tools
    .filter((tool) => !carriesFamily(stacks, tool))
    .map((tool) => ({ item: toolToMake(tool, has), count: 1 }));
}

/** The tool classes (game data: what each block is mined with) of the cells these batches dig clear. */
function toolsDug(area: LevelArea, batches: Batches): Set<string | null | undefined> {
  return new Set(batches.flat().filter((cell) => cell.block === "air").map((cell) => area.kinds[area.blocks.get(areaKey(cell.x, cell.y, cell.z)) ?? ""]?.tool).filter((tool) => tool !== null && tool !== undefined));
}

/** What the batches of one leveling work from; `counts` runs on across its dig and its fill. */
interface LevelRun {
  readonly context: SkillContext;
  readonly what: string;
  readonly plan: LevelPlan;
  readonly area: LevelArea;
  readonly reserved: Reserved;
  readonly toolLosses: ToolLosses;
  /** The cells left undug because they may not be touched, and the batches sent so far. */
  readonly counts: { left: number; done: number };
}

/** Sends the batches to the runtime one by one; null when all went through, else the result that ends the leveling. */
async function buildLevelBatches(levelRun: LevelRun, batches: Batches): Promise<SkillResult | null> {
  const { context, what, plan, area, reserved, toolLosses, counts } = levelRun;
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]!;
    counts.done += 1;
    const blocks = batch.map(({ x, y, z, block }: TerrainCell) => ({ x, y, z, block_name: block }));
    const outcome = await context.body.act("build_structure", { blocks, remove_wrong_blocks: true }, `Level ${what}, ${counts.done}/${plan.batches.length}.`, { signal: context.signal });
    if (context.signal.aborted) return { status: "stopped" };
    if (outcome.status === "succeeded") continue;
    // A tool worn out on the way is replaced and the batch done again, as a player crafts another shovel (live
    // 2026-10-02: a worn stone axe, then the shovel, each ended the whole job).
    // Only for the digging still to do (this batch is done again): a tool that breaks with none left is not made again.
    const digging = toolsDug(area, batches.slice(index));
    const lost = await toolLosses.handle(outcome.error, {
      reserved,
      inventory: async () => (await context.runtime.status()).inventory,
      getItems: (items, purpose) => getItems(context, items, `${purpose}, leveling ${what}`),
      onLost: (toolClass) => context.toolsLost?.add(toolClass),
      stillNeeded: (toolClass) => (digging as ReadonlySet<string>).has(toolClass),
    });
    if (lost.status === "stopped" || context.signal.aborted) return { status: "stopped" };
    if (lost.status === "remade" || lost.status === "unneeded") {
      if (lost.status === "remade") context.toolsLost?.delete(lostToolClass(outcome.error)!);
      counts.done -= 1;
      index -= 1;
      continue;
    }
    const refused = errorCode(outcome.error) === "BUILD_INCOMPLETE" ? onlyRefused(outcome.result) : 0;
    if (refused > 0) {
      counts.left += refused;
      continue;
    }
    const why = lost.status === "refused" || lost.status === "failed" ? `; ${lost.note}` : "";
    return { status: "failed", detail: `leveling stopped at ${counts.done}/${plan.batches.length}: ${outcome.error ?? outcome.status}${auditSuffix(outcome.error, outcome.result)}${why}` };
  }
  return null;
}

/** The holes, with what the dig brought; only the rest is fetched. Null when they are filled. */
async function fillHoles(
  context: SkillContext,
  what: string,
  batches: readonly (readonly TerrainCell[])[],
  holes: number,
  spareIn: (stacks: readonly { readonly name: string; readonly count: number }[]) => (item: string) => number,
  fillFor: (count: number, has: (item: string) => number) => string,
  run: (batches: readonly (readonly TerrainCell[])[]) => Promise<SkillResult | null>,
): Promise<SkillResult | null> {
  const has = spareIn((await context.runtime.status()).inventory);
  const fill = fillFor(holes, has);
  if (has(fill) < holes) {
    const got = await getItems(context, [{ item: fill, count: holes - Math.max(0, has(fill)) }], `filling the holes of ${what}`);
    if (got.status !== "done") return got;
  }
  context.progress?.(`filling the ${holes} holes of ${what} with ${fill}`);
  return run(batches.map((batch) => batch.map((cell) => ({ ...cell, block: fill }))));
}

/** The refusal of a level that moves more blocks than its budget. Counted before the first block goes (run 12: a 25x25 level dug 1324 blocks; a cellar dug by repeated levels). */
function overBudget(what: string, plan: ReturnType<typeof levelPlan>, pitNote: string, moved: number, budget: number): SkillResult {
  const perColumn = new Map<string, number>();
  for (const cell of plan.phases.dig.flat()) perColumn.set(`${cell.x},${cell.z}`, (perColumn.get(`${cell.x},${cell.z}`) ?? 0) + 1);
  const deepest = Math.max(0, ...perColumn.values());
  return { status: "failed", detail: `leveling ${what} means moving ${moved} blocks (${plan.dug} to dig, ${plan.filled} to fill), up to ${deepest} deep${pitNote}; at most ${budget} blocks are moved at a time: ask for a smaller area or a nearer height` };
}

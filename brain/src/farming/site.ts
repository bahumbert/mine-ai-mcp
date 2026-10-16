import type { BotRuntime } from "../runtime-client.ts";
import { areaKey, type BlockArea } from "../runtime-client.ts";
import { farmPlot, type FarmPlot } from "./plot.ts";

/** How far (blocks, per axis) from the first spot a new farm's middle may be moved to find tillable ground. */
export const SITE_RADIUS = 16;
/** Blocks above the soil that must be free of solid blocks: a farm under a roof or in a cave does not grow. */
export const SKY_HEIGHT = 6;
/** The game's own block tag of what a hoe turns into soil (dirt, grass, coarse dirt...), not a list of names here. */
const SOIL_TAG = "dirt";

type Tags = ReadonlyMap<string, readonly string[]>;

/** Block tags of every name in the area, from the game's data (`view_blocks` lookup). */
async function tagsOfArea(runtime: BotRuntime, area: BlockArea): Promise<Tags> {
  const names = [...new Set(area.blocks.values())];
  const kinds = await runtime.blockKinds(names).catch(() => ({}) as Awaited<ReturnType<BotRuntime["blockKinds"]>>);
  return new Map(names.map((name) => [name, kinds[name]?.tags ?? []]));
}

/** Whether a cell's block is ground a farm can have: tillable soil, farmland, water (the middle) or air that leveling fills. */
function isSoil(block: string, tags: Tags, newSite: boolean): boolean {
  return block === "farmland" || block === "water" || (newSite && block === "air") || (tags.get(block) ?? []).includes(SOIL_TAG);
}

function isOpen(area: BlockArea, x: number, y: number, z: number): boolean {
  for (let up = 1; up <= SKY_HEIGHT; up += 1) {
    const block = area.blocks.get(areaKey(x, y + up, z));
    if (block !== undefined && block !== "air" && area.kinds[block]?.solid === true) return false;
  }
  return true;
}

/** What is wrong with the plot's cells at soil level, counted by block ("8 stone", "9 roofed"); empty when the plot is fit. */
function problems(plot: FarmPlot, area: BlockArea, tags: Tags, newSite: boolean): string[] {
  const counts = new Map<string, number>();
  const y = plot.water.y;
  for (let x = plot.min.x; x <= plot.max.x; x += 1) for (let z = plot.min.z; z <= plot.max.z; z += 1) {
    const block = area.blocks.get(areaKey(x, y, z)) ?? "air";
    const reason = !isSoil(block, tags, newSite) ? block : newSite && !isOpen(area, x, y, z) ? "roofed" : null;
    if (reason !== null) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts].map(([reason, count]) => `${count} ${reason}`);
}

function soilBox(plot: FarmPlot, reach: number) {
  const y = plot.water.y;
  return { min: { x: plot.min.x - reach, y, z: plot.min.z - reach }, max: { x: plot.max.x + reach, y: y + SKY_HEIGHT, z: plot.max.z + reach } };
}

/**
 * Where a new farm of this size can go: the asked plot when its ground is tillable under the open sky, else the
 * nearest plot within {@link SITE_RADIUS} that is; otherwise why none is.
 */
export async function chooseSite(runtime: BotRuntime, plot: FarmPlot): Promise<{ readonly plot: FarmPlot } | { readonly refusal: string }> {
  const box = soilBox(plot, SITE_RADIUS);
  const area = await runtime.blocksIn(box.min, box.max);
  const tags = await tagsOfArea(runtime, area);
  const bad = problems(plot, area, tags, true);
  if (bad.length === 0) return { plot };
  let best: { plot: FarmPlot; distance: number } | null = null;
  for (let dx = -SITE_RADIUS; dx <= SITE_RADIUS; dx += 1) for (let dz = -SITE_RADIUS; dz <= SITE_RADIUS; dz += 1) {
    const distance = Math.hypot(dx, dz);
    if (best !== null && distance >= best.distance) continue;
    const moved = farmPlot({ x: plot.water.x + dx, y: plot.water.y, z: plot.water.z + dz }, plot.size);
    if (problems(moved, area, tags, true).length === 0) best = { plot: moved, distance };
  }
  if (best !== null) return { plot: best.plot };
  return { refusal: `no ground to farm within ${SITE_RADIUS} blocks at y ${plot.water.y}: the plot there is ${bad.join(", ")}; walk to grass or dirt under the open sky and farm there` };
}

/** Whether a remembered farm still stands on soil: most of its cells farmland or tillable (else it is not tended again). */
export async function farmStandsOnSoil(runtime: BotRuntime, plot: FarmPlot): Promise<boolean> {
  const box = soilBox(plot, 0);
  const area = await runtime.blocksIn(box.min, { ...box.max, y: box.min.y });
  const tags = await tagsOfArea(runtime, area);
  const cells = plot.size * plot.size;
  const wrong = problems(plot, area, tags, false).reduce((sum, entry) => sum + Number.parseInt(entry, 10), 0);
  return wrong * 2 < cells;
}

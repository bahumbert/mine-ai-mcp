import type { BotRuntime } from "../runtime-client.ts";
import { areaKey, type BlockArea } from "../runtime-client.ts";
import { farmPlot, type FarmPlot } from "./plot.ts";

/** How far (blocks, per axis) from the first spot a new farm's middle may be moved to find tillable ground. */
export const SITE_RADIUS = 16;
/** Blocks above the soil that must be free of solid blocks: a farm under a roof or in a cave does not grow. */
export const SKY_HEIGHT = 6;
/** How far above or below the asked soil level another plot's own ground may lie when the site is moved (a slope). */
export const SITE_RISE = 3;
/** The game's own block tag of what a hoe turns into soil (dirt, grass, coarse dirt...), not a list of names here. */
const SOIL_TAG = "dirt";
/** What the runtime reports for a cell of a chunk that is not loaded. */
const UNLOADED = "unloaded";

/** Different cells a till must fail on, with no success in between, before a block name is taken for untillable. */
const REFUSED_AFTER_CELLS = 2;

/**
 * Block names a till failed on, learned from play and shared by every character of the process: the `dirt` tag lists
 * what a hoe may turn into soil only roughly (podzol, mud, moss carry it), so the game's answer to an actual till is
 * what counts. A single failure proves nothing (a block on top, an animal, lag): a name is refused only once it failed
 * on {@link REFUSED_AFTER_CELLS} different cells, and any till that works on it forgets the failures. No name is
 * listed in code.
 */
export class TillFacts {
  /** Per block name, the cells ("x,z") a till failed on since the last one that worked. */
  readonly #failed = new Map<string, Set<string>>();
  /** A till failed on this block at this cell. */
  failed(block: string, cell: { readonly x: number; readonly z: number }): void {
    const cells = this.#failed.get(block) ?? new Set<string>();
    cells.add(`${cell.x},${cell.z}`);
    this.#failed.set(block, cells);
  }
  /** A till worked on this block: it is soil, whatever failed before. */
  tilled(block: string): void {
    this.#failed.delete(block);
  }
  refuses(block: string): boolean {
    return (this.#failed.get(block)?.size ?? 0) >= REFUSED_AFTER_CELLS;
  }
}

type Tags = ReadonlyMap<string, readonly string[]>;
type Ground = { readonly y: number; readonly block: string } | "unknown" | null;

/** A cell whose block is not known: not read (outside the boxes the runtime answered) or in an unloaded chunk. */
function isUnknown(block: string | undefined): boolean {
  return block === undefined || block === UNLOADED;
}

/** Block tags of these names, from the game's data (`view_blocks` lookup); a lookup that fails leaves them untagged. */
async function tagsOf(runtime: BotRuntime, names: Iterable<string>): Promise<Tags> {
  const distinct = [...new Set(names)].filter((name) => !isUnknown(name));
  const kinds = await runtime.blockKinds(distinct).catch(() => ({}) as Awaited<ReturnType<BotRuntime["blockKinds"]>>);
  return new Map(distinct.map((name) => [name, kinds[name]?.tags ?? []]));
}

/** Whether a cell's block is ground a farm can have: farmland, tillable soil, or water in the middle cell only. Air never is. */
function isSoil(block: string, tags: Tags, middle: boolean, facts: TillFacts | undefined): boolean {
  if (block === "farmland" || (middle && block === "water")) return true;
  return facts?.refuses(block) !== true && (tags.get(block) ?? []).includes(SOIL_TAG);
}

/** Whether nothing solid (and no water) stands within {@link SKY_HEIGHT} above the cell. */
function isOpen(area: BlockArea, x: number, y: number, z: number): boolean {
  for (let up = 1; up <= SKY_HEIGHT; up += 1) {
    const block = area.blocks.get(areaKey(x, y + up, z));
    if (block !== undefined && block !== "air" && (block === "water" || area.kinds[block]?.solid === true)) return false;
  }
  return true;
}

/** A column's own ground: its highest solid block (or water) from `top` down to `bottom`; "unknown" when a cell on the way is. */
function groundOf(area: BlockArea, x: number, z: number, bottom: number, top: number): Ground {
  for (let y = top; y >= bottom; y -= 1) {
    const block = area.blocks.get(areaKey(x, y, z));
    if (isUnknown(block)) return "unknown";
    if (block !== undefined && (block === "water" || area.kinds[block]?.solid === true)) return { y, block };
  }
  return null;
}

interface Problems {
  /** What is wrong with the plot's known cells at soil level, counted by block ("8 stone", "9 roofed"). */
  readonly wrong: readonly string[];
  /** Cells whose block is not known (unloaded or not read): never taken for air or for soil. */
  readonly unknown: number;
}

/** What is wrong with the plot's cells at soil level: nothing wrong and nothing unknown when the plot is fit. */
function problems(plot: FarmPlot, area: BlockArea, tags: Tags, newSite: boolean, facts: TillFacts | undefined): Problems {
  const counts = new Map<string, number>();
  let unknown = 0;
  const y = plot.water.y;
  for (let x = plot.min.x; x <= plot.max.x; x += 1) for (let z = plot.min.z; z <= plot.max.z; z += 1) {
    const block = area.blocks.get(areaKey(x, y, z));
    if (block === undefined || isUnknown(block)) {
      unknown += 1;
      continue;
    }
    const middle = x === plot.water.x && z === plot.water.z;
    if (newSite && block === "air") {
      // A hollow one block deep over solid ground is filled with dirt by the leveling; air over air is a pit, not soil.
      const below = area.blocks.get(areaKey(x, y - 1, z));
      if (isUnknown(below)) {
        unknown += 1;
        continue;
      }
      if (area.kinds[below!]?.solid !== true) counts.set("air", (counts.get("air") ?? 0) + 1);
      else if (!isOpen(area, x, y, z)) counts.set("roofed", (counts.get("roofed") ?? 0) + 1);
      continue;
    }
    const reason = !isSoil(block, tags, middle, facts) ? block : newSite && !isOpen(area, x, y, z) ? "roofed" : null;
    if (reason !== null) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return { wrong: [...counts].map(([reason, count]) => `${count} ${reason}`), unknown };
}

const fit = (found: Problems): boolean => found.wrong.length === 0 && found.unknown === 0;

/** The box over a plot (plus `reach` around it): from `from` to `to` blocks away from its soil level. */
function plotBox(plot: FarmPlot, reach: number, from: number, to: number) {
  const y = plot.water.y;
  return { min: { x: plot.min.x - reach, y: y + from, z: plot.min.z - reach }, max: { x: plot.max.x + reach, y: y + to, z: plot.max.z + reach } };
}

/** The blocks at the plot's soil level, the only ones whose tags matter for the plot. */
function soilNames(area: BlockArea, plot: FarmPlot): string[] {
  const names: string[] = [];
  for (let x = plot.min.x; x <= plot.max.x; x += 1) for (let z = plot.min.z; z <= plot.max.z; z += 1) {
    const block = area.blocks.get(areaKey(x, plot.water.y, z));
    if (block !== undefined) names.push(block);
  }
  return names;
}

/**
 * Where a new farm of this size can go: the asked plot when its ground is tillable under the open sky, else the
 * nearest plot within {@link SITE_RADIUS} that is, each at its own column's ground height (a slope is not "no
 * ground"); otherwise why none is. A block name `facts` knows a till failed on is not soil. The asked plot is one small read; the wide box is read once, only when that fails.
 * A cell not loaded is unknown, never air or soil: a plot with one is not chosen.
 */
export async function chooseSite(runtime: BotRuntime, plot: FarmPlot, facts?: TillFacts): Promise<{ readonly plot: FarmPlot } | { readonly refusal: string }> {
  const near = plotBox(plot, 0, -1, SKY_HEIGHT);
  const nearArea = await runtime.blocksIn(near.min, near.max);
  const asked = problems(plot, nearArea, await tagsOf(runtime, soilNames(nearArea, plot)), true, facts);
  if (fit(asked)) return { plot };

  const wide = plotBox(plot, SITE_RADIUS, -SITE_RISE - 1, SITE_RISE + SKY_HEIGHT);
  const area = await runtime.blocksIn(wide.min, wide.max);
  const grounds = new Map<string, Ground>();
  for (let x = wide.min.x; x <= wide.max.x; x += 1) for (let z = wide.min.z; z <= wide.max.z; z += 1) {
    grounds.set(`${x},${z}`, groundOf(area, x, z, plot.water.y - SITE_RISE, plot.water.y + SITE_RISE));
  }
  const tags = await tagsOf(runtime, [...grounds.values()].flatMap((ground) => (ground === null || ground === "unknown" ? [] : [ground.block])));
  let best: { plot: FarmPlot; distance: number } | null = null;
  for (let dx = -SITE_RADIUS; dx <= SITE_RADIUS; dx += 1) for (let dz = -SITE_RADIUS; dz <= SITE_RADIUS; dz += 1) {
    const distance = Math.hypot(dx, dz);
    if (best !== null && distance >= best.distance) continue;
    const [x, z] = [plot.water.x + dx, plot.water.z + dz];
    const ground = grounds.get(`${x},${z}`);
    if (ground === undefined || ground === null || ground === "unknown") continue;
    const moved = farmPlot({ x, y: ground.y, z }, plot.size);
    if (fit(problems(moved, area, tags, true, facts))) best = { plot: moved, distance };
  }
  if (best !== null) return { plot: best.plot };
  const why = [...asked.wrong, ...(asked.unknown > 0 ? [`${asked.unknown} not loaded`] : [])].join(", ");
  return { refusal: `no ground to farm within ${SITE_RADIUS} blocks around y ${plot.water.y}: the plot there is ${why}; walk to grass or dirt under the open sky and farm there` };
}

/**
 * Whether a remembered farm still stands on soil: most of its cells farmland or tillable (else it is not tended
 * again). A cell not loaded is not known to be wrong, so a farm out of reach is kept, not replaced.
 */
export async function farmStandsOnSoil(runtime: BotRuntime, plot: FarmPlot, facts?: TillFacts): Promise<boolean> {
  const box = plotBox(plot, 0, 0, 0);
  const area = await runtime.blocksIn(box.min, box.max);
  const tags = await tagsOf(runtime, soilNames(area, plot));
  const wrong = problems(plot, area, tags, false, facts).wrong.reduce((sum, entry) => sum + Number.parseInt(entry, 10), 0);
  return wrong * 2 < plot.size * plot.size;
}

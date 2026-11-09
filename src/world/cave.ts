/** Cave classification using a budgeted, per-column view of loaded cells. */
import type { Bot } from "mineflayer";
import { cellHoldsWater, isPassable, liveBlockReader, type BlockPosition, type LoadedBlock, type WorldView } from "../navigation/index.js";
import { heightHint } from "./height-hints.js";
import { columnRevision } from "./column-changes.js";
import { treePartTest } from "./target-situation.js";

export const CAVE_AIR_MIN = 2; // owner 2026-11-08
export const CAVE_ROOF_MIN = 4; // owner 2026-11-08
export const CAVE_REACH = 3; // owner 2026-11-08
export const CAVE_READS_PER_SCAN = 512; // 4096 reads took 21.85 ms (187 reads/ms), WSL 2026-11-08

export interface CaveReader {
  beginScan(): void;
  inCave(cell: BlockPosition): boolean | null;
  caveTarget(target: BlockPosition): boolean | null;
}

interface Column {
  readonly revision: string;
  next: number;
  surface: number | null;
  readonly air: { low: number; high: number }[];
}

interface ColumnWorld {
  getColumn(x: number, z: number): { minY: number; sections: readonly { solidBlockCount: number }[] } | undefined;
}

/** The top of the highest section containing any non-air cell, or null for an unloaded chunk. */
function columnTop(bot: Bot, x: number, z: number): number | null {
  const world = bot.world as unknown as ColumnWorld;
  const column = world.getColumn(x >> 4, z >> 4);
  if (!column) return null;
  for (let i = column.sections.length - 1; i >= 0; i--) {
    if (column.sections[i]!.solidBlockCount > 0) return column.minY + (i + 1) * 16 - 1;
  }
  return column.minY - 1;
}

/** Extend the last air run downward, or start a new run after a solid cell. */
function rememberAir(column: Column, y: number, air: boolean): void {
  if (!air) return;
  const last = column.air.at(-1);
  if (last?.low === y + 1) last.low = y;
  else column.air.push({ low: y, high: y });
}

/** Intersect dry two-high cave bases with a requested range, excluding the target cell itself. */
function caveInRange(column: Column, low: number, high: number, excludedY?: number): boolean {
  if (column.surface === null) return false;
  const roofLimit = column.surface - CAVE_ROOF_MIN - 1;
  return column.air.some((run) => {
    const first = Math.max(low, run.low);
    const last = Math.min(high, run.high - 1, roofLimit);
    return first <= last && (first !== excludedY || last !== excludedY);
  });
}

/** Read and memoize one column, resuming a partial walk after the next scan. */
function readColumn(column: Column, cell: BlockPosition, range: { high: number; excludedY?: number }, minY: number, read: (x: number, y: number, z: number) => LoadedBlock | null, isTree: (block: LoadedBlock) => boolean): boolean | null {
  // The hint (or a partial surface walk) is already an upper bound; no block read can raise it.
  if ((column.surface ?? column.next) < cell.y + CAVE_AIR_MIN - 1 + CAVE_ROOF_MIN) return false;
  while (column.surface === null && column.next >= minY) {
    const block = read(cell.x, column.next, cell.z);
    if (block === null) return null;
    const y = column.next--;
    if (!isPassable(block) && !cellHoldsWater(block) && !isTree(block)) {
      column.surface = y;
    }
  }
  column.surface ??= minY - 1;
  if (column.surface < cell.y + CAVE_AIR_MIN - 1 + CAVE_ROOF_MIN) return false;
  while (column.next >= cell.y) {
    const block = read(cell.x, column.next, cell.z);
    if (block === null) return caveInRange(column, cell.y, range.high, range.excludedY) || null;
    rememberAir(column, column.next--, isPassable(block) && !cellHoldsWater(block));
  }
  return caveInRange(column, cell.y, range.high, range.excludedY);
}

interface ReadBounds { minX: number; maxX: number; minZ: number; maxZ: number; caveMinX: number; caveMaxX: number; caveMinZ: number; caveMaxZ: number }

/** Summarize memoized columns when no further cells can be read in this scan. */
function readBounds(columns: ReadonlyMap<string, Column>): ReadBounds {
  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, caveMinX: Infinity, caveMaxX: -Infinity, caveMinZ: Infinity, caveMaxZ: -Infinity };
  for (const [key, column] of columns) {
    const [x, z] = key.split(",").map(Number) as [number, number];
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minZ = Math.min(bounds.minZ, z); bounds.maxZ = Math.max(bounds.maxZ, z);
    if (column.surface !== null && column.air.some((run) => run.high > run.low && run.low + 1 + CAVE_ROOF_MIN <= column.surface!)) {
      bounds.caveMinX = Math.min(bounds.caveMinX, x); bounds.caveMaxX = Math.max(bounds.caveMaxX, x);
      bounds.caveMinZ = Math.min(bounds.caveMinZ, z); bounds.caveMaxZ = Math.max(bounds.caveMaxZ, z);
    }
  }
  return bounds;
}

/** An unvisited column outside the memo bounds is unknown, when no known cave can win. */
function certainlyUnknown(bounds: ReadBounds, target: BlockPosition): boolean {
  const caveOutside = target.x + CAVE_REACH < bounds.caveMinX || target.x - CAVE_REACH > bounds.caveMaxX || target.z + CAVE_REACH < bounds.caveMinZ || target.z - CAVE_REACH > bounds.caveMaxZ;
  return caveOutside && (target.x - CAVE_REACH < bounds.minX || target.x + CAVE_REACH > bounds.maxX || target.z - CAVE_REACH < bounds.minZ || target.z + CAVE_REACH > bounds.maxZ);
}

interface CaveOptions { read?: WorldView["blockAt"]; readsPerScan?: number; heightHint?: (x: number, z: number) => number | null }

/** Keep column revisions and target answers local to one synchronous scan. */
class CaveScan implements CaveReader {
  readonly #columns = new Map<string, Column>();
  readonly #scanColumns = new Map<number, Map<number, Column | null>>();
  readonly #targets = new Map<string, boolean>();
  readonly #read: WorldView["blockAt"];
  readonly #hint: (x: number, z: number) => number | null;
  readonly #isTree: (block: LoadedBlock) => boolean;
  readonly #revision: ReturnType<typeof columnRevision>;
  readonly #minY: number;
  readonly #budget: number;
  #remaining: number;
  #exhaustedBounds: ReadBounds | undefined;

  constructor(private readonly bot: Bot, options: CaveOptions) {
    this.#read = options.read ?? liveBlockReader(bot);
    this.#hint = options.heightHint ?? heightHint(bot);
    this.#isTree = treePartTest(bot);
    this.#revision = columnRevision(bot);
    this.#minY = (bot.game as typeof bot.game & { minY: number }).minY;
    this.#remaining = this.#budget = options.readsPerScan ?? CAVE_READS_PER_SCAN;
  }

  beginScan(): void {
    this.#remaining = this.#budget;
    this.#exhaustedBounds = undefined;
    this.#scanColumns.clear();
    this.#targets.clear();
  }

  readonly #readCell = (x: number, y: number, z: number): LoadedBlock | null => {
    if (this.#remaining <= 0) return null;
    this.#remaining--;
    const block = this.#read(x, y, z);
    return block.kind === "loaded" ? block : null;
  };

  /** Validate a memoized column once, even when many targets share it. */
  private columnAt(x: number, z: number): Column | null {
    let line = this.#scanColumns.get(x);
    const cached = line?.get(z);
    if (cached !== undefined) return cached;
    if (!line) { line = new Map(); this.#scanColumns.set(x, line); }
    const key = `${x},${z}`;
    let column = this.#columns.get(key);
    const currentRevision = this.#revision(x, z);
    if (column && column.revision !== currentRevision) { this.#columns.delete(key); column = undefined; }
    if (!column) {
      const top = this.#hint(x, z);
      const start = top === null ? columnTop(this.bot, x, z) : top - 1;
      if (start === null) { line.set(z, null); return null; }
      column = { next: start, surface: null, air: [], revision: currentRevision };
      this.#columns.set(key, column);
    }
    line.set(z, column);
    return column;
  }

  /** Warm ranges need only the memo's roof bound and air runs; allocate read coordinates only when extending it. */
  private inRange(x: number, z: number, low: number, high: number, excludedY?: number): boolean | null {
    const column = this.columnAt(x, z);
    if (column === null) return null;
    if ((column.surface ?? column.next) < low + CAVE_AIR_MIN - 1 + CAVE_ROOF_MIN) return false;
    if (column.next < low) return caveInRange(column, low, high, excludedY);
    return readColumn(column, { x, y: low, z }, { high, ...(excludedY !== undefined && { excludedY }) }, this.#minY, this.#readCell, this.#isTree);
  }

  inCave(cell: BlockPosition): boolean | null {
    return this.inRange(cell.x, cell.z, cell.y, cell.y);
  }

  caveTarget(target: BlockPosition): boolean | null {
    const key = `${target.x},${target.y},${target.z}`;
    const cached = this.#targets.get(key);
    if (cached !== undefined) return cached;
    if (this.#remaining <= 0 && certainlyUnknown(this.#exhaustedBounds ??= readBounds(this.#columns), target)) return null;
    let unknown = false;
    for (let x = target.x - CAVE_REACH; x <= target.x + CAVE_REACH; x++) {
      for (let z = target.z - CAVE_REACH; z <= target.z + CAVE_REACH; z++) {
        const cave = this.inRange(x, z, target.y - CAVE_REACH, target.y + CAVE_REACH,
          x === target.x && z === target.z ? target.y : undefined);
        if (cave === true) { this.#targets.set(key, true); return true; }
        if (cave === null) unknown = true;
      }
    }
    // An unknown range can become known if another query extends its column in this scan.
    if (unknown) return null;
    this.#targets.set(key, false);
    return false;
  }
}

/** A reader whose memo lasts across scans; reads are capped independently for each scan. */
export function caveReader(bot: Bot, options: CaveOptions = {}): CaveReader {
  return new CaveScan(bot, options);
}

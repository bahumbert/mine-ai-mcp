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

/** Read and memoize one column, resuming a partial walk after the next scan. */
function readColumn(column: Column, cell: BlockPosition, minY: number, read: (x: number, y: number, z: number) => LoadedBlock | null, isTree: (block: LoadedBlock) => boolean): boolean | null {
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
    if (block === null) return null;
    rememberAir(column, column.next--, isPassable(block) && !cellHoldsWater(block));
  }
  return column.air.some((run) => run.low <= cell.y && run.high >= cell.y + 1);
}

/** Classify the nearby cells in one vertical line around a target. */
function caveOnLine(inCave: CaveReader["inCave"], target: BlockPosition, x: number, z: number): boolean | null {
  let unknown = false;
  for (let y = target.y - CAVE_REACH; y <= target.y + CAVE_REACH; y++) {
    if (x === target.x && y === target.y && z === target.z) continue;
    const cave = inCave({ x, y, z });
    if (cave === true) return true;
    if (cave === null) unknown = true;
  }
  return unknown ? null : false;
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

/** A reader whose memo lasts across scans; reads are capped independently for each scan. */
export function caveReader(bot: Bot, options: { read?: WorldView["blockAt"]; readsPerScan?: number; heightHint?: (x: number, z: number) => number | null } = {}): CaveReader {
  const read = options.read ?? liveBlockReader(bot);
  const hint = options.heightHint ?? heightHint(bot);
  const isTree = treePartTest(bot);
  const minY = (bot.game as typeof bot.game & { minY: number }).minY;
  const columns = new Map<string, Column>();
  const revision = columnRevision(bot);
  const budget = options.readsPerScan ?? CAVE_READS_PER_SCAN;
  let remaining = budget;
  let exhaustedBounds: ReadBounds | undefined;
  const readCell = (x: number, y: number, z: number): LoadedBlock | null => {
    if (remaining <= 0) return null;
    remaining--;
    const block = read(x, y, z);
    return block.kind === "loaded" ? block : null;
  };
  const inCave = (cell: BlockPosition): boolean | null => {
    const key = `${cell.x},${cell.z}`;
    let column = columns.get(key);
    const currentRevision = revision(cell.x, cell.z);
    if (column && column.revision !== currentRevision) { columns.delete(key); column = undefined; }
    if (!column) {
      const top = hint(cell.x, cell.z);
      const start = top === null ? columnTop(bot, cell.x, cell.z) : top - 1;
      if (start === null) return null;
      column = { next: start, surface: null, air: [], revision: currentRevision };
      columns.set(key, column);
    }
    return readColumn(column, cell, minY, readCell, isTree);
  };
  return {
    beginScan: () => { remaining = budget; exhaustedBounds = undefined; },
    inCave,
    caveTarget(target) {
      if (remaining <= 0 && certainlyUnknown(exhaustedBounds ??= readBounds(columns), target)) return null;
      let unknown = false;
      for (let x = target.x - CAVE_REACH; x <= target.x + CAVE_REACH; x++) {
        for (let z = target.z - CAVE_REACH; z <= target.z + CAVE_REACH; z++) {
          const cave = caveOnLine(inCave, target, x, z);
          if (cave === true) return true;
          if (cave === null) unknown = true;
        }
      }
      return unknown ? null : false;
    },
  };
}

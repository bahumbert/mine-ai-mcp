/**
 * The fake world's chunk columns: which chunks are loaded, and real Prismarine columns built from the cells, as
 * `WorldSync` answers them (`prismarine-world/src/worldsync.js:78-82`).
 */
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

const require = createRequire(import.meta.url);

/**
 * The chunks a server with `view-distance=8` (Mine Labs') sent a bot standing still, measured by `columns-hold-cells`
 * on 2026-10-23: the 19 x 19 square of radius 9 with its corners cut, 329 chunks, the farthest at a squared distance
 * of 113 (the next ring step is 117). A server with another view distance sends another count: a test that needs one
 * names `loadedColumns`.
 */
export const DEFAULT_LOADED_CHUNK_RADIUS = 9;
export const DEFAULT_LOADED_CHUNK_REACH_SQUARED = 113;

/** A chunk by its x and z index (block coordinate floor-divided by 16). */
export type ChunkCoords = readonly [number, number];

/** The dimension's floor and height, as `bot.game.minY` and `bot.game.height` hold them. */
export interface DimensionRange {
  readonly minY: number;
  readonly height: number;
}

/** What the world reads of a prismarine-chunk column (the library ships no typings). */
export interface FakeColumn {
  readonly minY: number;
  readonly worldHeight: number;
  readonly sections: unknown[];
  readonly maxBitsPerBlock: number;
  getBlockStateId(position: Vec3): number;
  setBlockStateId(position: Vec3, stateId: number): void;
}

/** A column as `WorldSync.getColumns` lists it: `Object.entries` of the column map, so the coordinates are strings. */
export interface ListedColumn {
  readonly chunkX: string;
  readonly chunkZ: string;
  readonly column: FakeColumn;
}

interface ChunkClass {
  new (options?: { minY?: number; worldHeight?: number }): FakeColumn;
  /** Present from 1.18 on: the section class, which can be made already full of one block. */
  section?: new (options: Record<string, unknown>) => unknown;
}

export const chunkIndexOf = (blockCoordinate: number): number => Math.floor(blockCoordinate) >> 4;

/** One number per chunk (z in a 2^26 window), so a read of the loaded set builds no string. */
const CHUNK_KEY_STRIDE = 2 ** 26;
export const chunkKeyOf = (chunkX: number, chunkZ: number): number => chunkX * CHUNK_KEY_STRIDE + chunkZ;

/** The chunks the bot has been sent: the ones `blockAt` answers in. */
export interface LoadedChunks {
  has(chunkX: number, chunkZ: number): boolean;
  /** Lists a chunk (a `setCell` into one the server had not sent); false when it was listed already. */
  add(chunkX: number, chunkZ: number): boolean;
  list(): readonly ChunkCoords[];
}

export interface LoadedChunksOptions {
  /** The feet, whose chunk the default square is centred on. */
  readonly feet: { readonly x: number; readonly z: number };
  /** Exactly these chunks; omitted: the square around the feet plus `namedChunks`. */
  readonly loadedColumns?: readonly ChunkCoords[];
  /** The chunks holding a named cell that is not `"void"`. */
  readonly namedChunks: Iterable<ChunkCoords>;
}

export function createLoadedChunks({ feet, loadedColumns, namedChunks }: LoadedChunksOptions): LoadedChunks {
  const chunks = new Map<number, ChunkCoords>();
  const add = (chunkX: number, chunkZ: number) => {
    const key = chunkKeyOf(chunkX, chunkZ);
    if (chunks.has(key)) return false;
    chunks.set(key, [chunkX, chunkZ]);
    return true;
  };
  if (loadedColumns !== undefined) {
    for (const [chunkX, chunkZ] of loadedColumns) add(chunkX, chunkZ);
  } else {
    const centre: ChunkCoords = [chunkIndexOf(feet.x), chunkIndexOf(feet.z)];
    for (let dx = -DEFAULT_LOADED_CHUNK_RADIUS; dx <= DEFAULT_LOADED_CHUNK_RADIUS; dx++) {
      for (let dz = -DEFAULT_LOADED_CHUNK_RADIUS; dz <= DEFAULT_LOADED_CHUNK_RADIUS; dz++) {
        if (dx * dx + dz * dz <= DEFAULT_LOADED_CHUNK_REACH_SQUARED) add(centre[0] + dx, centre[1] + dz);
      }
    }
    for (const [chunkX, chunkZ] of namedChunks) add(chunkX, chunkZ);
  }
  return { has: (chunkX, chunkZ) => chunks.has(chunkKeyOf(chunkX, chunkZ)), add, list: () => [...chunks.values()] };
}

/** A named cell as a column holds it: its place in the world and the state id (air for a `"void"` cell). */
export type ColumnCell = readonly [x: number, y: number, z: number, stateId: number];

/** What a column is built from. */
export interface ColumnContent {
  readonly range: () => DimensionRange;
  /** Stone at and below this level; null for open air. */
  readonly groundY: number | null;
  readonly groundStateId: number;
  namedCells(chunkX: number, chunkZ: number): Iterable<ColumnCell>;
}

/** The fake's columns, built on first use and then changed in place by `setCell`, as `WorldSync` changes the column it stores. */
export interface FakeColumns {
  getColumn(chunkX: number, chunkZ: number): FakeColumn | undefined;
  getColumns(): ListedColumn[];
  /** A cell changed: the built column of its chunk, if any, holds the new state (a `VOID` cell as air). */
  setBlockStateId(x: number, y: number, z: number, stateId: number): void;
}

const SECTION_HEIGHT = 16;

/** The ground of one section: a section wholly under the ground is made full of it, a section across it is set cell by cell. */
function fillGround(Chunk: ChunkClass, column: FakeColumn, range: DimensionRange, content: ColumnContent): void {
  if (content.groundY === null) return;
  const cursor = new Vec3(0, 0, 0);
  const sectionCount = range.height / SECTION_HEIGHT;
  for (let index = 0; index < sectionCount; index++) {
    const sectionMinY = range.minY + index * SECTION_HEIGHT;
    if (sectionMinY > content.groundY) return;
    if (Chunk.section !== undefined && sectionMinY + SECTION_HEIGHT - 1 <= content.groundY) {
      const first = column.sections[0] as { noSizePrefix?: boolean; hasFluidCount?: boolean };
      column.sections[index] = new Chunk.section({
        singleValue: content.groundStateId,
        noSizePrefix: first.noSizePrefix,
        hasFluidCount: first.hasFluidCount,
        maxBitsPerBlock: column.maxBitsPerBlock,
      });
      continue;
    }
    for (cursor.y = sectionMinY; cursor.y < sectionMinY + SECTION_HEIGHT && cursor.y <= content.groundY; cursor.y++) {
      for (cursor.z = 0; cursor.z < 16; cursor.z++) {
        for (cursor.x = 0; cursor.x < 16; cursor.x++) column.setBlockStateId(cursor, content.groundStateId);
      }
    }
  }
}

function buildColumn(Chunk: ChunkClass, content: ColumnContent, chunkX: number, chunkZ: number): FakeColumn {
  const range = content.range();
  const column = new Chunk({ minY: range.minY, worldHeight: range.height });
  fillGround(Chunk, column, range, content);
  const cursor = new Vec3(0, 0, 0);
  for (const [x, y, z, stateId] of content.namedCells(chunkX, chunkZ)) {
    column.setBlockStateId(cursor.set(x & 15, y, z & 15), stateId);
  }
  return column;
}

/** Building the class costs about a millisecond and a harness is made per test, so it is kept per version. */
const chunkClasses = new Map<string, ChunkClass>();
function chunkClassOf(registry: Bot["registry"]): ChunkClass {
  const version = String(registry.version.minecraftVersion);
  let Chunk = chunkClasses.get(version);
  if (Chunk === undefined) {
    Chunk = (require("prismarine-chunk") as (registry: Bot["registry"]) => ChunkClass)(registry);
    chunkClasses.set(version, Chunk);
  }
  return Chunk;
}

export function createFakeColumns(registry: Bot["registry"], loaded: LoadedChunks, content: ColumnContent): FakeColumns {
  const Chunk = chunkClassOf(registry);
  const built = new Map<number, FakeColumn>();
  const getColumn = (chunkX: number, chunkZ: number) => {
    if (!loaded.has(chunkX, chunkZ)) return undefined;
    const key = chunkKeyOf(chunkX, chunkZ);
    let column = built.get(key);
    if (column === undefined) {
      column = buildColumn(Chunk, content, chunkX, chunkZ);
      built.set(key, column);
    }
    return column;
  };
  return {
    getColumn,
    getColumns: () => loaded.list().map(([chunkX, chunkZ]) => ({ chunkX: String(chunkX), chunkZ: String(chunkZ), column: getColumn(chunkX, chunkZ)! })),
    setBlockStateId(x, y, z, stateId) {
      built.get(chunkKeyOf(chunkIndexOf(x), chunkIndexOf(z)))?.setBlockStateId(new Vec3(x & 15, y, z & 15), stateId);
    },
  };
}

/** The floor and height a column has when the world is given none: prismarine-chunk's own default for the version. */
export function defaultDimensionRange(registry: Bot["registry"]): DimensionRange {
  const probe = new (chunkClassOf(registry))();
  return { minY: probe.minY ?? 0, height: probe.worldHeight ?? 256 };
}

/** A cell in a chunk the bot has not loaded; its column holds air there. */
export const VOID = "void";

/** The state of a named cell: a block's state id, or `VOID`. */
export type CellState = number | typeof VOID;

/** The named cells by cell key, and by chunk: a column is built from the cells of its chunk alone. */
export interface ChunkedCells {
  get(key: string): CellState | undefined;
  set(key: string, state: CellState): void;
  keys(): IterableIterator<string>;
  /** The chunks that hold a named cell that is not `VOID`. */
  chunksOfBlocks(): readonly ChunkCoords[];
  inChunk(chunkX: number, chunkZ: number): Iterable<ColumnCell>;
}

const cellFromKey = (key: string): [number, number, number] => key.split(",").map(Number) as [number, number, number];

export function createChunkedCells(): ChunkedCells {
  const states = new Map<string, CellState>();
  const keysByChunk = new Map<number, Set<string>>();
  return {
    get: (key) => states.get(key),
    set(key, state) {
      states.set(key, state);
      const [x, , z] = cellFromKey(key);
      const chunk = chunkKeyOf(chunkIndexOf(x), chunkIndexOf(z));
      keysByChunk.set(chunk, (keysByChunk.get(chunk) ?? new Set()).add(key));
    },
    keys: () => states.keys(),
    chunksOfBlocks() {
      const chunks = new Map<number, ChunkCoords>();
      for (const [key, state] of states) {
        if (state === VOID) continue;
        const [x, , z] = cellFromKey(key);
        chunks.set(chunkKeyOf(chunkIndexOf(x), chunkIndexOf(z)), [chunkIndexOf(x), chunkIndexOf(z)]);
      }
      return [...chunks.values()];
    },
    *inChunk(chunkX, chunkZ) {
      for (const key of keysByChunk.get(chunkKeyOf(chunkX, chunkZ)) ?? []) {
        const [x, y, z] = cellFromKey(key);
        const state = states.get(key)!;
        yield [x, y, z, state === VOID ? 0 : state];
      }
    },
  };
}

/** Throws naming a cell the game could not hold: it keeps no block below the dimension's floor or at and above its top. */
export function assertWithinRange(range: DimensionRange, key: string): void {
  const y = cellFromKey(key)[1];
  if (y < range.minY || y >= range.minY + range.height) {
    throw new Error(`cell ${key} is outside the dimension (y ${range.minY}..${range.minY + range.height - 1}): the game keeps no block there`);
  }
}

/**
 * The dimension's range, asked on first use: a bot's `game` is made after its world. Every named cell is checked
 * then, so a cell outside the range throws at the first read or at construction when no `heights` is given.
 */
export function lazyRange(registry: Bot["registry"], heights: (() => DimensionRange) | undefined, cells: Pick<ChunkedCells, "keys">): () => DimensionRange {
  let known: DimensionRange | undefined;
  const range = () => {
    if (known === undefined) {
      known = heights?.() ?? defaultDimensionRange(registry);
      for (const key of cells.keys()) assertWithinRange(known, key);
    }
    return known;
  };
  if (heights === undefined) range();
  return range;
}

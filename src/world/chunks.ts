import type { Position3 } from "../utils/index.js";

export const CHUNK_WIDTH = 16;

export interface ChunkPosition {
  readonly chunkX: number;
  readonly chunkZ: number;
}

/** Return the chunk coordinate containing one block coordinate, including west and north of zero. */
export function chunkCoordinate(blockCoordinate: number): number {
  return Math.floor(blockCoordinate / CHUNK_WIDTH);
}

/** Return the chunk containing one horizontal world position. */
export function chunkPosition(position: Pick<Position3, "x" | "z">): ChunkPosition {
  return {
    chunkX: chunkCoordinate(position.x),
    chunkZ: chunkCoordinate(position.z),
  };
}

export interface LoadedColumnEntry<Column> {
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly column: Column;
}

/** One chunk coordinate of a `getColumns()` entry as a number; throws naming the entry when it is not an integer. */
function integerChunkCoordinate(entry: { chunkX: unknown; chunkZ: unknown }, axis: "chunkX" | "chunkZ"): number {
  const value = entry[axis];
  const text = typeof value === "string" && /^-?\d+$/.test(value) ? value : undefined;
  const number = typeof value === "number" ? value : text === undefined ? Number.NaN : Number(text);
  if (Number.isSafeInteger(number)) return number;
  const shown = (part: unknown) => JSON.stringify(part) ?? String(part);
  throw new Error(
    `getColumns() entry has no safe integer ${axis}: ${axis} is ${shown(value)} (chunkX ${shown(entry.chunkX)}, ` +
      `chunkZ ${shown(entry.chunkZ)}). prismarine-world's column list changed: fix loadedColumns in src/world/chunks.ts.`,
  );
}

/**
 * `world.getColumns()` with its chunk coordinates as numbers: Prismarine-world hands them over as strings
 * (`prismarine-world/src/world.js:195-203`; contract check `columns-hold-cells`), so `chunkX + 1` is `"31"`, not 4.
 * A coordinate that is not an integer throws: a Prismarine change must fail loudly, not record chunk `NaN`.
 */
export function loadedColumns<Column>(
  world: { getColumns(): readonly { chunkX: unknown; chunkZ: unknown; column: unknown }[] },
): LoadedColumnEntry<Column>[] {
  return world.getColumns().map((entry) => ({
    chunkX: integerChunkCoordinate(entry, "chunkX"),
    chunkZ: integerChunkCoordinate(entry, "chunkZ"),
    // Prismarine's own typing omits the 1.18+ column fields; the caller names the shape it reads.
    column: entry.column as Column,
  }));
}

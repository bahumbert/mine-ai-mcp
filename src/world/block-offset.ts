/**
 * Vanilla moves some blocks sideways inside their cell by an amount that depends on the cell's x and z (bamboo,
 * pointed dripstone). The server collides players with the moved box; minecraft-data gives one box per state for every
 * position. This module computes the offset and finds which blocks have it, from the game data alone.
 */

/** The part of a prismarine registry this module reads (`bot.registry` and `minecraft-data` both fit). */
export interface OffsetRegistry {
  readonly blockCollisionShapes?: {
    readonly blocks: Record<string, number | number[]>;
    readonly shapes: Record<string, number[][]>;
  };
}

/** Block name to the largest sideways offset in metres the game applies to it. */
export type OffsetBlocks = ReadonlyMap<string, number>;

const SHAPE_EPSILON = 1e-9;
/** Vanilla's default maximum sideways offset; a block's own maximum is never read from the data above it. */
const DEFAULT_MAX_OFFSET = 0.25;

/**
 * Vanilla `Mth.getSeed(x, y, z)`: the `x` product is a 32-bit int (it wraps beyond |x| 686), the rest is 64-bit and the
 * final shift keeps the sign.
 */
export function vanillaPositionSeed(x: number, y: number, z: number): bigint {
  let seed = BigInt(Math.imul(x, 3129871)) ^ (BigInt(z) * 116129781n) ^ BigInt(y);
  seed = BigInt.asIntN(64, seed);
  seed = BigInt.asIntN(64, seed * seed * 42317861n + seed * 11n);
  return seed >> 16n;
}

/**
 * Vanilla's `OffsetType.XZ` function: the cell's sideways offset in metres, each axis clamped to `±max`. It takes no y:
 * the seed uses y 0, so a whole column of stalks shares one offset.
 */
export function horizontalOffset(max: number, x: number, z: number): { readonly x: number; readonly z: number } {
  const seed = vanillaPositionSeed(x, 0, z);
  const axis = (nibble: bigint): number => {
    const raw = (Math.fround(Number(nibble) / 15) - 0.5) * 0.5;
    return Math.min(max, Math.max(-max, raw));
  };
  return { x: axis(seed & 15n), z: axis((seed >> 8n) & 15n) };
}

const offsetTables = new WeakMap<object, OffsetBlocks>();

/**
 * The blocks vanilla offsets, with their maximum offset, derived from the collision data: the data's boxes are vanilla's
 * boxes already moved by the offset of cell 0,0,0 (seed 0, both nibbles 0, raw -0.25, clamped to -max), so an offset
 * block is one whose every non-empty state is centred at `0.5 - s` on x and on z with the same `0 < s <= 0.25`, and `s`
 * is its maximum. Built once per registry.
 */
export function offsetBlocks(registry: OffsetRegistry): OffsetBlocks {
  const cached = offsetTables.get(registry);
  if (cached !== undefined) return cached;
  const table = new Map<string, number>();
  const collision = registry.blockCollisionShapes;
  if (collision !== undefined) {
    for (const [name, ids] of Object.entries(collision.blocks)) {
      const shift = sharedShift(Array.isArray(ids) ? ids : [ids], collision.shapes);
      if (shift !== null) table.set(name, shift);
    }
  }
  offsetTables.set(registry, table);
  return table;
}

function sharedShift(shapeIds: readonly number[], shapes: Record<string, number[][]>): number | null {
  let shift: number | null = null;
  for (const id of new Set(shapeIds)) {
    const boxes = shapes[id] ?? [];
    if (boxes.length === 0) continue;
    const centreX = (Math.min(...boxes.map((box) => box[0]!)) + Math.max(...boxes.map((box) => box[3]!))) / 2;
    const centreZ = (Math.min(...boxes.map((box) => box[2]!)) + Math.max(...boxes.map((box) => box[5]!))) / 2;
    const stateShift = 0.5 - centreX;
    if (Math.abs(centreX - centreZ) > SHAPE_EPSILON) return null;
    if (stateShift <= SHAPE_EPSILON || stateShift > DEFAULT_MAX_OFFSET + SHAPE_EPSILON) return null;
    if (shift !== null && Math.abs(shift - stateShift) > SHAPE_EPSILON) return null;
    shift = stateShift;
  }
  return shift;
}

/** One collision box: min x, y, z then max x, y, z. */
export type ShapeBox = [number, number, number, number, number, number];

/** New boxes: the data boxes moved from the origin cell's position to the one of cell `x`, `z`. Never touches `shapes`. */
export function placeShapes(shapes: readonly (readonly number[])[], max: number, x: number, z: number): ShapeBox[] {
  const offset = horizontalOffset(max, x, z);
  const dx = max + offset.x;
  const dz = max + offset.z;
  return shapes.map((box) => [box[0]! + dx, box[1]!, box[2]! + dz, box[3]! + dx, box[4]!, box[5]! + dz]);
}

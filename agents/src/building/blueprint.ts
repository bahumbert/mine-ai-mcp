import { z } from "zod";

/**
 * Material roles (ADR-006): a blueprint says what each cell is for, a style says which block plays that role. `air`
 * cells are dug clear (interior, doorway); cells a blueprint does not list are left as they are.
 */
export const ROLES = ["foundation", "floor", "wall", "pillar", "trim", "roof", "window", "door", "air"] as const;
export type Role = (typeof ROLES)[number];
export type BlockRole = Exclude<Role, "air">;

/** The runtime's `build_structure` limit (src/actions/build-structure/contract.ts `MAX_STRUCTURE_CELLS`). */
export const MAX_BATCH_CELLS = 256;

const index = z.number().int().nonnegative();

/**
 * A structure in its own frame: x to the right, y up (0 = the ground layer the floor replaces), and the front, where
 * the single door is, facing -z. Block states (stairs, log axis, door hinge) are not modelled yet: the runtime's
 * `build_structure` compares block names only.
 */
export const blueprintSchema = z.strictObject({
  name: z.string().min(1),
  size: z.strictObject({ x: index.min(1), y: index.min(1), z: index.min(1) }),
  cells: z.array(z.strictObject({ x: index, y: index, z: index, role: z.enum(ROLES) })).min(1),
}).superRefine((blueprint, context) => {
  const seen = new Set<string>();
  let doors = 0;
  for (const cell of blueprint.cells) {
    const key = `${cell.x},${cell.y},${cell.z}`;
    if (cell.x >= blueprint.size.x || cell.y >= blueprint.size.y || cell.z >= blueprint.size.z) {
      context.addIssue({ code: "custom", message: `cell ${key} is outside the ${blueprint.size.x}x${blueprint.size.y}x${blueprint.size.z} bounds` });
    }
    if (seen.has(key)) context.addIssue({ code: "custom", message: `cell ${key} is listed twice` });
    seen.add(key);
    if (cell.role === "door") doors += 1;
  }
  if (doors !== 1) context.addIssue({ code: "custom", message: `a blueprint has exactly one door cell (the lower half), not ${doors}` });
});

export type Blueprint = z.infer<typeof blueprintSchema>;
export type Palette = Readonly<Record<BlockRole, string>>;

/** Where the door faces once built. */
export type Facing = "north" | "south" | "east" | "west";

export interface WorldCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Block id, or `air` for a cell to dig clear. */
  readonly block: string;
  readonly role: Role;
}

export interface Position {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Local offset from the door → world offset, for each facing (rotations only, never mirrored). */
const ROTATE: Readonly<Record<Facing, (x: number, z: number) => readonly [number, number]>> = {
  north: (x, z) => [x, z],
  south: (x, z) => [-x, -z],
  east: (x, z) => [-z, x],
  west: (x, z) => [z, -x],
};

/** Unit vector a facing points to. */
export const FACING_VECTOR: Readonly<Record<Facing, readonly [number, number]>> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
};

/**
 * Turns a blueprint into world cells: the door cell lands on `door` and the front faces `facing`; each role takes
 * its block from the palette. The upper door half is never listed: the door item places it.
 */
export function placeBlueprint(blueprint: Blueprint, palette: Palette, door: Position, facing: Facing): WorldCell[] {
  const anchor = blueprint.cells.find((cell) => cell.role === "door");
  if (anchor === undefined) throw new Error(`${blueprint.name} has no door`);
  const rotate = ROTATE[facing];
  return blueprint.cells.map((cell) => {
    const [dx, dz] = rotate(cell.x - anchor.x, cell.z - anchor.z);
    return {
      x: door.x + dx,
      y: door.y + cell.y - anchor.y,
      z: door.z + dz,
      block: cell.role === "air" ? "air" : palette[cell.role],
      role: cell.role,
    };
  });
}

export interface MaterialCount {
  readonly item: string;
  readonly count: number;
}

/** Blocks to carry, most needed first; every block used here is placed from the item of the same id. */
export function billOfMaterials(cells: readonly WorldCell[]): MaterialCount[] {
  const counts = new Map<string, number>();
  for (const cell of cells) if (cell.block !== "air") counts.set(cell.block, (counts.get(cell.block) ?? 0) + 1);
  return [...counts].map(([item, count]) => ({ item, count })).sort((a, b) => b.count - a.count || a.item.localeCompare(b.item));
}

/** What the inventory lacks for a bill of materials. */
export function shortfall(bill: readonly MaterialCount[], inventory: readonly { readonly name: string; readonly count: number }[]): MaterialCount[] {
  const carried = new Map<string, number>();
  for (const stack of inventory) carried.set(stack.name, (carried.get(stack.name) ?? 0) + stack.count);
  return bill
    .map(({ item, count }) => ({ item, count: count - (carried.get(item) ?? 0) }))
    .filter((missing) => missing.count > 0);
}

export function describeMaterials(materials: readonly MaterialCount[]): string {
  return materials.map(({ item, count }) => `${count} ${item}`).join(", ");
}

/**
 * Splits cells into `build_structure` calls, one layer each, bottom up (a layer larger than the limit is split). A layer
 * is finished before the next starts: packed together, the first live house raised a wall on terrain the foundation
 * had not yet replaced, sealing that stone in where it could never be dug.
 */
export function batchCells(cells: readonly WorldCell[], max = MAX_BATCH_CELLS): WorldCell[][] {
  const layers = new Map<number, WorldCell[]>();
  for (const cell of cells) layers.set(cell.y, [...(layers.get(cell.y) ?? []), cell]);
  const batches: WorldCell[][] = [];
  for (const y of [...layers.keys()].sort((a, b) => a - b)) {
    const layer = layers.get(y) ?? [];
    for (let start = 0; start < layer.length; start += max) batches.push(layer.slice(start, start + max));
  }
  return batches;
}

/**
 * The `build_structure` calls for a placed blueprint: everything but the door, one layer at a time, with the doorway
 * dug clear so the bot can walk in and out while it works; then every air cell of the blueprint again, because reaching
 * the roof the bot pillars up on scaffold blocks and leaves them in the room it had already cleared (the first live house
 * kept four dirt blocks inside); then the door alone, last. The doorway is not cleared again: a finished house's door
 * stands there, which navigation will not break.
 */
export function buildBatches(cells: readonly WorldCell[], max = MAX_BATCH_CELLS): WorldCell[][] {
  const doors = cells.filter((cell) => cell.role === "door");
  const doorway = doors.flatMap((door): WorldCell[] => [
    { ...door, block: "air", role: "air" },
    { ...door, y: door.y + 1, block: "air", role: "air" },
  ]);
  const body = batchCells([...cells.filter((cell) => cell.role !== "door"), ...doorway], max);
  const air = cells.filter((cell) => cell.role === "air");
  const clearing: WorldCell[][] = [];
  for (let start = 0; start < air.length; start += max) clearing.push(air.slice(start, start + max));
  return [...body, ...clearing, ...(doors.length === 0 ? [] : [doors])];
}

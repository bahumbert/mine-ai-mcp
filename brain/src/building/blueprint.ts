import { z } from "zod";
import { groupEntryOf, supportGroups, type SupportGroup } from "./support.ts";

/**
 * Material roles (ADR-006): a blueprint says what each cell is for, a style says which block plays that role. `air`
 * cells are dug clear (interior, doorway); cells a blueprint does not list are left as they are.
 */
export const ROLES = ["foundation", "floor", "wall", "pillar", "trim", "roof", "window", "door", "accent", "railing", "air"] as const;
export type Role = (typeof ROLES)[number];
export type BlockRole = Exclude<Role, "air">;

/** The roles a house is built with: every role but `air`; `build` may name a block for each. */
export const BUILD_ROLES = ["foundation", "floor", "wall", "pillar", "trim", "roof", "window", "door", "accent", "railing"] as const satisfies readonly BlockRole[];

/** Decorative roles (coloured bands, ladders, fences around a veranda): a palette may leave them out. */
export const OPTIONAL_ROLES = ["accent", "railing"] as const satisfies readonly BlockRole[];
export type OptionalRole = (typeof OPTIONAL_ROLES)[number];
export type RequiredRole = Exclude<BlockRole, OptionalRole>;

/** The roles that hold the house up and shut it: a block for one of these must fill its cell. */
export const STRUCTURAL_ROLES = BUILD_ROLES.slice(0, 6) as readonly BlockRole[];

/** Shapes a cell may take from its role's material: stairs or a slab of the same wood or stone. */
export const SHAPES = ["stairs", "slab"] as const;
export type Shape = (typeof SHAPES)[number];

/** Per role, the blocks a style uses for each shape; a role without one builds the shape as its full block. */
export type Variants = Readonly<Partial<Record<BlockRole, Readonly<Partial<Record<Shape, string>>>>>>;

export const FACINGS = ["north", "south", "east", "west"] as const;

/** The runtime's `build_structure` limit (src/actions/build-structure/contract.ts `MAX_STRUCTURE_CELLS`). */
export const MAX_BATCH_CELLS = 256;

const index = z.number().int().nonnegative();

/**
 * A structure in its own frame: x to the right, y up (0 = the ground layer the floor replaces), and the front, where
 * the single door is, facing -z. Cells may ask block states (ADR-013): a shape with its facing and half, or a log's
 * axis; `build_structure` places and audits them (door hinge is left to Minecraft).
 */
export const blueprintSchema = z.strictObject({
  name: z.string().min(1),
  size: z.strictObject({ x: index.min(1), y: index.min(1), z: index.min(1) }),
  cells: z.array(z.strictObject({
    x: index,
    y: index,
    z: index,
    role: z.enum(ROLES),
    /** Built from the role's stairs or slab variant when the style has one (ADR-013). */
    shape: z.enum(SHAPES).optional(),
    /** In the blueprint frame, where the front (the door side) is north. */
    facing: z.enum(FACINGS).optional(),
    half: z.enum(["top", "bottom"]).optional(),
    axis: z.enum(["x", "y", "z"]).optional(),
  })).min(1),
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
export type Palette = Readonly<Record<RequiredRole, string>> & Readonly<Partial<Record<OptionalRole, string>>>;

/** Where the door faces once built. */
export type Facing = "north" | "south" | "east" | "west";

export interface WorldCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Block id, or `air` for a cell to dig clear. */
  readonly block: string;
  readonly role: Role;
  /** For the door and stairs: the facing Minecraft must give it (`build_structure` places it looking that way). */
  readonly facing?: Facing;
  /** For stairs and slabs: the half (ADR-013). */
  readonly half?: "top" | "bottom";
  /** For logs: the axis they lie along (ADR-013). */
  readonly axis?: "x" | "y" | "z";
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

/** The facing straight back. */
const OPPOSITE: Readonly<Record<Facing, Facing>> = { north: "south", south: "north", east: "west", west: "east" };

/**
 * Turns a blueprint into world cells: the door cell lands on `door` and the front faces `facing`; each role takes
 * its block from the palette. The upper door half is never listed: the door item places it. The door itself faces
 * into the house, as a player hanging it from the doorstep would place it, so it swings along the doorway: hung
 * sideways (the bot's own yaw), its open panel closed the way out and navigation walked into it.
 * A shaped cell takes its role's stairs or slab from `variants`, its facing and axis turned with the site; without a
 * variant it is the role's full block and asks no stair or slab state.
 */
export function placeBlueprint(blueprint: Blueprint, palette: Readonly<Partial<Record<BlockRole, string>>>, door: Position, facing: Facing, variants: Variants = {}): WorldCell[] {
  const anchor = blueprint.cells.find((cell) => cell.role === "door");
  if (anchor === undefined) throw new Error(`${blueprint.name} has no door`);
  const rotate = ROTATE[facing];
  // A direction in the blueprint frame, turned like the offsets; an axis across x and z swaps on a quarter turn.
  const turn = (local: Facing): Facing => {
    const [x, z] = rotate(...FACING_VECTOR[local]);
    return x > 0 ? "east" : x < 0 ? "west" : z > 0 ? "south" : "north";
  };
  const quarter = facing === "east" || facing === "west";
  const paletteBlock = (role: BlockRole): string => {
    const block = palette[role];
    if (block === undefined) throw new Error(`${blueprint.name}: the palette has no block for the role ${role}`);
    return block;
  };
  return blueprint.cells.map((cell): WorldCell => {
    const [dx, dz] = rotate(cell.x - anchor.x, cell.z - anchor.z);
    const position = { x: door.x + dx, y: door.y + cell.y - anchor.y, z: door.z + dz };
    if (cell.role === "air") return { ...position, block: "air", role: "air" };
    if (cell.role === "door") return { ...position, block: paletteBlock("door"), role: "door", facing: OPPOSITE[facing] };
    const shaped = cell.shape === undefined ? undefined : variants[cell.role]?.[cell.shape];
    const block = shaped ?? paletteBlock(cell.role);
    const axis = cell.axis === undefined || cell.axis === "y" || !quarter ? cell.axis : cell.axis === "x" ? "z" : "x";
    // A cell with a shape but no variant is a full block and asks no state; a cell with no shape (a ladder) asks what it names.
    const asksStates = cell.shape === undefined || shaped !== undefined;
    return {
      ...position,
      block,
      role: cell.role,
      ...(asksStates && cell.facing !== undefined && { facing: turn(cell.facing) }),
      ...(asksStates && cell.half !== undefined && { half: cell.half }),
      ...(axis !== undefined && { axis }),
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
 * The cells each call is answerable for: a cell that is in several calls (the door's support sits in its layer's call and
 * again in the door's; an air cell in its layer and in the clearing pass) counts in its last call only, as `buildParts`
 * does, so the bills of the calls add up to the bill of the house.
 */
export function cellsCountedOnce(batches: readonly (readonly WorldCell[])[]): WorldCell[][] {
  const lastCall = new Map<string, number>();
  batches.forEach((batch, index) => batch.forEach((cell) => lastCall.set(`${cell.x},${cell.y},${cell.z}`, index)));
  return batches.map((batch, index) => batch.filter((cell) => lastCall.get(`${cell.x},${cell.y},${cell.z}`) === index));
}

/**
 * Splits cells into `build_structure` calls, one support group each (the layer `y` when no `groups` are given), bottom
 * up. A group is finished before the next starts: packed together, the first live house raised a wall on terrain the
 * foundation had not yet replaced, sealing that stone in where it could never be dug. A group larger than the limit is
 * cut by round (stable), so no cell lands in an earlier call than the cells it rests on; a smaller group keeps its
 * order, the runtime works a call in passes.
 */
export function batchCells(cells: readonly WorldCell[], max = MAX_BATCH_CELLS, groups?: ReadonlyMap<string, SupportGroup>): WorldCell[][] {
  const callOf = new Map<number, WorldCell[]>();
  for (const cell of cells) {
    const group = groupEntryOf(cell, groups)?.group ?? cell.y;
    callOf.set(group, [...(callOf.get(group) ?? []), cell]);
  }
  const roundOf = (cell: WorldCell) => groupEntryOf(cell, groups)?.round ?? 0;
  const batches: WorldCell[][] = [];
  for (const group of [...callOf.keys()].sort((a, b) => a - b)) {
    const members = callOf.get(group) ?? [];
    const ordered = members.length > max ? [...members].sort((a, b) => roundOf(a) - roundOf(b)) : members;
    for (let start = 0; start < ordered.length; start += max) batches.push(ordered.slice(start, start + max));
  }
  return batches;
}

/**
 * The `build_structure` calls for a placed blueprint: everything but the door, one layer at a time, with the doorway
 * dug clear so the bot can walk in and out while it works; then every air cell of the blueprint again, because reaching
 * the roof the bot pillars up on scaffold blocks and leaves them in the room it had already cleared (the first live house
 * kept four dirt blocks inside); then the door alone, last, with the block it stands on: Minecraft drops a door that
 * has nothing under it, and a doorstep dug out after the first layer (live 2026-10-01) left it refused for good. The
 * doorway is not cleared again: a finished house's door stands there, which navigation will not break.
 */
export function buildBatches(cells: readonly WorldCell[], max = MAX_BATCH_CELLS): WorldCell[][] {
  const doors = cells.filter((cell) => cell.role === "door");
  const doorway = doors.flatMap((door): WorldCell[] => [
    { x: door.x, y: door.y, z: door.z, block: "air", role: "air" },
    { x: door.x, y: door.y + 1, z: door.z, block: "air", role: "air" },
  ]);
  const supports = cells.filter((cell) => doors.some((door) => cell.x === door.x && cell.y === door.y - 1 && cell.z === door.z));
  const body = batchCells([...cells.filter((cell) => cell.role !== "door"), ...doorway], max, supportGroups(cells).groups);
  const air = cells.filter((cell) => cell.role === "air");
  const clearing: WorldCell[][] = [];
  for (let start = 0; start < air.length; start += max) clearing.push(air.slice(start, start + max));
  return [...body, ...clearing, ...(doors.length === 0 ? [] : [[...supports, ...doors]])];
}

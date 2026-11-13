// What a cell can rest on, the order cells must go in so each one has a support when it is placed, and the check that a template builds (house templates).
import minecraftData from "minecraft-data";
import { FACING_VECTOR, placeBlueprint, STRUCTURAL_ROLES, type Blueprint, type BlockRole, type Variants, type WorldCell } from "./blueprint.ts";

/** The registry templates are checked against: the server's version (ADR-007), never the newest. */
export const TEMPLATE_REGISTRY_VERSION = "1.21.4";
const registry = minecraftData(TEMPLATE_REGISTRY_VERSION);

/** The `build_structure` call a cell goes in, and its round inside the call (a cell rests on cells of earlier rounds). */
export interface SupportGroup {
  readonly group: number;
  readonly round: number;
}

export interface SupportGroups {
  /** Per cell, by `"x,y,z"`: the call it goes in. A cell resting on nothing has no entry. */
  readonly groups: ReadonlyMap<string, SupportGroup>;
  readonly unsupported: readonly WorldCell[];
}

/** Whether a block can be placed against: the field the runtime's `isSolid` reads (`src/world/placement.ts`). Coarse: fences, slabs, lanterns count. */
export function placeAgainst(block: string): boolean {
  return registry.blocksByName[block]?.boundingBox === "block";
}

const FULL_CUBE_BOX = [0, 0, 0, 1, 1, 1];

/** Whether every state of a block has exactly the one full-cube collision box (planks, glass, hay; not a fence, slab or lantern). */
export function fullCube(block: string): boolean {
  const reference = registry.blockCollisionShapes.blocks[block];
  if (reference === undefined) return false;
  const shapeIds = Array.isArray(reference) ? reference : [reference];
  return shapeIds.every((id) => {
    const boxes = registry.blockCollisionShapes.shapes[id];
    return boxes?.length === 1 && boxes[0]?.every((edge, index) => edge === FULL_CUBE_BOX[index]) === true;
  });
}

const HORIZONTAL_FACINGS = ["north", "south", "west", "east"] as const;
const clingingBlocks = new Map<string, boolean>();

/** Whether `box` is a plate spanning the whole cell but the `thickness` along `facing`'s axis, flush with the face behind `facing`. */
function isPlateBehind(box: readonly number[], facing: (typeof HORIZONTAL_FACINGS)[number]): boolean {
  const [dx, dz] = FACING_VECTOR[facing];
  const axis = dx !== 0 ? 0 : 2;
  const sign = dx !== 0 ? dx : dz;
  const [lo, hi] = [box[axis]!, box[axis + 3]!];
  const flush = sign < 0 ? lo > 0 && hi === 1 : lo === 0 && hi < 1;
  const full = [0, 1, 2].filter((index) => index !== axis).every((index) => box[index] === 0 && box[index + 3] === 1);
  return flush && full;
}

/**
 * Whether the block clings to the face behind its `facing` (a ladder): its horizontal `facing` is the face it was
 * placed against, and in every state of one facing its collision is the one thin plate flush with the cell's face behind
 * it (a door or trapdoor changes shape with `open` or `half`, stairs and gates are no plate). Read from the registry's
 * collision shapes, no list of names; a clinging block with no collision (torch, sign) is not seen. A copy of
 * `clingsBehindFacing` in `src/world/block-states.ts`; `face-fits-agree.test.ts` keeps them one.
 */
export function clingsBehindFacing(block: string): boolean {
  const known = clingingBlocks.get(block);
  if (known !== undefined) return known;
  const clings = computeClings(block);
  clingingBlocks.set(block, clings);
  return clings;
}

function computeClings(block: string): boolean {
  const states = registry.blocksByName[block]?.states ?? [];
  const facingIndex = states.findIndex((state) => state.name === "facing");
  const facing = states[facingIndex];
  const values = facing?.values;
  if (facing === undefined || values === undefined || values.length !== HORIZONTAL_FACINGS.length || !HORIZONTAL_FACINGS.every((name) => values.includes(name))) return false;
  const reference = registry.blockCollisionShapes.blocks[block];
  if (reference === undefined) return false;
  const shapeIds = Array.isArray(reference) ? reference : [reference];
  // State ids run through the properties in order, the last one fastest: the facing changes every `stride` states.
  const stride = states.slice(facingIndex + 1).reduce((product, state) => product * (state.num_values ?? 1), 1);
  return HORIZONTAL_FACINGS.every((name) => {
    const index = values.indexOf(name);
    const shapes = new Set(shapeIds.filter((_, stateIndex) => Math.floor(stateIndex / stride) % values.length === index));
    const [only] = [...shapes];
    const boxes = only === undefined ? undefined : registry.blockCollisionShapes.shapes[only];
    return shapes.size === 1 && boxes?.length === 1 && isPlateBehind(boxes[0]!, name);
  });
}

/**
 * Whether placing against this face (pointing from the support into the cell) gives the cell its asked states: a copy of
 * `faceFits` in `src/navigation/processes/building/build-cell.ts` (the brain imports no `src/` module);
 * `face-fits-agree.test.ts` keeps them one. A block that clings (`clings`, a ladder) is placed against the face behind
 * its facing only: the server refuses its click on any other.
 */
export function faceFits(face: { readonly x: number; readonly y: number; readonly z: number }, cell: { readonly half?: "top" | "bottom"; readonly axis?: "x" | "y" | "z"; readonly facing?: (typeof HORIZONTAL_FACINGS)[number] }, clings = false): boolean {
  if (clings && cell.facing !== undefined) {
    const [dx, dz] = FACING_VECTOR[cell.facing];
    if (face.x !== dx || face.y !== 0 || face.z !== dz) return false;
  }
  if (cell.axis !== undefined && (cell.axis === "x" ? face.x : cell.axis === "y" ? face.y : face.z) === 0) return false;
  if (cell.half === "top" && face.y > 0) return false;
  if (cell.half === "bottom" && face.y < 0) return false;
  return true;
}

/**
 * The cell as it asks states: the facing, half (a slab's `type`) and axis its block has a property for, never one it
 * lacks (planks with an `axis`: the audit would read the cell wrong for ever). Task 7b bug 2.
 */
export function withStatesItHas(cell: WorldCell): WorldCell {
  const names = new Set((registry.blocksByName[cell.block]?.states ?? []).map((state) => state.name));
  const { facing, half, axis, ...rest } = cell;
  return {
    ...rest,
    ...(facing !== undefined && names.has("facing") && { facing }),
    ...(half !== undefined && (names.has("half") || names.has("type")) && { half }),
    ...(axis !== undefined && names.has("axis") && { axis }),
  };
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** The group and round of a cell, undefined for an air cell (it keeps its layer: the doorway's air shares its key with the door, whose group is its support's) or one with no entry. */
export function groupEntryOf(cell: WorldCell, groups: ReadonlyMap<string, SupportGroup> | undefined): SupportGroup | undefined {
  return cell.role === "air" ? undefined : groups?.get(key(cell.x, cell.y, cell.z));
}

/** Floor first, as the runtime looks for a support. */
const SUPPORT_OFFSETS = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]] as const;

/** A cell left as air (a role `air`, or a block `air` a temporary house asks for) is dug, never placed. */
const isDug = (cell: WorldCell) => cell.role === "air" || cell.block === "air";

/** The cells the engine places, the lowest layer and the footprint of the structure. */
interface Layout {
  readonly listed: ReadonlySet<string>;
  readonly lowest: number;
  readonly footprint: { readonly x0: number; readonly x1: number; readonly z0: number; readonly z1: number };
}

function layoutOf(cells: readonly WorldCell[], placed: readonly WorldCell[]): Layout {
  const xs = cells.map((cell) => cell.x);
  const zs = cells.map((cell) => cell.z);
  return {
    listed: new Set(cells.map((cell) => key(cell.x, cell.y, cell.z))),
    lowest: Math.min(...placed.map((cell) => cell.y)),
    footprint: { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) },
  };
}

/** Whether the terrain holds a cell at `x,y,z`: under the lowest layer, or a lowest-layer cell left unlisted inside the footprint (both are leveled). */
function isGround(layout: Layout, x: number, y: number, z: number): boolean {
  if (y === layout.lowest - 1) return true;
  const { x0, x1, z0, z1 } = layout.footprint;
  return y === layout.lowest && x >= x0 && x <= x1 && z >= z0 && z <= z1 && !layout.listed.has(key(x, y, z));
}

/** Whether `cell` can be placed against something already placed (or the ground) in a face that gives it its states. */
function restsOnPlaced(cell: WorldCell, placed: ReadonlyMap<string, WorldCell>, layout: Layout): boolean {
  return SUPPORT_OFFSETS.some(([dx, dy, dz]) => {
    if (!faceFits({ x: -dx, y: -dy, z: -dz }, cell, clingsBehindFacing(cell.block))) return false;
    const [x, y, z] = [cell.x + dx, cell.y + dy, cell.z + dz];
    const support = placed.get(key(x, y, z));
    return support === undefined ? isGround(layout, x, y, z) : placeAgainst(support.block);
  });
}

/**
 * Groups cells into the `build_structure` calls that each rest on the ground or on an earlier call, or on an earlier
 * round of their own call (the runtime works a call in passes until done, `build-process.ts`). From the lowest layer up:
 * the cells of layer `y` plus the ones carried from below are grouped `y` in rounds while one has a fitting face toward
 * the ground, a `placeAgainst` cell already grouped, or a cell of an earlier round of this group; cells left are carried
 * to `y + 1` (a lantern or a top-half stair hanging under a beam goes in the beam's call). A cell still ungrouped above
 * the top layer is `unsupported`. Air cells keep their layer; a door goes in its support's group.
 */
export function supportGroups(cells: readonly WorldCell[]): SupportGroups {
  const groups = new Map<string, SupportGroup>();
  const toPlace = cells.filter((cell) => cell.role !== "door" && !isDug(cell));
  for (const cell of cells) if (isDug(cell)) groups.set(key(cell.x, cell.y, cell.z), { group: cell.y, round: 0 });
  if (toPlace.length === 0) return { groups, unsupported: [] };

  const layout = layoutOf(cells, toPlace);
  const top = Math.max(...toPlace.map((cell) => cell.y));
  const placed = new Map<string, WorldCell>();
  let pending: WorldCell[] = [];
  for (let y = layout.lowest; y <= top; y += 1) {
    pending = [...pending, ...toPlace.filter((cell) => cell.y === y)];
    for (let round = 0; pending.length > 0; round += 1) {
      const fitting = pending.filter((cell) => restsOnPlaced(cell, placed, layout));
      if (fitting.length === 0) break;
      for (const cell of fitting) {
        placed.set(key(cell.x, cell.y, cell.z), cell);
        groups.set(key(cell.x, cell.y, cell.z), { group: y, round });
      }
      pending = pending.filter((cell) => !fitting.includes(cell));
    }
  }
  for (const door of cells.filter((cell) => cell.role === "door")) {
    const support = groups.get(key(door.x, door.y - 1, door.z));
    if (support !== undefined) groups.set(key(door.x, door.y, door.z), support);
  }
  return { groups, unsupported: pending };
}

/** Footprint plus overhang a leveled site takes (the leveling box adds a ring, at most 32), layers the leveling clears above the floor (`terrain.ts`), cells `build_structure` keeps (`src/actions/build-structure/contract.ts` `MAX_KEEP_CELLS`). */
const MAX_FOOTPRINT = 30;
const MAX_LAYERS = 17;
const MAX_CELLS = 2048;

/** The blocks a template names per role: a role the blueprint does not use may be absent (`Palette` of blueprint.ts has the eight required). */
type RolePalette = Readonly<Partial<Record<BlockRole, string>>>;

function limitProblems(blueprint: Blueprint): string[] {
  const problems: string[] = [];
  const { x, y, z } = blueprint.size;
  if (x > MAX_FOOTPRINT || z > MAX_FOOTPRINT) problems.push(`the footprint is ${x} x ${z}: at most ${MAX_FOOTPRINT} x ${MAX_FOOTPRINT} with the overhang.`);
  if (y > MAX_LAYERS) problems.push(`${y} layers is too tall: at most ${MAX_LAYERS} layers (the leveling clears ${MAX_LAYERS - 1} above the floor).`);
  const placed = blueprint.cells.filter((cell) => cell.role !== "air").length;
  if (placed > MAX_CELLS) problems.push(`${placed} cells to place: at most ${MAX_CELLS} (what one build keeps).`);
  return problems;
}

/** Block ids that do not exist, roles a cell uses with no block, a structural block that is no full block, a door block with no hinge. */
function blockProblems(blueprint: Blueprint, palette: RolePalette, variants: Variants): string[] {
  const problems: string[] = [];
  const used = new Set(blueprint.cells.map((cell) => cell.role).filter((role): role is BlockRole => role !== "air"));
  for (const role of used) if (palette[role] === undefined) problems.push(`role ${role}: a cell uses it and the palette has no block for it.`);
  for (const [role, block] of Object.entries(palette)) {
    if (registry.blocksByName[block] === undefined) problems.push(`palette ${role}: ${block} is no block in ${TEMPLATE_REGISTRY_VERSION}.`);
  }
  for (const [role, shapes] of Object.entries(variants)) {
    for (const [shape, block] of Object.entries(shapes)) {
      if (registry.blocksByName[block] === undefined) problems.push(`variants ${role} ${shape}: ${block} is no block in ${TEMPLATE_REGISTRY_VERSION}.`);
    }
  }
  for (const role of STRUCTURAL_ROLES.filter((structural) => used.has(structural))) {
    const block = palette[role];
    if (block !== undefined && registry.blocksByName[block] !== undefined && !fullCube(block)) problems.push(`palette ${role}: ${block} is not a full block (a structural role needs one).`);
  }
  const door = palette.door;
  if (door !== undefined && registry.blocksByName[door] !== undefined && !registry.blocksByName[door].states?.some((state) => state.name === "hinge")) {
    problems.push(`palette door: ${door} has no hinge state, it is no door block.`);
  }
  return problems;
}

/** Whether the cell at `x,y,z` is air a bot can stand in: listed air, or unlisted inside the footprint (leveled and cleared). */
function isAirAt(cells: ReadonlyMap<string, WorldCell>, layout: Layout, x: number, y: number, z: number): boolean {
  const listed = cells.get(key(x, y, z));
  if (listed !== undefined) return isDug(listed);
  const { x0, x1, z0, z1 } = layout.footprint;
  return x >= x0 && x <= x1 && z >= z0 && z <= z1;
}

/** Whether the cell at `x,y,z` is air with air above it over a full block (a listed one, or the leveled ground): a place a bot can walk to. */
function isWalkableAt(cells: ReadonlyMap<string, WorldCell>, layout: Layout, x: number, y: number, z: number): boolean {
  const floor = cells.get(key(x, y - 1, z));
  const solidBelow = floor === undefined ? isGround(layout, x, y - 1, z) : !isDug(floor) && fullCube(floor.block);
  return solidBelow && isAirAt(cells, layout, x, y, z) && isAirAt(cells, layout, x, y + 1, z);
}

/** What the door needs around it, read on the template placed with its front facing north (coordinates as in the file): its support, its upper half, its doorstep, a room behind it. */
function doorProblems(cells: ReadonlyMap<string, WorldCell>, door: WorldCell, layout: Layout): string[] {
  const problems: string[] = [];
  const at = (cell: { x: number; y: number; z: number }) => `${cell.x},${cell.y},${cell.z}`;
  const under = cells.get(key(door.x, door.y - 1, door.z));
  if (under === undefined || isDug(under) || !fullCube(under.block)) {
    problems.push(`door at ${at(door)}: the cell under it (${door.x},${door.y - 1},${door.z}) must be a listed full block, it is ${under === undefined ? "not listed" : under.block}.`);
  }
  const above = cells.get(key(door.x, door.y + 1, door.z));
  if (above !== undefined && !isDug(above)) problems.push(`cell ${at(above)} is listed above the door: the door item places its upper half itself.`);
  const [dx, dz] = FACING_VECTOR.north;
  for (const y of [door.y, door.y + 1]) {
    const front = cells.get(key(door.x + dx, y, door.z + dz));
    if (front !== undefined && !isDug(front)) problems.push(`cell ${at(front)} (${front.role}) is in front of the door at ${at(door)}: the way out is shut.`);
  }
  const [behindX, behindZ] = [door.x - dx, door.z - dz];
  if (!isWalkableAt(cells, layout, behindX, door.y, behindZ)) {
    problems.push(`the cell behind the door, ${behindX},${door.y},${behindZ}, is not a place to walk (air, air above, a full block under): the door reaches no room.`);
  }
  return problems;
}

/**
 * Why a template cannot be built, one sentence each naming its cell or role (empty = it can): block ids, structural
 * blocks and the door block in the palette, every cell resting on something placed before it, the door's support,
 * upper half, doorstep and room, and the size limits. The cells are placed with the front facing north, so the
 * coordinates are the file's own.
 */
export function validateBlueprint(blueprint: Blueprint, palette: RolePalette, variants: Variants): string[] {
  const problems = [...blockProblems(blueprint, palette, variants)];
  const anchor = blueprint.cells.find((cell) => cell.role === "door");
  const rolesMissing = blueprint.cells.some((cell) => cell.role !== "air" && palette[cell.role] === undefined);
  if (anchor === undefined) problems.push("the blueprint has no door cell.");
  else if (!rolesMissing) {
    const placed = placeBlueprint(blueprint, palette, anchor, "north", variants);
    const byKey = new Map(placed.map((cell) => [key(cell.x, cell.y, cell.z), cell]));
    const door = placed.find((cell) => cell.role === "door");
    for (const cell of supportGroups(placed).unsupported) problems.push(`cell ${cell.x},${cell.y},${cell.z} (${cell.role}, ${cell.block}) rests on nothing placed before it.`);
    if (door !== undefined) problems.push(...doorProblems(byKey, door, layoutOf(placed, placed.filter((cell) => !isDug(cell)))));
  }
  return [...problems, ...limitProblems(blueprint)];
}

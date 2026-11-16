import { blueprintSchema, type Blueprint, type Role, type Shape } from "./blueprint.ts";

type Facing = "north" | "south" | "east" | "west";
/** What a cell asks besides its role (ADR-013), in the blueprint frame. */
interface States {
  readonly shape?: Shape;
  readonly facing?: Facing;
  readonly half?: "top" | "bottom";
  readonly axis?: "x" | "y" | "z";
}
/** A roof step: bottom stairs whose high side faces up the slope. */
const stairs = (facing: Facing): States => ({ shape: "stairs", facing, half: "bottom" });
/** The row on top of the roof. */
const RIDGE: States = { shape: "slab", half: "bottom" };

export const ROOFS = ["gable", "hip"] as const;
export type Roof = (typeof ROOFS)[number];

export interface HouseOptions {
  /** Along the front wall, odd so the door is centred; at least 5 (a 3-wide room). */
  readonly width: number;
  /** Front to back, at least 5. */
  readonly depth: number;
  /** Wall rows above the floor; at least 3 (door 2 high, window row at 2, trim on top). */
  readonly wallHeight: number;
  readonly roof: Roof;
  /** Eaves beyond the walls, 0-2. */
  readonly overhang: number;
}

/** The sizes the brain offers; the room inside is width-2 × depth-2. */
export const HOUSE_SIZES = {
  small: { width: 5, depth: 5, wallHeight: 3 },
  medium: { width: 7, depth: 5, wallHeight: 3 },
} as const satisfies Record<string, Pick<HouseOptions, "width" | "depth" | "wallHeight">>;
export type HouseSize = keyof typeof HOUSE_SIZES;

/** Builds a gable roof and its triangular end walls. */
function gableRoof(options: HouseOptions, bounds: { x0: number; x1: number; z0: number; z1: number }, set: (x: number, y: number, z: number, role: Role, states?: States) => unknown): void {
  const { width, depth, wallHeight, overhang } = options;
  const { x0, x1, z0, z1 } = bounds;
  const acrossX = width <= depth;
  const [s0, s1, l0, l1] = acrossX ? [x0, x1, z0, z1] : [z0, z1, x0, x1];
  const at = (s: number, y: number, l: number, role: Role, states: States = {}) => (acrossX ? set(s, y, l, role, states) : set(l, y, s, role, states));
  const [upFromLow, upFromHigh]: [Facing, Facing] = acrossX ? ["east", "west"] : ["south", "north"];
  for (let k = 0; s0 - overhang + k <= s1 + overhang - k; k += 1) {
    const low = s0 - overhang + k;
    const high = s1 + overhang - k;
    const y = wallHeight + k;
    for (let l = l0 - overhang; l <= l1 + overhang; l += 1) {
      if (low === high) at(low, y, l, "roof", RIDGE);
      else {
        at(low, y, l, "roof", stairs(upFromLow));
        at(high, y, l, "roof", stairs(upFromHigh));
      }
    }
    if (k > 0) {
      for (let s = low + 1; s < high; s += 1) {
        at(s, y, l0, "wall");
        at(s, y, l1, "wall");
      }
    }
  }
}

/** Adds one cell of a hip roof ring or its hidden inner support. */
function hipRoofCell(x: number, y: number, z: number, bounds: { xl: number; xh: number; zl: number; zh: number }, set: (x: number, y: number, z: number, role: Role, states?: States) => unknown, support: (x: number, y: number, z: number) => void): void {
  const { xl, xh, zl, zh } = bounds;
  const ring = Math.min(x - xl, xh - x, z - zl, zh - z);
  if (ring !== 0) {
    if (ring === 1) support(x, y, z);
    return;
  }
  if (xl === xh || zl === zh) set(x, y, z, "roof", RIDGE);
  else set(x, y, z, "roof", stairs(x === xl ? "east" : x === xh ? "west" : z === zl ? "south" : "north"));
}

/** Builds the shrinking roof rings and their hidden supports. */
function hipRoof(options: HouseOptions, bounds: { x0: number; x1: number; z0: number; z1: number }, set: (x: number, y: number, z: number, role: Role, states?: States) => unknown, support: (x: number, y: number, z: number) => void): void {
  const { wallHeight, overhang } = options;
  const { x0, x1, z0, z1 } = bounds;
  for (let k = 0; ; k += 1) {
    const [xl, xh, zl, zh] = [x0 - overhang + k, x1 + overhang - k, z0 - overhang + k, z1 + overhang - k];
    if (xl > xh || zl > zh) break;
    const y = wallHeight + k;
    for (let x = xl; x <= xh; x += 1) {
      for (let z = zl; z <= zh; z += 1) {
        hipRoofCell(x, y, z, { xl, xh, zl, zh }, set, support);
      }
    }
  }
}

/** Selects a wall cell while leaving the upper door half to the door item. */
function wallCell(x: number, y: number, z: number, geometry: { edge: boolean; corner: boolean; doorX: number; z0: number; z1: number; wallHeight: number; windows: Set<string> }, set: (x: number, y: number, z: number, role: Role, states?: States) => unknown): void {
  const { edge, corner, doorX, z0, z1, wallHeight, windows } = geometry;
  if (!edge) set(x, y, z, "air");
  else if (corner) set(x, y, z, "pillar", { axis: "y" });
  else if (x === doorX && z === z0 && y <= 2) {
    if (y === 1) set(x, y, z, "door");
  } else if (y === wallHeight) set(x, y, z, "trim", { axis: z === z0 || z === z1 ? "x" : "z" });
  else if (y === 2 && windows.has(`${x},${z}`)) set(x, y, z, "window");
  else set(x, y, z, "wall");
}

/**
 * A one-room house: floor on the ground layer (foundation ring + floor), walls with corner pillars, a trim row,
 * windows at row 2, one door centred in the front wall, the room and doorstep dug clear, and a roof of stairs facing up
 * their slope with a slab ridge (a style without stairs builds them as full blocks). Pillars stand, trim beams lie along
 * their wall (ADR-013). Every roof block rests on or beside one placed before it, so the builder never needs
 * scaffolding cells of its own.
 */
export function house(options: HouseOptions): Blueprint {
  const { width, depth, wallHeight, roof, overhang } = options;
  if (width < 5 || width % 2 === 0) throw new Error(`house width must be odd and at least 5, not ${width}`);
  if (depth < 5) throw new Error(`house depth must be at least 5, not ${depth}`);
  if (wallHeight < 3) throw new Error(`house wall height must be at least 3, not ${wallHeight}`);
  if (!Number.isInteger(overhang) || overhang < 0 || overhang > 2) throw new Error(`house overhang must be 0-2, not ${overhang}`);

  const cells = new Map<string, { x: number; y: number; z: number; role: Role } & States>();
  const set = (x: number, y: number, z: number, role: Role, states: States = {}) => cells.set(`${x},${y},${z}`, { x, y, z, role, ...states });
  /** Adds a hidden support block, but never over a wall, pillar or trim. */
  const support = (x: number, y: number, z: number) => {
    const existing = cells.get(`${x},${y},${z}`);
    if (existing === undefined || existing.role === "air") set(x, y, z, "roof");
  };

  // One clear cell in front of the door even without eaves.
  const x0 = overhang;
  const z0 = Math.max(overhang, 1);
  const x1 = x0 + width - 1;
  const z1 = z0 + depth - 1;
  const doorX = x0 + (width - 1) / 2;
  const edge = (x: number, z: number) => x === x0 || x === x1 || z === z0 || z === z1;
  const corner = (x: number, z: number) => (x === x0 || x === x1) && (z === z0 || z === z1);

  const windows = new Set<string>();
  const sideZ = z0 + Math.floor((depth - 1) / 2);
  windows.add(`${x0},${sideZ}`).add(`${x1},${sideZ}`);
  if (width >= 7) {
    for (const x of [doorX - 2, doorX + 2]) windows.add(`${x},${z0}`).add(`${x},${z1}`);
  } else {
    windows.add(`${doorX},${z1}`);
  }

  for (let x = x0; x <= x1; x += 1) {
    for (let z = z0; z <= z1; z += 1) {
      set(x, 0, z, edge(x, z) ? "foundation" : "floor");
      for (let y = 1; y <= wallHeight; y += 1) {
        wallCell(x, y, z, { edge: edge(x, z), corner: corner(x, z), doorX, z0, z1, wallHeight, windows }, set);
      }
    }
  }
  set(doorX, 1, z0 - 1, "air");
  set(doorX, 2, z0 - 1, "air");

  if (roof === "gable") {
    gableRoof(options, { x0, x1, z0, z1 }, set);
  } else {
    hipRoof(options, { x0, x1, z0, z1 }, set, support);
  }

  const all = [...cells.values()];
  const extent = (axis: "x" | "y" | "z") => Math.max(...all.map((cell) => cell[axis])) + 1;
  return blueprintSchema.parse({
    name: `${roof} house ${width}x${depth}`,
    size: { x: extent("x"), y: extent("y"), z: extent("z") },
    sign: { x: doorX + 1, y: 1, z: z0 - 1, facing: "north" },
    cells: all,
  });
}

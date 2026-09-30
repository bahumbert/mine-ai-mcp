import { blueprintSchema, type Blueprint, type Role } from "./blueprint.ts";

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

/**
 * A one-room house: floor on the ground layer (foundation ring + floor), walls with corner pillars, a trim row,
 * windows at row 2, one door centred in the front wall, the room and doorstep dug clear, and a stepped full-block roof
 * (no stairs until blueprints carry block states). Every roof block rests on or beside one placed before it, so the
 * builder never needs scaffolding cells of its own.
 */
export function house(options: HouseOptions): Blueprint {
  const { width, depth, wallHeight, roof, overhang } = options;
  if (width < 5 || width % 2 === 0) throw new Error(`house width must be odd and at least 5, not ${width}`);
  if (depth < 5) throw new Error(`house depth must be at least 5, not ${depth}`);
  if (wallHeight < 3) throw new Error(`house wall height must be at least 3, not ${wallHeight}`);
  if (!Number.isInteger(overhang) || overhang < 0 || overhang > 2) throw new Error(`house overhang must be 0-2, not ${overhang}`);

  const cells = new Map<string, { x: number; y: number; z: number; role: Role }>();
  const set = (x: number, y: number, z: number, role: Role) => cells.set(`${x},${y},${z}`, { x, y, z, role });
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
        if (!edge(x, z)) set(x, y, z, "air");
        else if (corner(x, z)) set(x, y, z, "pillar");
        else if (x === doorX && z === z0 && y <= 2) {
          // The door item places its own upper half: that cell is not listed.
          if (y === 1) set(x, y, z, "door");
        } else if (y === wallHeight) set(x, y, z, "trim");
        else if (y === 2 && windows.has(`${x},${z}`)) set(x, y, z, "window");
        else set(x, y, z, "wall");
      }
    }
  }
  set(doorX, 1, z0 - 1, "air");
  set(doorX, 2, z0 - 1, "air");

  if (roof === "gable") {
    // Slopes across the shorter side; the triangular gable ends are wall, and hold up each roof row from its end.
    const acrossX = width <= depth;
    const [s0, s1, l0, l1] = acrossX ? [x0, x1, z0, z1] : [z0, z1, x0, x1];
    const at = (s: number, y: number, l: number, role: Role) => (acrossX ? set(s, y, l, role) : set(l, y, s, role));
    for (let k = 0; s0 - overhang + k <= s1 + overhang - k; k += 1) {
      const low = s0 - overhang + k;
      const high = s1 + overhang - k;
      const y = wallHeight + k;
      for (let l = l0 - overhang; l <= l1 + overhang; l += 1) {
        at(low, y, l, "roof");
        at(high, y, l, "roof");
      }
      if (k > 0) {
        for (let s = low + 1; s < high; s += 1) {
          at(s, y, l0, "wall");
          at(s, y, l1, "wall");
        }
      }
    }
  } else {
    // Rings shrinking to the top; a second, hidden ring inside each one carries the next ring up.
    for (let k = 0; ; k += 1) {
      const [xl, xh, zl, zh] = [x0 - overhang + k, x1 + overhang - k, z0 - overhang + k, z1 + overhang - k];
      if (xl > xh || zl > zh) break;
      const y = wallHeight + k;
      for (let x = xl; x <= xh; x += 1) {
        for (let z = zl; z <= zh; z += 1) {
          const ring = Math.min(x - xl, xh - x, z - zl, zh - z);
          if (ring === 0) set(x, y, z, "roof");
          else if (ring === 1) support(x, y, z);
        }
      }
    }
  }

  const all = [...cells.values()];
  const extent = (axis: "x" | "y" | "z") => Math.max(...all.map((cell) => cell[axis])) + 1;
  return blueprintSchema.parse({
    name: `${roof} house ${width}x${depth}`,
    size: { x: extent("x"), y: extent("y"), z: extent("z") },
    cells: all,
  });
}

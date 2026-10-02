import { areaKey, type BlockArea, type ToolClass } from "../runtime-client.ts";

/** A rectangle of columns (inclusive bounds). */
export interface Zone {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** One cell to make: a block, or `air` to dig clear. */
export interface TerrainCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly block: string;
}

/** Limits of one leveling job (owner-approved spec, 2026-10-02). */
export const LEVEL_LIMITS = { side: 32, above: 16, below: 4 } as const;

/** The runtime's `build_structure` limit per call. */
const MAX_BATCH = 256;

export interface LevelPlan {
  /**
   * Every batch in order: {@link LevelPlan.phases} one after the other. Each fill goes lowest layer first, so every
   * block has the one under it to stand on; the dig goes top layer first.
   */
  readonly batches: readonly (readonly TerrainCell[])[];
  /**
   * The liquid at or above the level, filled first so no dig opens into it; then the dig, whose drops (dirt from a
   * hill) fill the holes last, as a player cuts a hill to fill the hollow beside it (live 2026-10-02: fetching the
   * fill first found the only dirt within reach inside the zone, which is hers to level, not to mine).
   */
  readonly phases: {
    readonly fillFirst: readonly (readonly TerrainCell[])[];
    readonly dig: readonly (readonly TerrainCell[])[];
    readonly fillAfter: readonly (readonly TerrainCell[])[];
  };
  readonly filled: number;
  readonly dug: number;
  /** Tool classes the dug blocks are mined with (game data), so she carries each before starting. */
  readonly tools: readonly ToolClass[];
}

const EMPTY = new Set(["air", "cave_air", "void_air"]);
/** The liquid blocks of the game: they cannot be dug, only displaced by placing a block into them. */
const LIQUIDS = new Set(["water", "lava", "bubble_column"]);

/** The box `levelPlan` needs read: the zone, from the deepest fill to the highest dig. */
export function levelBox(zone: Zone, level: number): { readonly min: { x: number; y: number; z: number }; readonly max: { x: number; y: number; z: number } } {
  return {
    min: { x: zone.minX, y: level - LEVEL_LIMITS.below, z: zone.minZ },
    max: { x: zone.maxX, y: level + LEVEL_LIMITS.above - 1, z: zone.maxZ },
  };
}

/**
 * How to make `zone` flat with its walking level at `level` (feet height): every cell at `level` and above (up to
 * {@link LEVEL_LIMITS}.above) dug clear, and every hole under it (air, water, grass…: anything not solid, down to the
 * first solid block, at most {@link LEVEL_LIMITS}.below deep, or `below`) filled with `fill`. Water at or above the level
 * is filled before it is dug, so no dig opens into it. `keep` cells (the players' markers) are left as they are.
 */
export interface LevelOptions {
  /** Cells left as they are: the players' markers. */
  readonly keep?: ReadonlySet<string>;
  /** How deep holes are filled (default {@link LEVEL_LIMITS}.below): 1 for a house, which only needs its ring level. */
  readonly below?: number;
  /** Cells never filled: what a house places there itself (its floor and foundation, even into water). */
  readonly placedLater?: ReadonlySet<string>;
}

export function levelPlan(zone: Zone, level: number, area: BlockArea, fill: string, options: LevelOptions = {}): LevelPlan {
  const keep = options.keep ?? new Set<string>();
  const below = Math.min(options.below ?? LEVEL_LIMITS.below, LEVEL_LIMITS.below);
  const placedLater = options.placedLater ?? new Set<string>();
  const at = (x: number, y: number, z: number) => area.blocks.get(areaKey(x, y, z));
  const solid = (name: string) => area.kinds[name]?.solid ?? !EMPTY.has(name);
  const fills: TerrainCell[] = [];
  const liquidFills: TerrainCell[] = [];
  const digs: TerrainCell[] = [];
  const tools = new Set<ToolClass>();
  for (let x = zone.minX; x <= zone.maxX; x += 1) {
    for (let z = zone.minZ; z <= zone.maxZ; z += 1) {
      for (let y = level - 1; y >= level - below; y -= 1) {
        const name = at(x, y, z);
        if (name === undefined || solid(name)) break;
        if (!keep.has(areaKey(x, y, z)) && !placedLater.has(areaKey(x, y, z))) fills.push({ x, y, z, block: fill });
        // Water is capped, not filled: the block on top makes the ground, and filling under it would mean working
        // under water with the surface closing over her (live 2026-10-02: the breath reflex stopped every try).
        if (LIQUIDS.has(name)) break;
      }
      for (let y = level; y < level + LEVEL_LIMITS.above; y += 1) {
        const name = at(x, y, z);
        if (name === undefined || EMPTY.has(name) || keep.has(areaKey(x, y, z))) continue;
        // A liquid cannot be dug: fill it first, then dig the block that took its place.
        if (LIQUIDS.has(name)) liquidFills.push({ x, y, z, block: fill });
        else {
          const tool = area.kinds[name]?.tool;
          if (tool !== null && tool !== undefined) tools.add(tool);
        }
        digs.push({ x, y, z, block: "air" });
      }
    }
  }
  if (liquidFills.length > 0) {
    const fillTool = area.kinds[fill]?.tool;
    if (fillTool !== null && fillTool !== undefined) tools.add(fillTool);
  }
  const layered = (cells: readonly TerrainCell[], order: 1 | -1) =>
    [...new Set(cells.map((cell) => cell.y))].sort((a, b) => (a - b) * order).flatMap((y) => chunk(cells.filter((cell) => cell.y === y)));
  const phases = { fillFirst: layered(liquidFills, 1), dig: layered(digs, -1), fillAfter: layered(fills, 1) };
  return {
    batches: [...phases.fillFirst, ...phases.dig, ...phases.fillAfter],
    phases,
    filled: fills.length + liquidFills.length,
    dug: digs.length,
    tools: [...tools].sort(),
  };
}

function chunk(cells: readonly TerrainCell[]): TerrainCell[][] {
  const batches: TerrainCell[][] = [];
  for (let index = 0; index < cells.length; index += MAX_BATCH) batches.push(cells.slice(index, index + MAX_BATCH));
  return batches;
}

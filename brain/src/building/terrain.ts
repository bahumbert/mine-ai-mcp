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

/** Blocks a levelling step may move in one go (run 12: 1324 dug for "level 12" cost 68 failed minutes). */
export const LEVEL_BLOCK_BUDGET = 256;

/** A dig this deep (blocks) below the ground around it is told to the model as a pit. */
export const PIT_DEPTH = 4;

/** How far under a zone's lowest read layer a support column may start (a platform in the air stands on a column from the ground). */
export const SUPPORT_REACH = 16;

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
  /**
   * How deep the zone lies below the ground just outside it, when that is a pit ({@link PIT_DEPTH} or more on every
   * side), else 0: the lowest of the four walls. Cutting a hill, or into a slope, has an open side and is no pit.
   */
  readonly pit: number;
  /** The cells of the support column built first when the lowest fill layer touches nothing solid (included in `filled`). */
  readonly support: number;
  /** True when a fill layer touches nothing solid and no ground under it is in the area read: read deeper ({@link SUPPORT_REACH}) and plan again. */
  readonly floating: boolean;
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
  /** The most blocks (dug and filled) the job may move; above it the caller refuses (none: no limit). */
  readonly budget?: number;
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
  const filling = fillOutward(fills, fill, at, solid, new Set(digs.map((cell) => areaKey(cell.x, cell.y, cell.z))), zone);
  const phases = { fillFirst: layered(liquidFills, 1), dig: layered(digs, -1), fillAfter: filling.batches };
  return {
    batches: [...phases.fillFirst, ...phases.dig, ...phases.fillAfter],
    phases,
    filled: fills.length + liquidFills.length + filling.support,
    dug: digs.length,
    pit: pitDepth(zone, level, area, at, solid),
    support: filling.support,
    floating: filling.floating,
    tools: [...tools].sort(),
  };
}

/**
 * The ground standing around the zone above the level, when that is a pit wall (see {@link LevelPlan.pit}): the fewest
 * cells of the solid ground run up from the level (it ends at the first open cell or at wood, a tree) in the columns just outside each of its four sides (the area read reaches one column
 * past the zone); a side that is not read, or open, makes it 0.
 */
function pitDepth(zone: Zone, level: number, area: BlockArea, at: (x: number, y: number, z: number) => string | undefined, solid: (name: string) => boolean): number {
  const wall = (x: number, z: number) => {
    let height = 0;
    for (let y = level; y < level + LEVEL_LIMITS.above; y += 1) {
      const name = at(x, y, z);
      if (name === undefined || !solid(name) || area.kinds[name]?.tool === "axe") break;
      height += 1;
    }
    return height;
  };
  let shallowest = Infinity;
  for (let x = zone.minX; x <= zone.maxX; x += 1) shallowest = Math.min(shallowest, wall(x, zone.minZ - 1), wall(x, zone.maxZ + 1));
  for (let z = zone.minZ; z <= zone.maxZ; z += 1) shallowest = Math.min(shallowest, wall(zone.minX - 1, z), wall(zone.maxX + 1, z));
  return shallowest >= PIT_DEPTH ? shallowest : 0;
}

/** The six faces of a cell. */
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;
/** The four sides of a cell in its layer. */
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/**
 * The fill batches, each layer from the bottom up and each layer outward from the cells that touch something solid
 * (then from the cells just placed): a block can only go against another, and a batch cut short must have started where
 * it can be placed. When no cell of a layer touches anything solid (a platform in the air), one support column goes up
 * first from the ground under the cell nearest to it, and the layer fills outward from the column. `floating` when
 * there is no ground in the area under such a layer.
 */
function fillOutward(
  fills: readonly TerrainCell[],
  fill: string,
  at: (x: number, y: number, z: number) => string | undefined,
  solid: (name: string) => boolean,
  dug: ReadonlySet<string>,
  zone: Zone,
): { readonly batches: TerrainCell[][]; readonly support: number; readonly floating: boolean } {
  const placed = new Set<string>();
  const holds = (x: number, y: number, z: number) => {
    const key = areaKey(x, y, z);
    if (placed.has(key)) return true;
    const name = at(x, y, z);
    return name !== undefined && !dug.has(key) && solid(name);
  };
  const touches = (cell: TerrainCell) => FACES.some(([dx, dy, dz]) => holds(cell.x + dx, cell.y + dy, cell.z + dz));
  const centre = { x: (zone.minX + zone.maxX) / 2, z: (zone.minZ + zone.maxZ) / 2 };
  const column: TerrainCell[] = [];
  let floating = false;
  const layers: TerrainCell[][] = [];
  for (const y of [...new Set(fills.map((cell) => cell.y))].sort((a, b) => a - b)) {
    const layer = fills.filter((cell) => cell.y === y);
    let wave = layer.filter(touches);
    if (wave.length === 0) {
      // The ground under each cell; the column goes under the cell with the least to build (the one nearest the middle on a tie).
      let best: { readonly cell: TerrainCell; readonly ground: number } | null = null;
      for (const cell of layer) {
        let ground = cell.y - 1;
        while (at(cell.x, ground, cell.z) !== undefined && !holds(cell.x, ground, cell.z)) ground -= 1;
        if (at(cell.x, ground, cell.z) === undefined) continue;
        const nearer = best === null || cell.y - ground < best.cell.y - best.ground
          || (cell.y - ground === best.cell.y - best.ground && Math.hypot(cell.x - centre.x, cell.z - centre.z) < Math.hypot(best.cell.x - centre.x, best.cell.z - centre.z));
        if (nearer) best = { cell, ground };
      }
      if (best === null) floating = true;
      else {
        for (let under = best.ground + 1; under < y; under += 1) {
          column.push({ x: best.cell.x, y: under, z: best.cell.z, block: fill });
          placed.add(areaKey(best.cell.x, under, best.cell.z));
        }
        wave = layer.filter(touches);
      }
    }
    const index = new Map(layer.map((cell) => [areaKey(cell.x, cell.y, cell.z), cell]));
    const queued = new Set(wave.map((cell) => areaKey(cell.x, cell.y, cell.z)));
    const ordered: TerrainCell[] = [];
    for (let head = 0; head < wave.length; head += 1) {
      const cell = wave[head]!;
      ordered.push(cell);
      for (const [dx, dz] of SIDES) {
        const key = areaKey(cell.x + dx, y, cell.z + dz);
        const next = index.get(key);
        if (next === undefined || queued.has(key)) continue;
        queued.add(key);
        wave.push(next);
      }
    }
    // Pieces with nothing solid anywhere near them stay in order, to be refused as they would have been.
    for (const cell of layer) if (!queued.has(areaKey(cell.x, cell.y, cell.z))) ordered.push(cell);
    for (const cell of ordered) placed.add(areaKey(cell.x, cell.y, cell.z));
    layers.push(ordered);
  }
  return { batches: [...chunk(column), ...layers.flatMap((layer) => chunk(layer))], support: column.length, floating };
}

function chunk(cells: readonly TerrainCell[]): TerrainCell[][] {
  const batches: TerrainCell[][] = [];
  for (let index = 0; index < cells.length; index += MAX_BATCH) batches.push(cells.slice(index, index + MAX_BATCH));
  return batches;
}

import { DIG_CLEAR_BLOCK } from "#src/actions/build-structure/dig-clear.ts";
import { billOfMaterials, buildBatches, cellsCountedOnce, describeMaterials, DIG_ROLE, FACING_VECTOR, placeBlueprint, placeSign, type BlockRole, type Facing, type MaterialCount, type Position, type SignSpot, type Variants, type WorldCell } from "./blueprint.ts";
import { DEFAULT_STYLE, STYLES, type Style } from "./styles.ts";
import { supportGroups, withStatesItHas } from "./support.ts";
import { stagesOf, type Stage, type Template } from "./templates.ts";

/** Blocks between the bot's feet and the door: the bot stands on the doorstep's far side, clear of every cell. */
const DOOR_DISTANCE = 2;

export interface Site {
  /** The door's lower cell; its y is the bot's feet level, so the floor replaces the ground block. */
  readonly door: Position;
  readonly facing: Facing;
}

/**
 * Puts the house right behind the bot, its door facing the player it is for (or north without one): the requester
 * sees the front, and the bot starts outside the footprint. The site is not surveyed yet (backlog): whatever stands
 * there is dug out.
 */
export function chooseSite(bot: Position, toward: Position | null): Site {
  const facing = facingToward(bot, toward);
  const [fx, fz] = FACING_VECTOR[facing];
  const feet = { x: Math.floor(bot.x), y: Math.floor(bot.y), z: Math.floor(bot.z) };
  return { door: { x: feet.x - fx * DOOR_DISTANCE, y: feet.y, z: feet.z - fz * DOOR_DISTANCE }, facing };
}

/** A house whose door is at `door` (its lower cell, feet height), facing the player it is for (or north without one). */
export function siteAt(door: Position, toward: Position | null): Site {
  return { door: { x: Math.floor(door.x), y: Math.floor(door.y), z: Math.floor(door.z) }, facing: facingToward(door, toward) };
}

/** Where the builder starts for `site`: in front of the door, clear of every cell, as {@link chooseSite} places it. */
export function builderStand(site: Site): Position {
  const [fx, fz] = FACING_VECTOR[site.facing];
  return { x: site.door.x + fx * DOOR_DISTANCE, y: site.door.y, z: site.door.z + fz * DOOR_DISTANCE };
}

/** The side `toward` lies on, seen from `from` (north when nobody is given). */
export function facingToward(from: Position, toward: Position | null): Facing {
  const dx = toward === null ? 0 : toward.x - from.x;
  const dz = toward === null ? -1 : toward.z - from.z;
  return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? "east" : "west") : (dz > 0 ? "south" : "north");
}

export interface HousePlan {
  readonly template: Template;
  readonly site: Site;
  /** The roles built with other blocks than the template's; empty for a house as the template. */
  readonly materials: Materials;
  /** The remembered stairs and slabs of substituted roles; absent in legacy notes, which use full blocks. */
  readonly shapes: Variants;
  readonly cells: readonly WorldCell[];
  readonly bill: readonly MaterialCount[];
  readonly batches: readonly (readonly WorldCell[])[];
  readonly sign: SignSpot | null;
  /** Where to stand on the roof, remembered with the house so "go to the roof" has real coordinates. */
  readonly roofTop: Position;
  /** The runs of `batches` the bot fetches blocks for and builds together; contiguous, covering every batch. */
  readonly stages: readonly Stage[];
  /** What a stage needs, each cell counted in its last batch only: the bills of all stages add up to `bill`. */
  readonly stageBill: (stage: Stage) => MaterialCount[];
}

/** Falls back to the default style when the name is unknown (a persona may name a style not shipped yet). */
export function styleOrDefault(name: string | undefined): Style {
  const style = (name === undefined ? undefined : STYLES.get(name)) ?? STYLES.get(DEFAULT_STYLE);
  if (style === undefined) throw new Error(`[STYLE_MISSING] default style ${DEFAULT_STYLE} is not shipped`);
  return style;
}

/** Blocks other than the template's for some roles (what a bot carries, what the ground gave): the house is temporary. */
export type Materials = Partial<Record<BlockRole, string>>;

/**
 * The house of `template` at `site`. `materials` names other blocks for some roles; those roles use their remembered
 * `shapes` (stairs and slabs of the substitute, see `shapesForMaterials`), or full blocks without them (the template's
 * stairs and slabs belong to its own block), and ask no log axis, and no facing or half unless a shape was given
 * (live 2026-10-10: cobblestone pillars asked an axis cobblestone has, so the audit never saw them right; a ladder's
 * facing on stone is the same case). A role named with the template's own block is the template's.
 */
export function planTemplate(template: Template, site: Site, materials: Materials = {}, shapes: Variants = {}): HousePlan {
  // A role the template has no block for (no cell asks it) is left out: naming one does not make the house temporary.
  const other = Object.fromEntries(Object.entries(materials).filter(([role, block]) => template.palette[role as BlockRole] !== undefined && template.palette[role as BlockRole] !== block)) as Materials;
  const remembered = Object.fromEntries(Object.entries(shapes).filter(([role, variants]) => other[role as BlockRole] !== undefined && Object.keys(variants).length > 0));
  const variants = { ...Object.fromEntries(Object.entries(template.variants).filter(([role]) => other[role as BlockRole] === undefined)), ...remembered };
  const palette = { ...template.palette, ...other };
  const cells = placeBlueprint(template.blueprint, palette, site.door, site.facing, variants)
    .map((cell) => other[cell.role as BlockRole] === undefined ? withStatesItHas(cell) : withoutStates(cell, cell.block !== palette[cell.role as BlockRole]));
  const batches = buildBatches(cells);
  const counted = cellsCountedOnce(batches);
  return {
    template, site, materials: other, shapes: remembered, cells, bill: billOfMaterials(cells), batches, sign: placeSign(template.blueprint, site.door, site.facing), roofTop: roofTop(cells),
    stages: stagesOf(template, batches, supportGroups(cells).groups),
    stageBill: (stage) => billOfMaterials(counted.slice(stage.first, stage.last + 1).flat()),
  };
}

/** A substituted role's cell without the states of the template's own block: never an axis, and no facing or half unless it is a remembered shape (`shaped`). */
function withoutStates(cell: WorldCell, shaped: boolean): WorldCell {
  const { axis: _axis, ...rest } = cell;
  if (shaped) return rest;
  const { facing: _facing, half: _half, ...plain } = rest;
  return plain;
}

/**
 * One line the model reads to choose a house: id, footprint, floors, blocks, the three largest bill items by name only
 * (the model may weigh far materials but has no list to paste into `get_items`), the first stage's bill (what `build`
 * asks first), description.
 */
export function catalogueLine(template: Template): string {
  const plan = planTemplate(template, { door: { x: 0, y: 0, z: 0 }, facing: "north" });
  const floors = new Set(plan.cells.filter((cell) => cell.role === "floor").map((cell) => cell.y)).size;
  const blocks = plan.bill.reduce((sum, { count }) => sum + count, 0);
  const first = plan.stages[0]!;
  // The built footprint, not the blueprint's: a file may pad a row (the rondavel's, for its sign) or a column that no cell fills.
  const built = plan.cells.filter((cell) => cell.block !== DIG_CLEAR_BLOCK);
  const span = (axis: "x" | "z") => Math.max(...built.map((cell) => cell[axis])) - Math.min(...built.map((cell) => cell[axis])) + 1;
  return `${template.id} (${span("x")}x${span("z")}, ${floors} floor${floors === 1 ? "" : "s"}, ${blocks} blocks, mostly ${plan.bill.slice(0, 3).map(({ item }) => item).join(", ")}; its first stage, the ${first.name}, takes ${describeMaterials(plan.stageBill(first))}) ${template.description}`;
}

/** The spot above the highest roof block nearest the middle of the top row (the ridge centre of a gable roof); a house with no roof role, the highest cell. */
export function roofTop(cells: readonly WorldCell[]): Position {
  const roofCells = cells.filter((cell) => cell.role === "roof");
  const roof = roofCells.length > 0 ? roofCells : cells.filter((cell) => cell.role !== DIG_ROLE);
  const top = Math.max(...roof.map((cell) => cell.y));
  const ridge = roof.filter((cell) => cell.y === top);
  const middleX = ridge.reduce((sum, cell) => sum + cell.x, 0) / ridge.length;
  const middleZ = ridge.reduce((sum, cell) => sum + cell.z, 0) / ridge.length;
  const offset = (cell: WorldCell) => Math.hypot(cell.x - middleX, cell.z - middleZ);
  const best = ridge.reduce((closest, cell) => (offset(cell) < offset(closest) ? cell : closest));
  return { x: best.x, y: top + 1, z: best.z };
}

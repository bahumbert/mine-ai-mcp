import { billOfMaterials, buildBatches, FACING_VECTOR, placeBlueprint, type Facing, type MaterialCount, type Position, type WorldCell } from "./blueprint.ts";
import { house, HOUSE_SIZES, type HouseSize } from "./house.ts";
import { DEFAULT_STYLE, STYLES, type Style } from "./styles.ts";

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

function facingToward(from: Position, toward: Position | null): Facing {
  const dx = toward === null ? 0 : toward.x - from.x;
  const dz = toward === null ? -1 : toward.z - from.z;
  return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? "east" : "west") : (dz > 0 ? "south" : "north");
}

export interface HousePlan {
  readonly style: Style;
  readonly size: HouseSize;
  readonly site: Site;
  readonly cells: readonly WorldCell[];
  readonly bill: readonly MaterialCount[];
  readonly batches: readonly (readonly WorldCell[])[];
  /** Where to stand on the roof, remembered with the house so "go to the roof" has real coordinates. */
  readonly roofTop: Position;
}

/** Falls back to the default style when the name is unknown (a persona may name a style not shipped yet). */
export function styleOrDefault(name: string | undefined): Style {
  const style = (name === undefined ? undefined : STYLES.get(name)) ?? STYLES.get(DEFAULT_STYLE);
  if (style === undefined) throw new Error(`[STYLE_MISSING] default style ${DEFAULT_STYLE} is not shipped`);
  return style;
}

export function planHouse(style: Style, size: HouseSize, site: Site): HousePlan {
  const blueprint = house({ ...HOUSE_SIZES[size], ...style.house });
  const cells = placeBlueprint(blueprint, style.palette, site.door, site.facing, style.variants);
  return { style, size, site, cells, bill: billOfMaterials(cells), batches: buildBatches(cells), roofTop: roofTop(cells) };
}

/** The spot above the highest roof block nearest the middle of the top row (the ridge centre of a gable roof). */
export function roofTop(cells: readonly WorldCell[]): Position {
  const roof = cells.filter((cell) => cell.role === "roof");
  const top = Math.max(...roof.map((cell) => cell.y));
  const ridge = roof.filter((cell) => cell.y === top);
  const middleX = ridge.reduce((sum, cell) => sum + cell.x, 0) / ridge.length;
  const middleZ = ridge.reduce((sum, cell) => sum + cell.z, 0) / ridge.length;
  const offset = (cell: WorldCell) => Math.hypot(cell.x - middleX, cell.z - middleZ);
  const best = ridge.reduce((closest, cell) => (offset(cell) < offset(closest) ? cell : closest));
  return { x: best.x, y: top + 1, z: best.z };
}

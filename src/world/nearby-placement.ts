import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { cellIntersectsPlayerBody } from "../utils/index.js";
import { isDryPlacementSite, isLiquid, supportsFlatPlacement } from "./block-classification.js";
import { placeBlock, findPlacementSupport, type WorldBlock } from "./placement.js";
import { chestOpeningObstruction } from "./chest-clearance.js";
import { protectedRegionAt, readProtectedRegions } from "./protected-regions.js";
import { CRAFTING_STATION } from "./workstations.js";

/** Vanilla block-interaction reach, measured from the bot's feet cell like every other placement here. */
const NEARBY_PLACEMENT_REACH = 4;
/** Feet level first, then the step down and the step up; a cell two up is over the bot's head. */
const SEARCH_HEIGHTS = [0, -1, 1] as const;

export type NearbyPlacement =
  | { readonly kind: "placed"; readonly position: Vec3; readonly block: WorldBlock }
  | { readonly kind: "no_item" }
  | { readonly kind: "no_cell" }
  | { readonly kind: "failed"; readonly position: Vec3; readonly error: string };

interface PlacementCell {
  readonly position: Vec3;
  readonly support: NonNullable<ReturnType<Bot["blockAt"]>>;
  /** The face of the support the block is placed against: from the support toward the cell. */
  readonly face: Vec3;
}

/**
 * The nearest clear cell around the bot with a solid neighbour to place
 * against, floor-supported cells before wall-supported ones at the same
 * distance.
 *
 * The seventh playthrough carried a crafting table it could not put down
 * for three calls running while a floor cell was demanded: a tunnel face
 * has walls on every side and no free floor, and the model walked off to
 * find open ground instead of crafting where it stood.
 */
function chooseCell(
  bot: Bot,
  itemName: string,
  maxRadius: number,
  inRegions: boolean,
  /** Where the bot stands, or would stand: its feet cell and its body position. */
  from: { readonly feet: Vec3; readonly body: Vec3 } = { feet: bot.entity.position.floored(), body: bot.entity.position },
): PlacementCell | null {
  const { feet, body } = from;
  const regions = readProtectedRegions(bot);
  let chosen: { readonly cell: PlacementCell; readonly distance: number; readonly onFloor: boolean } | null = null;
  for (let dx = -maxRadius; dx <= maxRadius; dx += 1) {
    for (let dz = -maxRadius; dz <= maxRadius; dz += 1) {
      for (const dy of SEARCH_HEIGHTS) {
        const position = feet.offset(dx, dy, dz);
        const distance = position.distanceTo(feet);
        if (distance > NEARBY_PLACEMENT_REACH || cellIntersectsPlayerBody(position, body)) continue;
        if (!isDryPlacementSite(bot.blockAt(position))) continue;
        if (chestOpeningObstruction(bot, itemName, position)) continue;
        if (!inRegions && protectedRegionAt(regions, bot.game.dimension, position.x, position.y, position.z) !== null) continue;
        const placement = findPlacementSupport(bot, position, supportsFlatPlacement);
        if (placement) {
          const { support, face } = placement;
          const onFloor = face.y === 1;
          const better =
            chosen === null ||
            distance < chosen.distance - 1e-9 ||
            (Math.abs(distance - chosen.distance) < 1e-9 && onFloor && !chosen.onFloor);
          if (better) chosen = { cell: { position, support, face }, distance, onFloor };
        }
      }
    }
  }
  return chosen?.cell ?? null;
}

/** How far a bot is sent for a spot where a workstation fits: a few steps, not a trek. */
export const STANDING_SPOT_RADIUS = 8;
/** Standing spots are looked for this far below and above the bot's feet. */
const STANDING_SPOT_HEIGHT = 3;

/** A cell a player stands in: feet and head clear and dry, something solid underneath that is not a liquid. */
function canStandAt(bot: Bot, feet: Vec3): boolean {
  const body = [bot.blockAt(feet), bot.blockAt(feet.offset(0, 1, 0))];
  const floor = bot.blockAt(feet.offset(0, -1, 0));
  if (body.some((block) => block === null || block.boundingBox !== "empty" || isLiquid(block))) return false;
  return floor !== null && supportsFlatPlacement(floor) && !isLiquid(floor);
}

/**
 * The nearest cell (straight-line, no path asked) where a player can stand and from which a block of this kind can
 * be placed the way `placeCarriedBlockNearby` does, or null when there is none within `maxRadius` blocks across and
 * three up or down. Loaded blocks only.
 *
 * Live 2026-10-02: a bot logged in standing in water, and a bot leveling inside its own cut had no free cell either;
 * a player takes a few steps to open dry ground first. The caller walks there and places again.
 */
export function findStandingSpot(bot: Bot, maxRadius = STANDING_SPOT_RADIUS, itemName: string = CRAFTING_STATION): Vec3 | null {
  const origin = bot.entity.position.floored();
  const spots: { readonly feet: Vec3; readonly distance: number }[] = [];
  for (let dx = -maxRadius; dx <= maxRadius; dx += 1) {
    for (let dz = -maxRadius; dz <= maxRadius; dz += 1) {
      for (let dy = -STANDING_SPOT_HEIGHT; dy <= STANDING_SPOT_HEIGHT; dy += 1) {
        const feet = origin.offset(dx, dy, dz);
        const distance = feet.distanceTo(origin);
        if (distance <= maxRadius && canStandAt(bot, feet)) spots.push({ feet, distance });
      }
    }
  }
  spots.sort((left, right) => left.distance - right.distance);
  for (const { feet } of spots) {
    const from = { feet, body: new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5) };
    const found = chooseCell(bot, itemName, 3, false, from) ?? chooseCell(bot, itemName, 3, true, from);
    if (found) return feet;
  }
  return null;
}

/**
 * Place one carried block on the nearest clear cell around the bot, without
 * moving.
 *
 * A model underground cannot see which cells are free, and the first
 * playthrough spent a third of its calls guessing coordinates for a crafting
 * table. The cell is chosen here: clear, outside the bot's body, within
 * reach, with something solid to place against, nearest first.
 */
export async function placeCarriedBlockNearby(
  bot: Bot,
  itemName: string,
  options: {
    readonly maxRadius?: number;
    readonly signal?: AbortSignal;
    /** Told the cell right before the placement packet goes out (not at the choice): a caller cut off after it knows where its block may stand. */
    readonly onPlacementSent?: (cells: readonly Vec3[]) => void;
  } = {},
): Promise<NearbyPlacement> {
  const item = bot.inventory.items().find((candidate) => candidate.name === itemName);
  if (!item) return { kind: "no_item" };
  // Outside every protected region first, the bot's own included: a block put down there could not be taken back
  // up (live 2026-10-02: a crafting table left in the doorway of her own house). Inside one only when nothing else is free.
  const cell = chooseCell(bot, itemName, options.maxRadius ?? 3, false) ?? chooseCell(bot, itemName, options.maxRadius ?? 3, true);
  if (!cell) return { kind: "no_cell" };
  const result = await placeBlock(bot, {
    item,
    support: cell.support,
    face: cell.face,
    expectedCells: [cell.position],
    matches: (block) => block.name === itemName,
    signal: options.signal,
    onSent: () => options.onPlacementSent?.([cell.position]),
  });
  if (result.kind === "placed") return { kind: "placed", position: cell.position, block: result.block };
  return { kind: "failed", position: cell.position, error: result.error };
}

// Decide whether a water-adjacent target can be drained before walking to it.
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { cellKey } from "../../../utils/index.js";
import { isReplaceableForPlacement } from "../../../world/block-classification.js";
import { sourceFeeding } from "../../../world/liquid.js";
import { findPlacementSupport } from "../../../world/placement.js";
import { isPassable, isSafeSupport } from "../../world/block-geometry.js";
import { cellHoldsWater } from "../../world/deep-water.js";
import type { BlockPosition, WorldView } from "../../world/world.js";
import { waterOccupancy } from "../../world/water.js";
import { touching } from "./mining-water.js";

export const IN_WATER_PREFIX = "in water: ";
export const WORKING_OFFSETS: readonly BlockPosition[] = [
  { x: 1, y: -1, z: 0 }, { x: -1, y: -1, z: 0 }, { x: 0, y: -1, z: 1 }, { x: 0, y: -1, z: -1 },
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
  { x: 0, y: 1, z: 0 },
  { x: 1, y: 1, z: 0 }, { x: -1, y: 1, z: 0 }, { x: 0, y: 1, z: 1 }, { x: 0, y: 1, z: -1 },
];

export type DrownedVerdict =
  | { readonly kind: "dry" }
  | { readonly kind: "drainable"; readonly wetStances: readonly BlockPosition[] }
  | { readonly kind: "refused"; readonly reason: string };

/** Every loaded touching cell whose current fluid state holds water. */
function wetFaces(world: WorldView, position: BlockPosition): Vec3[] {
  return touching(new Vec3(position.x, position.y, position.z)).filter((cell) => {
    const block = world.blockAt(cell.x, cell.y, cell.z);
    return block.kind === "loaded" && cellHoldsWater(block);
  });
}

/** Whether a drain failure still leaves water touching the target. */
export function hasWetFace(world: WorldView, position: BlockPosition): boolean {
  return wetFaces(world, position).length > 0;
}

/** A dry stance or a supported wade outside the faces the drain must fill. */
function isDrainStance(world: WorldView, cell: BlockPosition, faceKeys: ReadonlySet<string>): boolean {
  const feet = world.blockAt(cell.x, cell.y, cell.z);
  const head = world.blockAt(cell.x, cell.y + 1, cell.z);
  if (feet.kind === "loaded" && feet.traits.liquid === "water" && !feet.traits.liquidSource && !faceKeys.has(cellKey(cell)) &&
    waterOccupancy((x, y, z) => world.blockAt(x, y, z), cell.x, cell.y, cell.z) === "surface") return true;
  return feet.kind === "loaded" && head.kind === "loaded" &&
    isPassable(feet) && isPassable(head) && !cellHoldsWater(feet) && !cellHoldsWater(head) &&
    feet.traits.liquid !== "lava" && head.traits.liquid !== "lava" &&
    isSafeSupport(world.blockAt(cell.x, cell.y - 1, cell.z));
}

/** Check replaceability, a usable drain stance and the shared water/lava budget before any route. */
export function drownedVerdict(
  bot: Bot, world: WorldView, position: BlockPosition, availableBlocks: number, closures: number,
): DrownedVerdict {
  const faces = wetFaces(world, position);
  if (faces.length === 0) return { kind: "dry" };
  for (const face of faces) {
    const block = bot.blockAt(face);
    if (!isReplaceableForPlacement(block, bot.version) || !findPlacementSupport(bot, face)) {
      return { kind: "refused", reason: `${IN_WATER_PREFIX}water beside it is held by ${block?.name ?? "an unloaded cell"}, which a placement does not replace` };
    }
  }
  const stances = WORKING_OFFSETS.map((offset) => ({
    x: position.x + offset.x, y: position.y + offset.y, z: position.z + offset.z,
  }));
  const faceKeys = new Set(faces.map(cellKey));
  const wetStances = stances.filter((cell) => !isDrainStance(world, cell, faceKeys));
  if (wetStances.length === stances.length) {
    return { kind: "refused", reason: `${IN_WATER_PREFIX}no dry ground beside it to drain it from` };
  }
  const neededCells = new Set(faces.map(cellKey));
  for (const face of faces) {
    const source = sourceFeeding(bot, face, "water");
    if (source) neededCells.add(cellKey(source));
  }
  const needed = neededCells.size;
  if (needed + closures > availableBlocks) {
    return { kind: "refused", reason: `${IN_WATER_PREFIX}draining it takes ${needed} block${needed === 1 ? "" : "s"} to place, ${availableBlocks} carried` };
  }
  return { kind: "drainable", wetStances };
}

import { createRequire } from "node:module";
import { offsetBlocks, placeShapes, type OffsetRegistry } from "../../../src/world/block-offset.ts";

/** Body half-width of a player, as the server collides it. */
export const BODY_HALF_WIDTH = 0.3;

interface GameData extends OffsetRegistry {
  readonly blocksByStateId: Record<number, { readonly name: string; readonly minStateId: number }>;
}
const require = createRequire(import.meta.url);
const gameData = (require("minecraft-data") as (version: string) => GameData)("1.21.4");

/** The stalk's boxes as the server has them, from the game data and the formula, in world coordinates. */
export function serverBoxes(stalk: readonly [number, number, number], stateId: number): readonly (readonly number[])[] {
  const block = gameData.blocksByStateId[stateId];
  const max = block === undefined ? undefined : offsetBlocks(gameData).get(block.name);
  if (block === undefined || max === undefined) throw new Error(`state ${stateId} at ${stalk.join(",")} is not an offset block`);
  const collision = gameData.blockCollisionShapes!;
  const ids = collision.blocks[block.name]!;
  const shapeId = Array.isArray(ids) ? ids[stateId - block.minStateId]! : ids;
  const placed = placeShapes(collision.shapes[shapeId]!, max, stalk[0], stalk[2]);
  return placed.map((box) => [stalk[0] + box[0]!, box[1]!, stalk[2] + box[2]!, stalk[0] + box[3]!, box[4]!, stalk[2] + box[5]!]);
}

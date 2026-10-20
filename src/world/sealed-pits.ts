// Where this bot's sealed disposal pits are, the cells around them no route may dig, and the dropped items lying in them.
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { BlockPosition } from "../navigation/world/world.js";
import { droppedItemName, isItemEntity } from "./item-pickup.js";

/** Pits remembered per bot; the oldest is forgotten past it. */
export const SEALED_PIT_LIMIT = 32;

/** Within this horizontal distance a pit's cell is loaded and its entities are tracked, so an empty column means empty. */
export const SEALED_PIT_WATCH_BLOCKS = 16;

/** A pit is not judged empty before this: a server seconds behind spawns the buried stacks late (run 16: 350 "Can't keep up"). */
export const SEALED_PIT_SETTLE_MS = 30_000;

interface SealedPit {
  readonly bottom: BlockPosition;
  readonly dimension: string;
  readonly sealedAt: number;
}

/** Per bot, oldest first. */
const pitsOf = new WeakMap<Bot, SealedPit[]>();

const dimensionOf = (bot: Bot) => bot.game?.dimension ?? "";

const samePit = (pit: SealedPit, bottom: BlockPosition, dimension: string) =>
  pit.dimension === dimension && pit.bottom.x === bottom.x && pit.bottom.y === bottom.y && pit.bottom.z === bottom.z;

/** The pits of the bot's current dimension. */
const pitsHere = (bot: Bot): SealedPit[] => (pitsOf.get(bot) ?? []).filter((pit) => pit.dimension === dimensionOf(bot));

/** Remember a pit plugged in both cells; the 33rd forgets the oldest. */
export function rememberSealedPit(bot: Bot, bottom: BlockPosition, now = Date.now()): void {
  forgetEmptySealedPits(bot, now);
  const pits = pitsOf.get(bot) ?? [];
  const dimension = dimensionOf(bot);
  if (!pits.some((pit) => samePit(pit, bottom, dimension))) pits.push({ bottom: { x: bottom.x, y: bottom.y, z: bottom.z }, dimension, sealedAt: now });
  pitsOf.set(bot, pits.slice(-SEALED_PIT_LIMIT));
}

/**
 * The bottom of the pit whose guard volume holds the cell, or null. The guard volume is the 3x3 column from two cells
 * below the bottom to the lower plug cell, plus the upper plug cell: the cells a body must dig to reach the items (the
 * pickup reaches through walls). Called per priced break, so it neither allocates nor forgets pits.
 */
export function sealedPitGuarding(bot: Bot, x: number, y: number, z: number): BlockPosition | null {
  const dimension = dimensionOf(bot);
  for (const { bottom, dimension: pitDimension } of pitsOf.get(bot) ?? []) {
    if (pitDimension !== dimension) continue;
    const beside = Math.abs(x - bottom.x) <= 1 && Math.abs(z - bottom.z) <= 1;
    if (beside && y >= bottom.y - 2 && y <= bottom.y + 1) return bottom;
    if (x === bottom.x && z === bottom.z && y === bottom.y + 2) return bottom;
  }
  return null;
}

/** Entity ids of the dropped items lying in a pit's column, at the discards' cell or the lower plug cell. */
function itemsInPits(bot: Bot, pits: readonly SealedPit[]): Map<SealedPit, number[]> {
  const found = new Map<SealedPit, number[]>();
  for (const entity of Object.values(bot.entities ?? {})) {
    if (droppedItemName(entity) === null && !isItemEntity(entity)) continue;
    const { x, y, z } = entity.position;
    const pit = pits.find(({ bottom }) => Math.floor(x) === bottom.x && Math.floor(z) === bottom.z && [0, 1].includes(Math.floor(y) - bottom.y));
    if (pit) found.set(pit, [...(found.get(pit) ?? []), entity.id]);
  }
  return found;
}

/**
 * Forget the pits seen empty: past their settle time, their cell loaded, the bot within the watch distance and no
 * dropped item in their column (the items despawned or were taken). A pit out of sight is kept.
 */
export function forgetEmptySealedPits(bot: Bot, now = Date.now()): void {
  const pits = pitsOf.get(bot);
  if (!pits?.length) return;
  const here = pitsHere(bot);
  const occupied = itemsInPits(bot, here);
  const position = bot.entity.position;
  const empty = (pit: SealedPit) =>
    pit.dimension === dimensionOf(bot) &&
    now - pit.sealedAt >= SEALED_PIT_SETTLE_MS &&
    Math.hypot(position.x - pit.bottom.x - 0.5, position.z - pit.bottom.z - 0.5) <= SEALED_PIT_WATCH_BLOCKS &&
    bot.blockAt(new Vec3(pit.bottom.x, pit.bottom.y, pit.bottom.z)) !== null &&
    !occupied.has(pit);
  pitsOf.set(bot, pits.filter((pit) => !empty(pit)));
}

/** The dropped items lying in this bot's sealed pits: its own burials, never to be collected or swept again. */
export function sealedPitItemIds(bot: Bot, now = Date.now()): ReadonlySet<number> {
  forgetEmptySealedPits(bot, now);
  return new Set([...itemsInPits(bot, pitsHere(bot)).values()].flat());
}

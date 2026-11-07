/**
 * What surrounds a block a gathering is told about: open to the sky, under water, or roofed over. The fact comes from
 * the loaded world (water the cells hold, what the cells are made of, the game's block tags), never from a list of
 * names, and it is told to the model with the position, never used to hide one (spec 2026-11-07-p4-water-targets D1).
 */
import { cellHoldsWater, isPassable, liveBlockReader } from "../navigation/index.js";
import type { BlockPosition, LoadedBlock, WorldView } from "../navigation/index.js";
import type { Bot } from "mineflayer";
import { tagsOf } from "./block-tags.js";

export type TargetSituation = "open" | "under_water" | "roofed";

/**
 * Walk up the column over `position` until the answer is known:
 * - the block's own cell holds water, or the first cell over the stack of targets holds water: `under_water`;
 * - above that, water cells are passed; a loaded cell that is not passable and is neither a tree part nor a target
 *   (a stone, a plank, a wart block) is a roof: `roofed`;
 * - an unloaded cell, or reaching `topY` (exclusive; the world top, where prismarine reads air), leaves it `open`.
 * Only an open column is read to the top; the other answers stop within a few cells.
 */
export function targetSituation(
  read: WorldView["blockAt"],
  position: BlockPosition,
  isTarget: (block: LoadedBlock) => boolean,
  isTreePart: (block: LoadedBlock) => boolean,
  topY: number,
): TargetSituation {
  const own = read(position.x, position.y, position.z);
  if (own.kind === "loaded" && cellHoldsWater(own)) return "under_water";
  let stacked = true;
  for (let y = position.y + 1; y < topY; y++) {
    const block = read(position.x, y, position.z);
    if (block.kind !== "loaded") return "open";
    if (cellHoldsWater(block)) {
      if (stacked) return "under_water";
      continue;
    }
    if (stacked && isTarget(block)) continue;
    stacked = false;
    if (isTarget(block) || isTreePart(block) || isPassable(block)) continue;
    return "roofed";
  }
  return "open";
}

/** Whether a state is a tree part: the game's `logs` or `leaves` tag on its block name. */
function treePartTest(bot: Bot): (block: LoadedBlock) => boolean {
  const known = new Map<number, boolean>();
  return (block) => {
    let treePart = known.get(block.stateId);
    if (treePart === undefined) {
      const tags = tagsOf(bot.registry.blocksByStateId[block.stateId]?.name ?? "", bot.version);
      treePart = tags.includes("logs") || tags.includes("leaves");
      known.set(block.stateId, treePart);
    }
    return treePart;
  };
}

/**
 * `targetSituation` over the bot's loaded world, as a function of the position: the target is any of
 * `targetStateIds`, tree parts are the game's `logs` and `leaves` tags. One reader and one tag cache serve every
 * position asked of it, so a scan of many candidates builds them once.
 */
export function situationReader(bot: Bot, targetStateIds: ReadonlySet<number>): (position: BlockPosition) => TargetSituation {
  const read = liveBlockReader(bot);
  const isTreePart = treePartTest(bot);
  // Mineflayer's typings leave the dimension's floor and height off `game` (`game.js:70-82`).
  const dimension = bot.game as typeof bot.game & { minY: number; height: number };
  const topY = dimension.minY + dimension.height;
  return (position) => targetSituation(read, position, (block) => targetStateIds.has(block.stateId), isTreePart, topY);
}

/** `situationReader` for one position. */
export function situationOf(bot: Bot, position: BlockPosition, targetStateIds: ReadonlySet<number>): TargetSituation {
  return situationReader(bot, targetStateIds)(position);
}

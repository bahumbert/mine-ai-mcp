/**
 * Ask the server to send a cell again.
 *
 * A client that holds air where the server holds a block (ghost air, run 16) is freed by any packet that makes the
 * server answer for that cell: a use-on-block is always answered with the clicked cell and its neighbour on the face
 * (run 10, Finn). The use goes out with the empty off hand while sneaking, so no item is used and no block is opened or
 * placed; a held off-hand item makes it `unavailable` rather than swapped away from the bot. The same ask repairs a break
 * the server dropped: the client wrote air, the server kept the block.
 */
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import type { WorldAgeOptions } from "../../world/world-age.js";
import type { CellResync } from "../bot.js";
import { watchServerChange } from "./server-block-changes.js";
import { setSneaking } from "./sneak.js";

const TOP_FACE = 1;
const OFF_HAND = 1;
/** Mineflayer's one counter of interaction sequences: a second counter would collide with its pending placements. */
const { nextInteractionSequence } = createRequire(import.meta.url)("mineflayer/lib/interaction_sequence.js") as {
  nextInteractionSequence(bot: object): number | undefined;
};

/** The use-on-block packet of 1.21.4 (the only shape written; another protocol is `unavailable`). */
function useCellTop(bot: Bot, cell: Vec3): void {
  bot._client.write("block_place", {
    location: cell,
    direction: TOP_FACE,
    hand: OFF_HAND,
    cursorX: 0.5,
    cursorY: 1,
    cursorZ: 0.5,
    insideBlock: false,
    sequence: nextInteractionSequence(bot),
    worldBorderHit: false,
  });
}

function canUseOffHand(bot: Bot): boolean {
  if (!bot.supportFeature("blockPlaceHasInsideBlock") || bot.supportFeature("doesntHaveOffHandSlot")) return false;
  return !bot.inventory.slots[bot.getEquipmentDestSlot("off-hand")];
}

/**
 * Sends the use and waits for the server's packet for `cell` (`block_change`, a `multi_block_change` listing it, or its
 * column sent again) for `SERVER_ANSWER_TICKS` of world age or `SERVER_ANSWER_WALL_MS`, whichever comes first. Every
 * listener is removed and the bot stands up on every path; an abort rejects with the signal's reason.
 */
export async function requestCellResync(
  bot: Bot,
  cell: Vec3,
  signal: AbortSignal,
  clock: Partial<Pick<WorldAgeOptions, "now" | "sleep">> = {},
): Promise<CellResync> {
  if (!canUseOffHand(bot)) return "unavailable";
  const watch = watchServerChange(bot, cell);
  try {
    setSneaking(bot, true);
    try {
      useCellTop(bot, cell);
    } finally {
      setSneaking(bot, false);
    }
    return (await watch.answer(signal, clock)) ? "resent" : "unanswered";
  } finally {
    watch.dispose();
  }
}

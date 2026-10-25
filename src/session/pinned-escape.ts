/**
 * What a pinned bot's next movement action starts with (see `pinned-watch.ts`). The runner has already run the action's
 * preparation, which gets the body out of a boat; what is left is water or air the server holds, and every route of the
 * action then starts as an escape (`NavigationRuntime.routesAsEscape`). Supported and climbing stances need nothing: the
 * first route starts from them.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { requestCellResync } from "../navigation/mineflayer/cell-resync.js";
import { CLIMBABLES } from "../navigation/mineflayer/world.js";
import { supportCellOf } from "../navigation/world/world.js";
import { isInWater } from "../survival/perception/body.js";
import { swimToBreathableCell } from "../survival/positioning/swim-to-air.js";
import type { PinnedEscape } from "./pinned-watch.js";

/**
 * The cell to ask the server for when the body hangs in the air over a cell its own world shows empty (ghost air: the
 * server holds a block there, run 16), else null. The same stance the navigation observation calls airborne.
 */
function ghostAirCell(bot: Bot): Vec3 | null {
  const { entity } = bot;
  if (entity.onGround || isInWater(bot)) return null;
  const feet = bot.blockAt(entity.position.floored());
  if (feet && CLIMBABLES.has(feet.name)) return null;
  const cell = supportCellOf(entity.position);
  const support = bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
  return support?.boundingBox === "empty" ? new Vec3(cell.x, cell.y, cell.z) : null;
}

/** The escape of one runtime: a swim to air in water, a resend of the cell under a bot the server holds, and routes that start as escapes while the action runs. */
export function createPinnedEscape(bot: Bot, routesAsEscape: () => Disposable): PinnedEscape {
  return {
    leave: async (signal) => {
      if (isInWater(bot)) {
        await swimToBreathableCell(bot, signal);
        return;
      }
      const held = ghostAirCell(bot);
      if (held) await requestCellResync(bot, held, signal);
    },
    routesAsEscape,
  };
}

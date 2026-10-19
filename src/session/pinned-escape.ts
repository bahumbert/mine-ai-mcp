/**
 * What a pinned bot's next movement action starts with (see `pinned-watch.ts`). The runner has already run the action's
 * preparation, which gets the body out of a boat; what is left is water, and every route of the action then starts as an
 * escape (`NavigationRuntime.routesAsEscape`).
 */
import type { Bot } from "mineflayer";
import { isInWater } from "../survival/perception/body.js";
import { swimToBreathableCell } from "../survival/positioning/swim-to-air.js";
import type { PinnedEscape } from "./pinned-watch.js";

/** The escape of one runtime: a swim to air when in water, and routes that start as escapes while the action runs. */
export function createPinnedEscape(bot: Bot, routesAsEscape: () => Disposable): PinnedEscape {
  return {
    leave: async (signal) => {
      if (isInWater(bot)) await swimToBreathableCell(bot, signal);
    },
    routesAsEscape,
  };
}

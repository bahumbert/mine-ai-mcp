import type { Bot } from "mineflayer";
import { boatUnderFeetAtSea, takeBoatBack } from "../actions/navigate/boat-crossing.js";
import { clearBodyWebs } from "../actions/navigate/web-clearance.js";
import type { NavigationRuntime } from "../navigation/index.js";

/** Reset the admitted body before an action or survival response begins movement. */
export async function prepareBotForMovement(bot: Bot, navigation: NavigationRuntime, signal?: AbortSignal): Promise<void> {
  bot.clearControlStates();
  navigation.cancel("foreground action preparation");
  bot.deactivateItem();

  if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
  if (bot.entity.vehicle) bot.dismount();
  if (bot.isSleeping) await bot.wake();
  // Standing on a boat out at sea with none carried (got off it at a login or a stop): taken back, or every way on is
  // refused "no boat is carried" (live 2026-10-10: Vex, a whole run).
  const boat = boatUnderFeetAtSea(bot);
  if (boat !== null) await takeBoatBack(bot, boat);
  // A web in the feet or head cell keeps the body from jumping, so every step up the route fails (live 2026-10-10:
  // Tom, five routes in a row "No observed settled arrival"). Every movement action starts here, not only navigate.
  await clearBodyWebs(bot, signal);
}

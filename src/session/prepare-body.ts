import type { Bot } from "mineflayer";
import { boatUnderFeetAtSea, takeBoatBack } from "../actions/navigate/boat-crossing.js";
import type { NavigationRuntime } from "../navigation/index.js";

/** Reset the admitted body before an action or survival response begins movement. */
export async function prepareBotForMovement(bot: Bot, navigation: NavigationRuntime): Promise<void> {
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
}

import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { boatToTakeBack, isBoatEntity, takeBoatBack } from "../actions/navigate/boat-crossing.js";
import { getOff } from "../actions/navigate/boat-get-off.js";
import { freeHeldSeat } from "../actions/navigate/server-seat-watch.js";
import { clearBodyWebs } from "../actions/navigate/web-clearance.js";
import type { NavigationRuntime } from "../navigation/index.js";

/** Reset the admitted body before an action or survival response begins movement. */
export async function prepareBotForMovement(bot: Bot, navigation: NavigationRuntime, signal?: AbortSignal): Promise<void> {
  bot.clearControlStates();
  navigation.cancel("foreground action preparation");
  bot.deactivateItem();

  if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
  // A seat the server still holds after an earlier get-off (her client walked free) is freed first: every move she makes
  // is ignored until it is (live 2026-10-19, Cleo: 188 blocks swum north while the server kept her in the boat).
  await freeHeldSeat(bot, signal === undefined ? {} : { signal });
  // A boat she was left riding at sea (an exploration ride that stopped for want of land) is got off, and she then stands
  // on it: taken back below, so the route goes in where she floats.
  let justLeft: Entity | null = null;
  if (isBoatEntity(bot.entity.vehicle)) justLeft = (await getOff(bot)).vehicle;
  else if (bot.entity.vehicle) bot.dismount();
  if (bot.isSleeping) await bot.wake();
  // The boat she just left is taken back whatever she carries, or one she stands on out at sea with none carried (got off
  // it at a login or a stop): or every way on is refused "no boat is carried" (live 2026-10-10: Vex, a whole run).
  const boat = boatToTakeBack(bot, justLeft);
  if (boat !== null) await takeBoatBack(bot, boat);
  // A web in the feet or head cell keeps the body from jumping, so every step up the route fails (live 2026-10-10:
  // Tom, five routes in a row "No observed settled arrival"). Every movement action starts here, not only navigate.
  await clearBodyWebs(bot, signal);
}

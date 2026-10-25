import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { boatToTakeBack } from "../actions/navigate/boat-crossing.js";
import { isBoatEntity } from "../actions/navigate/boat-entities.js";
import { takeBoatBackReport, type TakeBackOptions, type TakeBackReport } from "../actions/navigate/boat-take-back.js";
import { getOff } from "../actions/navigate/boat-get-off.js";
import { freeHeldSeat } from "../actions/navigate/server-seat-watch.js";
import { clearBodyWebs } from "../actions/navigate/web-clearance.js";
import type { NavigationRuntime } from "../navigation/index.js";

/**
 * The boat part of the preparation: a boat she was left riding (an exploration ride that stopped for want of land, a
 * cancelled ride) is got off, and she then stands on it; it is taken back whatever she carries (live 2026-10-19, Cleo:
 * with a second boat carried nothing broke it and the server kept her seated), or any boat she stands on wherever it
 * floats ({@link boatUnderFeet}: a stop or a cut take-back left her on it; live 2026-10-10 Vex at sea, run 20 Dirk and
 * Vex by a shore). Returns the take-back's report, null when no boat was there to take back.
 */
export async function leaveBoatSeat(bot: Bot, signal?: AbortSignal, takeBack: Pick<TakeBackOptions, "maxHits"> = {}): Promise<TakeBackReport | null> {
  const justLeft: Entity | null = isBoatEntity(bot.entity.vehicle) ? (await getOff(bot)).vehicle : null;
  const boat = boatToTakeBack(bot, justLeft);
  return boat === null ? null : takeBoatBackReport(bot, boat, signal, takeBack);
}

/** Reset the admitted body before an action or survival response begins movement. */
export async function prepareBotForMovement(
  bot: Bot,
  navigation: NavigationRuntime,
  signal?: AbortSignal,
  options: {
    readonly keepBoatSeat?: boolean;
    /** Cap on the hits that take a boat back (default: the take-back's own time bound): a caller a mob is attacking cannot wait. */
    readonly takeBackHits?: number;
  } = {},
): Promise<void> {
  bot.clearControlStates();
  navigation.cancel("foreground action preparation");
  bot.deactivateItem();

  if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
  // A seat the server still holds after an earlier get-off (her client walked free) is freed first: every move she makes
  // is ignored until it is (live 2026-10-19, Cleo: 188 blocks swum north while the server kept her in the boat).
  await freeHeldSeat(bot, { ...(signal && { signal }), ...(options.takeBackHits !== undefined && { maxHits: options.takeBackHits }) });
  // A navigate keeps the boat she sits in: it rides on over deep water, or gets off itself when the way is over land.
  if (!(options.keepBoatSeat === true && isBoatEntity(bot.entity.vehicle))) await leaveBoatSeat(bot, signal, options.takeBackHits === undefined ? {} : { maxHits: options.takeBackHits });
  if (bot.entity.vehicle && !isBoatEntity(bot.entity.vehicle)) bot.dismount();
  if (bot.isSleeping) await bot.wake();
  // A web in the feet or head cell keeps the body from jumping, so every step up the route fails (live 2026-10-10:
  // Tom, five routes in a row "No observed settled arrival"). Every movement action starts here, not only navigate.
  await clearBodyWebs(bot, signal);
}

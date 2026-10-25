/** The take-back tried again before a crossing's onward leg, when the boat still lies under her feet. */
import type { Bot } from "mineflayer";
import { leaveBoatSeat } from "../../session/prepare-body.js";
import { boatUnderFeet, type CrossingResult } from "./boat-crossing.js";
import { BOAT_REACH, boatsCarried, nearestBoat } from "./boat-entities.js";
import { type BoatLeft, boatLeftAfter } from "./boat-take-back.js";

/**
 * The onward leg of a crossing routes from where she stands, and a boat the take-back left under her pins every route
 * (run 20, Dirk: the leg "succeeded" on top of it). When the crossing left a boat and one is under her feet, it is taken
 * back now, with the full time bound; returns what is left after it (nothing when one more boat is carried), told from
 * the retry's own hits, not the first take-back's.
 */
export async function retryBoatTakeBack(bot: Bot, crossed: CrossingResult, signal?: AbortSignal): Promise<BoatLeft | undefined> {
  if (crossed.boatLeft === undefined || boatUnderFeet(bot) === null) return crossed.boatLeft;
  const before = boatsCarried(bot);
  const retry = await leaveBoatSeat(bot, signal);
  signal?.throwIfAborted();
  if (retry === null || boatsCarried(bot) > before) return retry === null ? crossed.boatLeft : undefined;
  const boat = nearestBoat(bot, bot.entity.position, BOAT_REACH);
  return boatLeftAfter(bot, retry, { boat, underFeet: boatUnderFeet(bot) !== null, cancelled: false });
}

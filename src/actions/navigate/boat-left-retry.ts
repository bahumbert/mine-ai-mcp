/** The take-back tried again before a crossing's onward leg, when the boat still lies under her feet. */
import type { Bot } from "mineflayer";
import { leaveBoatSeat } from "../../session/prepare-body.js";
import { boatUnderFeet, type CrossingResult } from "./boat-crossing.js";
import { type BoatLeft, boatLeftAfter } from "./boat-take-back.js";

/**
 * The onward leg of a crossing routes from where she stands, and a boat the take-back left under her pins every route
 * (run 20, Dirk: the leg "succeeded" on top of it). When the crossing left a boat and one is under her feet, it is taken
 * back now, with the full time bound; returns what is left after it (nothing when one more boat is carried), told from
 * the retry's own hits, not the first take-back's, about the boat that lay under her feet when it began.
 */
export async function retryBoatTakeBack(bot: Bot, crossed: CrossingResult, signal?: AbortSignal): Promise<BoatLeft | undefined> {
  const boat = crossed.boatLeft === undefined ? null : boatUnderFeet(bot);
  if (boat === null) return crossed.boatLeft;
  const retry = await leaveBoatSeat(bot, signal);
  signal?.throwIfAborted();
  if (retry === null) return crossed.boatLeft;
  if (retry.carried) return undefined;
  return boatLeftAfter(bot, retry, { boat, underFeet: boatUnderFeet(bot) !== null, cancelled: false });
}

/** The `boatLeft` field of a navigate's evidence: the onward leg's own record wins over the crossing's; no field when neither left a boat. */
export function boatLeftEvidence(onward: BoatLeft | undefined, crossing: BoatLeft | undefined): { readonly boatLeft?: BoatLeft } {
  const left = onward ?? crossing;
  return left === undefined ? {} : { boatLeft: left };
}

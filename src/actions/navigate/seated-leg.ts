/**
 * A navigate that starts in a boat (after a cancelled ride, a reflex, a stay at sea) rides on from the seat when the
 * straight way is over deep water, instead of getting off and putting the boat in again; over land it gets off first.
 */
import type { Bot } from "mineflayer";
import { isBoatEntity, deepWaterOnTheWay, type DeepWaterLine } from "./boat-crossing.js";
import { leaveBoatSeat } from "../../session/prepare-body.js";
import { currentVehicle } from "./vehicle-sync.js";

export type SeatedLeg =
  | { readonly kind: "not_seated" }
  /** Already on the deep water, in the boat: the ride goes on. */
  | { readonly kind: "ride_on"; readonly water: DeepWaterLine }
  /** No deep water on the way, or the boat is by the shore: the seat is left (the boat taken back) before the route. */
  | { readonly kind: "get_off" };

/** What a leg that starts at the bot's place does about the boat she sits in. */
export function seatedLegPlan(bot: Bot, target: { readonly x: number; readonly z: number }): SeatedLeg {
  if (!isBoatEntity(currentVehicle(bot))) return { kind: "not_seated" };
  const water = deepWaterOnTheWay(bot, bot.entity.position, target);
  // A shore before the deep water (`shore` set): the boat is not out on it, the way starts on foot.
  return water !== null && water.shore === null ? { kind: "ride_on", water } : { kind: "get_off" };
}

/**
 * A leg that starts seated in a boat (a cancelled ride, a stay at sea): over deep open water on the straight way `ride`
 * goes on from the seat, with no get-off and no second launch; otherwise the seat is left and the boat taken back before
 * the route. Null when the route goes on as usual.
 */
export async function startFromSeat<T>(
  bot: Bot,
  target: { readonly x: number; readonly z: number },
  signal: AbortSignal | undefined,
  ride: (water: DeepWaterLine) => Promise<T>,
): Promise<T | null> {
  const plan = seatedLegPlan(bot, target);
  if (plan.kind === "get_off") await leaveBoatSeat(bot, signal);
  return plan.kind === "ride_on" ? ride(plan.water) : null;
}

// The vehicle the client view says she sits in, for the status snapshot.
import type { Bot } from "mineflayer";
import { currentVehicle } from "../navigate/vehicle-sync.js";
import type { LiveSituation } from "./contract.js";

/** The vehicle the client view says she sits in; null on foot. */
export function observeVehicle(bot: Bot): LiveSituation["vehicle"] {
  const vehicle = currentVehicle(bot);
  return vehicle === null ? null : { name: vehicle.name ?? "unknown", id: vehicle.id };
}

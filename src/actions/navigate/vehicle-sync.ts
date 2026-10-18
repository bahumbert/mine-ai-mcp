import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";

/**
 * Keeps Mineflayer's idea of the bot's vehicle in step with the server's. Mineflayer switches physics off at a mount
 * and back on only at a server position, and acts on a passenger list only when it names the bot: a list for her
 * vehicle without her, or that vehicle gone (broken, unloaded), left it riding with physics off for good, every later
 * action waiting for a tick (run 14b). Either is taken here as her get-off: the vehicle is forgotten and physics
 * resumed where she is. (A vanilla 1.21.4 server sends the rider nothing at all at her own shift get-off: that one is
 * `getOff`'s job, in `boat-crossing.ts`.)
 */

/** The vehicle the bot rides, as Mineflayer keeps it on the bot or (its type omits the first) on her entity. */
export function currentVehicle(bot: Bot): Entity | null {
  return (bot as unknown as { vehicle: Entity | null }).vehicle ?? bot.entity?.vehicle ?? null;
}

/** A passenger list for her vehicle that no longer names her: the server has let her off. */
export function letsHerOff(bot: Bot, vehicle: Entity | null, packet: { readonly entityId: number; readonly passengers: readonly number[] }): boolean {
  return vehicle !== null && packet.entityId === vehicle.id && !packet.passengers.includes(bot.entity.id);
}

/**
 * Mineflayer keeps `vehicle` on the bot and on its entity after the server let her off; both are cleared, or the next
 * movement's preparation sees the entity still riding and fails "dismount: not mounted" (live 2026-10-04). Returns the
 * vehicle she was in.
 */
export function forgetVehicle(bot: Bot): Entity | null {
  const riding = bot as unknown as { vehicle: Entity | null };
  const vehicle = currentVehicle(bot);
  riding.vehicle = null;
  if (bot.entity.vehicle) {
    const passengers = bot.entity.vehicle.passengers;
    const index = passengers.indexOf(bot.entity);
    if (index !== -1) passengers.splice(index, 1);
    (bot.entity as unknown as { vehicle: Entity | null }).vehicle = null;
  }
  if (vehicle !== null) bot.emit("dismount", vehicle);
  return vehicle;
}

/** Marks of a teleport id the server never sent: it ignores the confirmation. */
const NO_TELEPORT = 2_147_483_647;

/**
 * Switches Mineflayer's physics back on where the bot stands. Physics is off from a mount until the server sends a
 * position, and Mineflayer has no other way to turn it on, so the client's own position handler is given one.
 */
export function resumePhysics(bot: Bot): void {
  const { x, y, z } = bot.entity.position;
  bot._client.emit("position", {
    x, y, z,
    yaw: 180 - (bot.entity.yaw * 180) / Math.PI,
    pitch: -(bot.entity.pitch * 180) / Math.PI,
    flags: { x: false, y: false, z: false, yaw: false, pitch: false },
    teleportId: NO_TELEPORT,
  });
}

/**
 * After an action stalled for want of physics ticks: physics back on where she is (run 14b: nothing did, and every
 * later action stalled too). Not on a vehicle (a passenger owes no tick, and leaving it is the next movement's job) and
 * not dead (the respawn's position turns it on).
 */
export function recoverPhysics(bot: Bot): void {
  if (currentVehicle(bot) !== null || !(bot.health > 0) || bot.entity?.position === undefined) return;
  resumePhysics(bot);
}

/** Watches for the server letting her off her vehicle, for as long as the runtime lives; returns the stop. */
export function watchVehicle(bot: Bot): () => void {
  const letOff = () => {
    if (forgetVehicle(bot) !== null) resumePhysics(bot);
  };
  const onPassengers = (packet: { readonly entityId: number; readonly passengers: readonly number[] }) => {
    if (letsHerOff(bot, currentVehicle(bot), packet)) letOff();
  };
  const onGone = (entity: Entity) => {
    const vehicle = currentVehicle(bot);
    if (vehicle !== null && entity.id === vehicle.id) letOff();
  };
  bot._client.on("set_passengers", onPassengers);
  bot.on("entityGone", onGone);
  return () => {
    bot._client.off("set_passengers", onPassengers);
    bot.off("entityGone", onGone);
  };
}

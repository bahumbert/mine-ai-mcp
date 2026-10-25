/**
 * The fake bot's rides: the mount the server confirms, the two ways off a boat with what each side hears of them
 * (contract checks `boat-get-off-by-shift`, `boat-dismount-ignored`, Mine Labs 2026-10-21), and the boat the rider moves
 * with `vehicle_move` (contract check `boat-follows-vehicle-move`, Mine Labs 2026-10-23). A mount the server refuses is
 * answered with silence (contract check `boat-mount-refused`): a boat out of reach, a boat with its two seats taken. The
 * shift is read at a server tick, not at its packet: pressed and released with no tick between it does nothing
 * (contract check `boat-shift-within-one-tick`). The boat's hit and break are in `fake-bot-boat-damage.ts`.
 */
import { createRequire } from "node:module";
import type { FakeBot } from "./fake-bot.js";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { boxMeetsBlocks } from "./fake-bot-boxes.js";
import { inEntityReach, vehicleOnServer } from "./fake-bot-entity-reach.js";
import { onServerTick } from "./fake-bot-server-ticks.js";
import type { FakeServer } from "./fake-server.js";

const require = createRequire(import.meta.url);
const { toNotchianYaw } = require("mineflayer/lib/conversions") as { toNotchianYaw(yaw: number): number };

/** `entity_action` 0: the shift pressed, which a 1.21.4 server reads as the get-off (`sneak.ts` `writeShiftKey`). */
const PRESS_SHIFT = 0;

/** A boat has two seats: the server refused a mount into a boat with two passengers and took one into a boat with one. */
const BOAT_SEATS = 2;
/** `entity_action` 1: the shift released. */
const RELEASE_SHIFT = 1;

/** The server moves a seated rider's client to the boat, this far below its feet (-60.4125 for a boat at -60: contract check `boat-broken-by-attack`). */
const SEAT_BELOW_BOAT = -0.4125;

/** The client's side of a confirmed mount: Mineflayer's `set_passengers` handler (`entities.js:794-811`), and the rider's own entity at the seat. */
function seatOnClient(bot: FakeBot, vehicle: Entity): void {
  bot.entity.position.set(vehicle.position.x, vehicle.position.y + SEAT_BELOW_BOAT, vehicle.position.z);
  bot.entity.vehicle = vehicle;
  vehicle.passengers.push(bot.entity);
  bot.vehicle = vehicle;
  bot.emit("mount");
}

/** The passenger list the server sends a bot it seats: her first, then the passengers already in (`[1, 10]` measured, contract check `boat-mount-refused`). */
function listAfterSeating(server: FakeServer, vehicle: Entity, riderId: number): { entityId: number; passengers: number[] } {
  return { entityId: vehicle.id, passengers: [riderId, ...server.ridersOf(vehicle.id).filter((id) => id !== riderId)] };
}

/** The rider's `vehicle_move` as the client writes it (`BoatRide`). */
interface VehicleMove {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
}

/**
 * The server's side of a rider's `vehicle_move`, from a rider it has seated (a bot it does not have in the boat moves
 * nothing and hears nothing): a move that puts the boat inside a block is put back, with the server's own `vehicle_move`
 * carrying the last position it took; any other move is the boat's new place, which the client hears as the entity moving.
 */
function answerVehicleMove(bot: FakeBot, server: FakeServer, move: VehicleMove, yaws: Map<number, number>): void {
  const boat = bot.vehicle;
  if (boat === null || !server.ridersOf(boat.id).includes(bot.entity.id)) return;
  const at = new Vec3(move.x, move.y, move.z);
  if (boxMeetsBlocks(bot, at, boat.width, boat.height)) {
    const kept = server.serverPositionOf(boat.id) ?? boat.position;
    const yaw = yaws.get(boat.id) ?? toNotchianYaw(boat.yaw);
    bot._client.emit("vehicle_move", { x: kept.x, y: kept.y, z: kept.z, yaw, pitch: 0 });
    return;
  }
  yaws.set(boat.id, move.yaw);
  server.setServerPosition(boat.id, at);
  boat.position.set(at.x, at.y, at.z);
  bot.emit("entityMoved", boat);
}

/** The server seats the rider on a use of a vehicle in reach with a seat free, and tells her with the passenger list. */
function answerMount(bot: FakeBot, server: FakeServer, target: number): void {
  const vehicle = bot.entities[target];
  if (vehicle === undefined || server.ridersOf(target).length >= BOAT_SEATS || server.ridersOf(target).includes(bot.entity.id) || !inEntityReach(bot, server, vehicle)) return;
  server.seatRider(target, bot.entity.id);
  // Mineflayer's handler for the list runs before any other listener of the packet: the client is seated when the list is heard.
  const list = listAfterSeating(server, vehicle, bot.entity.id);
  seatOnClient(bot, vehicle);
  bot._client.emit("set_passengers", list);
}

/**
 * The server lets her off at the boat's top and sends her a `position` there (a real server sent 2 on land, 11-14 on
 * water) and the boat's passenger list without her. Mineflayer's `set_passengers` handler changes `bot.vehicle` only for
 * a list naming her, so the client keeps it; the position restarts physics (`physics.js`).
 */
function getOffOnServer(bot: FakeBot, server: FakeServer): void {
  const vehicle = vehicleOnServer(bot, server);
  if (vehicle === null) return;
  const top = vehicle.position.offset(0, vehicle.height, 0);
  server.freeRider(vehicle.id, bot.entity.id);
  server.setServerPosition(bot.entity.id, top);
  bot._client.emit("set_passengers", { entityId: vehicle.id, passengers: [...server.ridersOf(vehicle.id)] });
  server.sendPosition(top);
}

/** Seat `names` on `vehicle` from the start, on the server and on the client (the `Passengers` a boat is summoned with). */
export function seatStartingPassengers(bot: FakeBot, server: FakeServer, vehicle: Entity, riders: readonly Entity[]): void {
  for (const rider of riders) {
    bot.entities[rider.id] = rider;
    rider.vehicle = vehicle;
    vehicle.passengers.push(rider);
    server.seatRider(vehicle.id, rider.id);
  }
}

/** Give `bot` `mount`, `dismount` and the server's answer to the shift and to the rider's `vehicle_move`. */
export function attachFakeVehicle(bot: FakeBot, parts: { server: FakeServer }): void {
  const { server } = parts;
  const yaws = new Map<number, number>();
  server.onPacket("vehicle_move", (data) => server.answer(() => answerVehicleMove(bot, server, data as VehicleMove, yaws)));
  bot.vehicle = null; // the entity's own `vehicle` starts null (prismarine-entity)
  bot.mount = (target) => bot._client.write("use_entity", { target: target.id, mouse: 0, sneaking: false });
  server.onPacket("use_entity", (data) => {
    const { target, mouse } = data as { target: number; mouse: number };
    if (mouse === 0) server.answer(() => answerMount(bot, server, target));
  });
  // The shift key is a state the server reads at its ticks: only a press still down at one lets her off.
  let shiftDown = false;
  server.onPacket("entity_action", (data) => {
    const { actionId } = data as { actionId: number };
    if (actionId === PRESS_SHIFT || actionId === RELEASE_SHIFT) server.answer(() => void (shiftDown = actionId === PRESS_SHIFT));
  });
  onServerTick(server, () => shiftDown && getOffOnServer(bot, server));
  // `dismount()` sends the jump input (`entities.js:902-916`), which a boat ignores (`navigation-and-boats.md`).
  bot.dismount = () => {
    if (bot.vehicle) bot._client.write("player_input", { inputs: { jump: true } });
    else bot.emit("error", new Error("dismount: not mounted"));
  };
}

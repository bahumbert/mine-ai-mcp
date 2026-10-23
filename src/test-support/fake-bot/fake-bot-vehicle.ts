/**
 * The fake bot's rides: the mount the server confirms, the two ways off a boat with what each side hears of them
 * (contract checks `boat-get-off-by-shift`, `boat-dismount-ignored`, Mine Labs 2026-10-21), and the boat the rider moves
 * with `vehicle_move` (contract check `boat-follows-vehicle-move`, Mine Labs 2026-10-23).
 */
import { createRequire } from "node:module";
import type { FakeBot } from "./fake-bot.js";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { boxMeetsBlocks } from "./fake-bot-boxes.js";
import type { FakeServer } from "./fake-server.js";

const require = createRequire(import.meta.url);
const { toNotchianYaw } = require("mineflayer/lib/conversions") as { toNotchianYaw(yaw: number): number };

/** `entity_action` 0: the shift pressed, which a 1.21.4 server reads as the get-off (`sneak.ts` `writeShiftKey`). */
const PRESS_SHIFT = 0;

/** The client's side of a confirmed mount: Mineflayer's `set_passengers` handler (`entities.js:794-811`). */
function seatOnClient(bot: FakeBot, vehicle: Entity): void {
  bot.entity.vehicle = vehicle;
  vehicle.passengers.push(bot.entity);
  bot.vehicle = vehicle;
  bot.emit("mount");
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
  if (boat === null || server.riderOf(boat.id) !== bot.entity.id) return;
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

/** Give `bot` `mount`, `dismount` and the server's answer to the shift and to the rider's `vehicle_move`. */
export function attachFakeVehicle(bot: FakeBot, server: FakeServer): void {
  const yaws = new Map<number, number>();
  server.onPacket("vehicle_move", (data) => server.answer(() => answerVehicleMove(bot, server, data as VehicleMove, yaws)));
  bot.vehicle = null; // the entity's own `vehicle` starts null (prismarine-entity)
  bot.mount = (target) => bot._client.write("use_entity", { target: target.id, mouse: 0, sneaking: false });
  // The server seats the rider on the use and tells her with the passenger list.
  server.onPacket("use_entity", (data) => {
    const { target, mouse } = data as { target: number; mouse: number };
    const vehicle = bot.entities[target];
    if (mouse !== 0 || vehicle === undefined || server.riderOf(target) !== null) return;
    server.answer(() => {
      server.seatRider(target, bot.entity.id);
      seatOnClient(bot, vehicle);
    });
  });
  // The get-off: the server lets her off at the boat's top, sends her a `position` there (a real server sent 2 on land,
  // 11-14 on water) and the boat's passenger list without her. Mineflayer's `set_passengers` handler changes
  // `bot.vehicle` only for a list naming her, so the client keeps it; the position restarts physics (`physics.js`).
  server.onPacket("entity_action", (data) => {
    if ((data as { actionId: number }).actionId !== PRESS_SHIFT) return;
    server.answer(() => {
      const vehicle = bot.vehicle;
      if (vehicle === null || server.riderOf(vehicle.id) !== bot.entity.id) return;
      const top = vehicle.position.offset(0, vehicle.height, 0);
      server.freeRider(vehicle.id);
      server.setServerPosition(bot.entity.id, top);
      bot._client.emit("set_passengers", { entityId: vehicle.id, passengers: [] });
      server.sendPosition(top);
    });
  });
  // `dismount()` sends the jump input (`entities.js:902-916`), which a boat ignores (`navigation-and-boats.md`).
  bot.dismount = () => {
    if (bot.vehicle) bot._client.write("player_input", { inputs: { jump: true } });
    else bot.emit("error", new Error("dismount: not mounted"));
  };
}

/**
 * The fake bot's rides: the mount the server confirms, and the two ways off a boat with what each side hears of them
 * (`facts/navigation-and-boats.md` "A vanilla 1.21.4 server tells the rider nothing at her get-off", run 14b).
 */
import type { FakeBot } from "./fake-bot.js";
import type { Entity } from "prismarine-entity";
import type { FakeServer } from "./fake-server.js";

/** `entity_action` 0: the shift pressed, which a 1.21.4 server reads as the get-off (`sneak.ts` `writeShiftKey`). */
const PRESS_SHIFT = 0;

/** The client's side of a confirmed mount: Mineflayer's `set_passengers` handler (`entities.js:794-811`). */
function seatOnClient(bot: FakeBot, vehicle: Entity): void {
  bot.entity.vehicle = vehicle;
  vehicle.passengers.push(bot.entity);
  bot.vehicle = vehicle;
  bot.emit("mount");
}

/** Give `bot` `mount`, `dismount` and the server's answer to the shift. */
export function attachFakeVehicle(bot: FakeBot, server: FakeServer): void {
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
  // The get-off: the server lets her off at the boat's top and sends her nothing, no `position` and no passenger list,
  // so the client keeps `vehicle` and physics stays off (`entities.js:768-829`, `physics.js:437-448`).
  server.onPacket("entity_action", (data) => {
    if ((data as { actionId: number }).actionId !== PRESS_SHIFT) return;
    server.answer(() => {
      const vehicle = bot.vehicle;
      if (vehicle === null || server.riderOf(vehicle.id) !== bot.entity.id) return;
      server.freeRider(vehicle.id);
      server.setServerPosition(bot.entity.id, vehicle.position.offset(0, vehicle.height, 0));
    });
  });
  // `dismount()` sends the jump input (`entities.js:902-916`), which a boat ignores (`navigation-and-boats.md`).
  bot.dismount = () => {
    if (bot.vehicle) bot._client.write("player_input", { inputs: { jump: true } });
    else bot.emit("error", new Error("dismount: not mounted"));
  };
}

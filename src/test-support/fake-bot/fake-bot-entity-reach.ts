/** What the fake server knows of where the bot is and what it lets her use or hit: her seat, her eye, the reach (contract check `boat-mount-refused`). */
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";
import { distanceToBox } from "./fake-bot-boxes.js";
import { eyeHeightOf } from "./fake-bot-physics.js";
import type { FakeBot } from "./fake-bot.js";
import type { FakeServer } from "./fake-server.js";

/** The boats' items are named like their entities (`oak_boat`, `bamboo_raft`). */
export const BOAT_NAME = /_(boat|raft)$/;
/** The nearest point of an entity's box that the server lets a bot use: a boat 6 blocks off was taken, one 7 blocks off was not. A hit shares it (vanilla's rule, not measured). */
export const ENTITY_REACH = 6;

/** The vehicle the server has the bot in, whatever her client believes (a seat the server kept after her client walked free). */
export function vehicleOnServer(bot: FakeBot, server: FakeServer): Entity | null {
  return Object.values(bot.entities).find((entity) => server.ridersOf(entity.id).includes(bot.entity.id)) ?? null;
}

/** Where the server has the bot's eye: in her seat when she sits, else where it last put her, else where her client is. */
export function eyeOnServer(bot: FakeBot, server: FakeServer): Vec3 {
  const vehicle = vehicleOnServer(bot, server);
  const feet = vehicle === null ? (server.serverPositionOf(bot.entity.id) ?? bot.entity.position) : (server.serverPositionOf(vehicle.id) ?? vehicle.position);
  return feet.offset(0, eyeHeightOf(bot.entity), 0);
}

/** Whether `target` is within the server's reach of the bot. */
export function inEntityReach(bot: FakeBot, server: FakeServer, target: Entity): boolean {
  return distanceToBox(eyeOnServer(bot, server), server.serverPositionOf(target.id) ?? target.position, target.width, target.height) < ENTITY_REACH;
}

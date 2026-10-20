/**
 * A seat the server still holds (backlog 76, Cleo, run 16): after a get-off its client walks free while the server keeps
 * her seated in the boat (her moves are ignored, no warning, no chunk centre change). Nothing tells the client, so the
 * watch reads the signs: the server sends a new chunk centre (`update_view_position`) at each chunk border of the
 * position it holds her at, so a client that crossed 2 borders with no centre and no real server position is held; a
 * real server position that puts her back at the boat while her client is far away is the server's "moved too quickly".
 * The next movement's preparation frees it ({@link freeHeldSeat}): shift held again and the boat broken, which ejects
 * its rider on the server.
 */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { writeShiftKey } from "../../navigation/mineflayer/sneak.js";
import { waitForWorldAge } from "../../world/world-age.js";
import { BOAT_REACH, nearestBoat, takeBoatBack } from "./boat-crossing.js";
import { NO_TELEPORT } from "./vehicle-sync.js";

/** Chunk borders the client crossed with no chunk centre update from the server before she is taken to be held. */
const HELD_CHUNKS = 2;
/** A real server position this close to where the boat stood is the server holding her there. */
const AT_THE_BOAT = 2;
/** ...and her client this far from it disagrees with the server (vanilla: "moved too quickly"). */
const CLIENT_APART = 16;
/** Longest the freeing takes on the wall clock, the boat's break included. */
const FREE_WALL_MS = 15_000;

export interface ServerSeatWatch {
  /** Where the server holds her seated, when the signs say it does; null otherwise. */
  heldAt(): Vec3 | null;
  /** The server answered the freeing: forget the held seat. */
  release(): void;
  stop(): void;
}

interface Seat {
  readonly place: Vec3;
  /** A real server position came since the get-off: the chunk border test no longer says anything. */
  serverSpoke: boolean;
  /** A real server position put her back at the boat while her client was far away. */
  held: boolean;
}

interface ServerPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly flags?: { readonly x?: boolean; readonly y?: boolean; readonly z?: boolean };
  readonly teleportId: number;
}

const watches = new WeakMap<Bot, ServerSeatWatch>();

/** The watch the runtime set on this bot, if any. */
export function serverSeatWatchOf(bot: Bot): ServerSeatWatch | undefined {
  return watches.get(bot);
}

const chunkOf = (coordinate: number): number => Math.floor(coordinate / 16);

/** The place a server position packet names, relative flags resolved against where her client is now. */
function placeOf(packet: ServerPosition, client: Vec3): Vec3 {
  return new Vec3(packet.flags?.x ? client.x + packet.x : packet.x, packet.flags?.y ? client.y + packet.y : packet.y, packet.flags?.z ? client.z + packet.z : packet.z);
}

/** Watches one bot's get-offs for a seat the server keeps; one watch per bot, stopped with the runtime. */
export function watchServerSeat(bot: Bot): ServerSeatWatch {
  let seat: Seat | null = null;
  const onDismount = (vehicle: Entity | null) => {
    seat = vehicle === null ? null : { place: vehicle.position.clone(), serverSpoke: false, held: false };
  };
  const clear = () => {
    seat = null;
  };
  // Read before Mineflayer's own handler moves her client to the packet's place.
  const onPosition = (packet: ServerPosition) => {
    if (seat === null || packet.teleportId === NO_TELEPORT) return;
    seat.serverSpoke = true;
    const client = bot.entity.position;
    if (placeOf(packet, client).distanceTo(seat.place) <= AT_THE_BOAT && client.distanceTo(seat.place) > CLIENT_APART) seat.held = true;
  };
  bot.on("dismount", onDismount);
  bot.on("mount", clear);
  bot.on("death", clear);
  bot.on("respawn", clear);
  bot._client.prependListener("position", onPosition);
  bot._client.on("update_view_position", clear);
  const watch: ServerSeatWatch = {
    heldAt() {
      if (seat === null) return null;
      const client = bot.entity.position;
      const apart = Math.max(Math.abs(chunkOf(client.x) - chunkOf(seat.place.x)), Math.abs(chunkOf(client.z) - chunkOf(seat.place.z))) >= HELD_CHUNKS;
      return seat.held || (!seat.serverSpoke && apart) ? seat.place : null;
    },
    release: clear,
    stop() {
      bot.off("dismount", onDismount);
      bot.off("mount", clear);
      bot.off("death", clear);
      bot.off("respawn", clear);
      bot._client.off("position", onPosition);
      bot._client.off("update_view_position", clear);
      watches.delete(bot);
    },
  };
  watches.set(bot, watch);
  return watch;
}

/**
 * Frees a seat the server still holds: shift held as a get-off does, the boat near where she is held broken (which
 * ejects its rider), then up to 15 s of the wall clock for the server's answer, a real position or a chunk centre.
 * Does nothing when no seat is held; throws `[SERVER_HELD_POSITION]` when the server does not answer, and then
 * remembers the seat, so the next movement tries again.
 */
export async function freeHeldSeat(bot: Bot, options: { readonly signal?: AbortSignal; readonly wallMs?: number } = {}): Promise<void> {
  const watch = serverSeatWatchOf(bot);
  const held = watch?.heldAt() ?? null;
  if (watch === undefined || held === null) return;
  const startedAt = performance.now();
  const wallMs = options.wallMs ?? FREE_WALL_MS;
  let answered = false;
  const onAnswer = (packet?: ServerPosition) => {
    if (packet?.teleportId !== NO_TELEPORT) answered = true;
  };
  bot._client.on("position", onAnswer);
  bot._client.on("update_view_position", onAnswer);
  try {
    writeShiftKey(bot, true);
    const boat = nearestBoat(bot, held, BOAT_REACH);
    if (boat !== null) await takeBoatBack(bot, boat, options.signal);
    await waitForWorldAge(bot, Number.POSITIVE_INFINITY, { wallMs: Math.max(0, wallMs - (performance.now() - startedAt)), until: () => answered, ...(options.signal && { signal: options.signal }) });
  } finally {
    bot._client.off("position", onAnswer);
    bot._client.off("update_view_position", onAnswer);
    writeShiftKey(bot, false);
  }
  if (!answered) {
    throw new Error(`[SERVER_HELD_POSITION] The server still holds you at ${Math.floor(held.x)} ${Math.floor(held.y)} ${Math.floor(held.z)} (seated in a boat there); movement was stopped. Wait a few seconds and try again: the next movement tries to free the seat again.`);
  }
  watch.release();
}

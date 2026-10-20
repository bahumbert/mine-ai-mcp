/**
 * The boat tests' shared double: a bot at the edge of a flat open sea, played by a mock 1.21.4 server (see `openSeaBot`).
 * Shared by `boat-crossing.test.ts`, `boat-get-off.test.ts` and `server-seat-watch.test.ts`.
 */
import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

export type ServerClock = "ticking" | "frozen" | { readonly frozenMs: number } | { readonly burstOnPress: number };

/**
 * The world age the client reads: 20 ticks per 50 ms (a jump of 20, as a server catching up reports it); "frozen" never
 * moves, `frozenMs` stands still that long and then jumps 200, `burstOnPress` jumps that many ticks at the shift press
 * (a client whose event loop was blocked reads its queued packets late). The clock counts from the press.
 */
function worldClock(clock: ServerClock) {
  let startedAt = performance.now();
  let pressed = false;
  const time = {
    get age() {
      const elapsed = performance.now() - startedAt;
      if (clock === "frozen") return 1_000;
      if (clock === "ticking") return 1_000 + Math.floor(elapsed / 50) * 20;
      if ("burstOnPress" in clock) return 1_000 + (pressed ? clock.burstOnPress : 0) + Math.floor(elapsed / 50) * 20;
      return 1_000 + (elapsed < clock.frozenMs ? 0 : 200 + Math.floor((elapsed - clock.frozenMs) / 50) * 20);
    },
  };
  return { time, press: () => { startedAt = performance.now(); pressed = true; } };
}

/**
 * Whether a 1.21.4 server still has her seated. It reads the shift from entity_action only (player_input is for minecart
 * steering), and only at a server tick (50 ms): a press released within the same tick does nothing. It tells the rider
 * nothing. Breaking the boat she sits in ejects her. `ignoresShift` is a server that never reads it (a held seat).
 */
function seatOnTheServer(ignoresShift: boolean) {
  let seated = false;
  let pressedTick: number | null = null;
  const tick = () => Math.floor(performance.now() / 50);
  const heldATick = () => pressedTick !== null && tick() > pressedTick && !ignoresShift;
  return {
    mount: () => { seated = true; },
    press: () => { pressedTick = tick(); },
    release: () => {
      if (heldATick()) seated = false;
      pressedTick = null;
    },
    /** The boat she sits in broke: true when it was holding her. */
    eject: () => {
      const was = seated;
      seated = false;
      return was;
    },
    seated: () => seated && !heldATick(),
  };
}

/**
 * A bot at the edge of a flat open sea (water y 50 to 62, stone under it), with one boat carried; the server is played
 * by the mock: it puts the boat in the water when the item is used, follows `vehicle_move` and records every packet.
 */
export interface OpenSeaOptions {
  /** Blocks past this z are not loaded (null from `blockAt`). */
  readonly loadedTo?: number;
  readonly answerShiftMs?: number;
  readonly serverClock?: ServerClock;
  /** The server never seats her: `mount` leaves her unseated, no `mount` event. */
  readonly neverMounts?: boolean;
  /** The server seats her (the vehicle shows) but the `mount` event only comes this long after. */
  readonly mountEventAfterMs?: number;
  readonly correctFromZ?: number;
  readonly boatsCarried?: number;
  readonly ignoresShift?: boolean;
  /** Water this deep (default: stone from y 50, 13 deep). */
  readonly waterDepth?: number;
  /** Dry land (stone to the water's level) from this z on. */
  readonly landFromZ?: number;
  /** Dry land (stone to the water's level) up to this z (and below). */
  readonly landUntilZ?: number;
  /** Other items carried (a sword for the strike tests). */
  readonly carries?: readonly string[];
}

export function openSeaBot(options: OpenSeaOptions = {}) {
  const clock = worldClock(options.serverClock ?? "ticking");
  const seat = seatOnTheServer(options.ignoresShift === true);
  const carried = Array.from({ length: options.boatsCarried ?? 1 }, () => ({ name: "oak_boat", count: 1 }));
  const written: { name: string; packet: Record<string, unknown>; at: number }[] = [];
  const attacks: number[] = [];
  const equips: string[] = [];
  const extras = (options.carries ?? []).map((name) => ({ name, count: 1 }));
  const self = { id: 1, position: new Vec3(0.5, 63, 0.5), yaw: 0, pitch: 0, onGround: false, vehicle: null as unknown };
  const entities: Record<number, unknown> = { 1: self };
  const client = Object.assign(new EventEmitter(), {
    write: (name: string, packet: Record<string, unknown>) => {
      written.push({ name, packet, at: performance.now() });
      const boat = entities[7] as { position: Vec3 } | undefined;
      if (name === "entity_action" && packet.actionId === 1) seat.release();
      if (name === "entity_action" && packet.actionId === 0) {
        seat.press();
        clock.press();
        if (options.answerShiftMs !== undefined && boat !== undefined) {
          setTimeout(() => client.emit("set_passengers", { entityId: 7, passengers: [] }), options.answerShiftMs);
        }
      }
      if (name === "vehicle_move" && boat !== undefined) boat.position = new Vec3(Number(packet.x), Number(packet.y), Number(packet.z));
      // The server puts the boat back when a move runs it into something.
      if (name === "vehicle_move" && options.correctFromZ !== undefined && Number(packet.z) > options.correctFromZ) {
        setImmediate(() => client.emit("vehicle_move", { x: Number(packet.x), y: Number(packet.y), z: options.correctFromZ }));
      }
    },
  });
  const bot = Object.assign(new EventEmitter(), {
    entity: self,
    entities,
    time: clock.time,
    vehicle: null as unknown,
    _client: client,
    inventory: { items: () => [...carried, ...extras], slots: {} },
    heldItem: null,
    blockAt: seaBlockAt(options),
    equip: async (item: { name: string }) => {
      equips.push(item.name);
    },
    dig: async () => undefined,
    lookAt: async () => undefined,
    activateItem: () => {
      carried.shift();
      entities[7] = { id: 7, name: "oak_boat", position: new Vec3(self.position.x, 62.5, self.position.z + 3), passengers: [] };
    },
    deactivateItem: () => undefined,
    mount: (boat: unknown) => {
      if (options.neverMounts) return;
      bot.vehicle = boat;
      self.vehicle = boat;
      seat.mount();
      if (options.mountEventAfterMs === undefined) setImmediate(() => bot.emit("mount"));
      else setTimeout(() => bot.emit("mount"), options.mountEventAfterMs);
    },
    // Mineflayer emits no "dismount" for a passenger list that no longer names the bot.
    dismount: () => undefined,
    attack: (target: { id: number }) => {
      attacks.push(target.id);
      // Anything but a boat is just struck: only a boat breaks and drops its item.
      if (!String((entities[target.id] as { name?: string } | undefined)?.name).endsWith("_boat")) return;
      const top = (entities[target.id] as { position: Vec3 }).position;
      delete entities[target.id];
      carried.push({ name: "oak_boat", count: 1 });
      // The server brings the ejected rider a position.
      if (seat.eject()) setImmediate(() => client.emit("position", { x: top.x, y: top.y + 0.5, z: top.z, yaw: 0, pitch: 0, flags: { x: false, y: false, z: false, yaw: false, pitch: false }, teleportId: 5 }));
    },
    clearControlStates: () => undefined,
    closeWindow: () => undefined,
    currentWindow: null,
    isSleeping: false,
    version: "1.21.4",
  });
  return { bot: bot as unknown as Bot, raw: bot, written, attacks, equips, entities, client, carried, serverSeated: seat.seated };
}

/** The shift presses (true) and releases (false) written, in order: a 1.21.4 server reads them from entity_action. */
export const shifts = (written: readonly { name: string; packet: Record<string, unknown> }[]): boolean[] => written.filter((entry) => entry.name === "entity_action").map((entry) => entry.packet.actionId === 0);

/** Mounted in the mock's boat, as a ride leaves her. */
export async function mountedBot(options: OpenSeaOptions = {}) {
  const world = openSeaBot(options);
  const boat = { id: 7, name: "oak_boat", position: new Vec3(0.5, 62.5, 3.5), passengers: [] };
  world.entities[7] = boat;
  world.raw.mount(boat);
  await new Promise((resolve) => setImmediate(resolve));
  return world;
}

/** The block at a cell of the sea: stone under it, water to y 62, air above; land and unloaded parts per the options. */
function seaBlockAt(options: OpenSeaOptions) {
  const stone = { name: "stone", boundingBox: "block" };
  return (at: Vec3) => {
    if (options.loadedTo !== undefined && at.z > options.loadedTo) return null;
    const land = (options.landUntilZ !== undefined && at.z <= options.landUntilZ) || (options.landFromZ !== undefined && at.z >= options.landFromZ);
    if ((land && at.y <= 62) || at.y < 63 - (options.waterDepth ?? 13)) return stone;
    return at.y <= 62 ? { name: "water", boundingBox: "empty" } : { name: "air", boundingBox: "empty" };
  };
}

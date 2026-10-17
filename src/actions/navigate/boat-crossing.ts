/**
 * Crossing deep open water by boat (spec 2026-10-04 deep-water-and-boats). Routes never set off across deep open
 * water (movement policy); when a route stops short and the straight way on crosses it, `navigate` says so, or, with a
 * boat carried, crosses here: the boat goes in from the shore, the bot rides it straight across, gets off a block
 * short of the far shore and takes the boat back.
 *
 * In vanilla the client drives a boat: the rider sends the boat's moves (`vehicle_move`) and the server checks them.
 * Mineflayer's `moveVehicle` only sends key presses, so the moves are sent here, at a boat's speed. Facts from the
 * 2026-10-04 prototype on 1.21.4: the boat is placed by `use_item` with the look aimed at the water 2.5 blocks or more
 * out (closer, it would touch the shore and is not placed); moves into the shore are refused ("moved wrongly"); the
 * server lets a passenger off on the `player_input` shift flag and tells her nothing (run 14b, Mine Labs 2026-10-17),
 * so the get-off ends with the vehicle forgotten and physics resumed here ({@link getOff}).
 */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { swimToDrop } from "../../navigation/mineflayer/swim-to-drop.js";
import { holdsWater, isDeepOpenWater, type WaterAt } from "../../navigation/world/deep-water.js";
import { currentVehicle, forgetVehicle, letsHerOff, resumePhysics } from "./vehicle-sync.js";

/** Blocks a boat moves per tick: about 7 blocks a second, under the 8 a player's boat reaches on water. */
const BOAT_STEP = 0.35;
/** The farthest one crossing goes: the edge of what is loaded is reached long before. */
const MAX_CROSSING = 512;
/** How far ahead the ride looks for the far shore, so it stops a block of water short of it. */
const SHORE_LOOKAHEAD = 2;
/** How close to the bank the boat comes before she gets off: its bow against it. */
const LANDING_GAP = 0.6;
/** How far along the far shore, each way, a bank low enough to climb out on is looked for (live 2026-10-04: a
 * stone cliff ran 16 blocks each way; a step cut in it was no way up). */
const LANDING_SEARCH = 48;
/** How far a dropped boat is swum after: one that drifted off the bank (live 2026-10-04: 4 blocks out). */
const DROP_REACH = 10;
/** How far along the straight way the water is looked for. */
const LINE_REACH = 160;

export interface DeepWaterLine {
  /** The last dry surface column before the deep water, where the boat goes in; null when the bot is already on it. */
  readonly shore: Vec3 | null;
  /** The first deep water column on the way, at its surface. */
  readonly start: Vec3;
  /** Deep water columns seen in a row from `start` (up to what is loaded). */
  readonly length: number;
  /** The far shore's first dry column, when loaded. */
  readonly farShore: Vec3 | null;
}

const blockHoldsWater = (block: { readonly name: string; getProperties?(): Record<string, unknown> }): boolean => holdsWater(block.name, block.getProperties?.() ?? {});
const isWater = (bot: Bot, x: number, y: number, z: number): boolean => {
  const block = bot.blockAt(new Vec3(x, y, z));
  return block !== null && blockHoldsWater(block);
};
const isAir = (name: string | undefined): boolean => name === "air" || name === "cave_air";

/** How far below the bot a column's top is looked for: a sea seen from a hill (live 2026-10-04: 19 blocks down). */
const SURFACE_DEPTH = 48;

/**
 * The water surface in this column, the first thing under `around` (water with air above), or null when the column's
 * top is dry ground or it is unloaded.
 */
function waterSurface(bot: Bot, x: number, z: number, around: number): number | null {
  for (let y = around + 4; y >= around - SURFACE_DEPTH; y -= 1) {
    const block = bot.blockAt(new Vec3(x, y, z));
    if (block === null) return null;
    if (blockHoldsWater(block)) return bot.blockAt(new Vec3(x, y + 1, z))?.name === "air" ? y : null;
    if (block.boundingBox === "block") return null;
  }
  return null;
}

/**
 * Deep open water on the straight way from `from` toward `to` (horizontal), within {@link LINE_REACH} blocks of
 * loaded ground; null when there is none.
 */
export function deepWaterOnTheWay(bot: Bot, from: Vec3, to: { readonly x: number; readonly z: number }): DeepWaterLine | null {
  const waterAt: WaterAt = (x, y, z) => isWater(bot, x, y, z);
  const [dx, dz] = [to.x - from.x, to.z - from.z];
  const length = Math.hypot(dx, dz);
  if (length < 1) return null;
  const level = Math.floor(from.y);
  let shore: Vec3 | null = null;
  let start: Vec3 | null = null;
  let run = 0;
  for (let step = 0; step <= Math.min(length, LINE_REACH); step += 1) {
    const [x, z] = [Math.floor(from.x + (dx / length) * step), Math.floor(from.z + (dz / length) * step)];
    if (bot.blockAt(new Vec3(x, level, z)) === null) break;
    const surface = waterSurface(bot, x, z, level);
    const deep = surface !== null && isDeepOpenWater(waterAt, x, surface, z);
    if (deep) {
      start ??= new Vec3(x, surface, z);
      run += 1;
    } else if (start !== null) {
      // Back on land (or shallow water) after the deep water: the far shore.
      return { shore, start, length: run, farShore: new Vec3(x, level, z) };
    } else {
      shore = surface === null ? new Vec3(x, level, z) : shore;
    }
  }
  return start === null ? null : { shore, start, length: run, farShore: null };
}

/** How far around the start of the deep water a shore at the water's level is looked for. */
const SHORE_SEARCH = 12;

/**
 * Where to stand to put a boat in: the nearest dry cell, at the water's level (ground one block above the water's
 * surface at most), beside surface water, around where the deep water starts; null when there is none near. From a
 * cliff the water is out of reach (live 2026-10-04: 19 blocks below).
 */
export function launchSpot(bot: Bot, water: Vec3): Vec3 | null {
  const surface = water.y;
  for (let ring = 0; ring <= SHORE_SEARCH; ring += 1) {
    const spots: Vec3[] = [];
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dz = -ring; dz <= ring; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const [x, z] = [water.x + dx, water.z + dz];
        for (const ground of [surface, surface + 1]) {
          const below = bot.blockAt(new Vec3(x, ground, z));
          const feet = bot.blockAt(new Vec3(x, ground + 1, z));
          const head = bot.blockAt(new Vec3(x, ground + 2, z));
          // Plain air at the feet and the head: a plant there is where the server's look ray stops, and the boat it
          // would put there is refused (live 2026-10-04: no angle placed one, not even on land, from a grassy shore).
          if (below?.boundingBox !== "block" || !isAir(feet?.name) || !isAir(head?.name)) continue;
          const besideWater = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ox, oz]) => waterSurface(bot, x + ox!, z + oz!, surface + 1) === surface);
          if (besideWater) spots.push(new Vec3(x, ground + 1, z));
        }
      }
    }
    if (spots.length > 0) return spots.sort((a, b) => a.distanceTo(water) - b.distanceTo(water))[0]!;
  }
  return null;
}

export function carriesBoat(bot: Bot): boolean {
  return bot.inventory.items().some((item) => item.name.endsWith("_boat") || item.name.endsWith("_raft"));
}

export interface CrossingResult {
  readonly status: "crossed" | "failed";
  /** Blocks ridden. */
  readonly blocks: number;
  readonly detail: string;
  /** Still in the boat, out at sea where the ride stopped for want of land: no get-off, no ride back (owner, run 13). */
  readonly atSea?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function boatsCarried(bot: Bot): number {
  return bot.inventory.items().filter((item) => item.name.endsWith("_boat") || item.name.endsWith("_raft")).reduce((sum, item) => sum + item.count, 0);
}

/** Whether this entity is a boat or a raft of any wood (or the old plain `boat`). */
export const isBoatEntity = (entity: Entity | null | undefined): boolean =>
  entity?.name !== undefined && (entity.name.endsWith("_boat") || entity.name.endsWith("_raft") || entity.name === "boat");

function nearestBoat(bot: Bot, around: Vec3, within: number, accept: (entity: Entity) => boolean = () => true): Entity | null {
  const boats = Object.values(bot.entities).filter((entity) =>
    entity !== bot.entity && isBoatEntity(entity) && entity.position.distanceTo(around) <= within && accept(entity));
  boats.sort((a, b) => a.position.distanceTo(around) - b.position.distanceTo(around));
  return boats[0] ?? null;
}

/**
 * Puts the carried boat in the water toward `heading` (a unit vector), rides straight across, gets off a block short
 * of the far shore and takes the boat back. The bot stands at the shore, facing the water.
 */
export async function crossByBoat(bot: Bot, heading: { readonly x: number; readonly z: number }, signal?: AbortSignal, maxBlocks = MAX_CROSSING): Promise<CrossingResult> {
  const item = bot.inventory.items().find((stack) => stack.name.endsWith("_boat") || stack.name.endsWith("_raft"));
  if (item === undefined) return { status: "failed", blocks: 0, detail: "no boat is carried" };
  const origin = bot.entity.position.clone();
  const boat = await launchBoat(bot, item, heading);
  if (boat === null) return { status: "failed", blocks: 0, detail: "could not put the boat in the water here" };

  const mounted = new Promise<boolean>((resolve) => bot.once("mount", () => resolve(true)));
  bot.mount(boat);
  if (!(await Promise.race([mounted, sleep(3000).then(() => false)]))) return { status: "failed", blocks: 0, detail: "could not get into the boat" };

  const ride = new BoatRide(bot, boat, heading, origin, signal);
  const across = await ride.across(Math.min(maxBlocks, MAX_CROSSING));
  let stoppedBy = across.stoppedBy;
  // Stopped over water that is not deep (live 2026-10-04: shallows one or two deep, with stone islets): no bank is
  // needed, she gets off and the route wades on.
  if (stoppedBy === "" && ride.deepUnder()) stoppedBy = await ride.toBank();
  // No land by the distance asked for, on deep water: she stays there, in her boat (owner, run 13: bots rode back to their
  // start; the target is where the model's next order starts from). Any other stop that is not ashore and is out on deep
  // water (the water ahead not loaded, a bank step that could not be cut) goes back the way it came, to where the boat
  // went in, rather than stranded there.
  const staysAtSea = across.noLand && ride.deepUnder();
  if (!staysAtSea && stoppedBy !== "" && stoppedBy !== "stopped" && ride.deepUnder()) {
    await ride.back();
    stoppedBy += "; rode back to where the boat went in";
  }
  const { x, y, z } = await ride.end();
  const ridden = Math.round(ride.ridden);
  if (staysAtSea) {
    return { status: "failed", blocks: ridden, atSea: true, detail: `rode ${ridden} blocks by boat and stays at sea in its boat at ${Math.floor(x)} ${Math.floor(z)} (${stoppedBy})` };
  }
  await getOff(bot);

  await takeBoatBack(bot, nearestBoat(bot, new Vec3(x, y, z), 6), signal);
  const lost = Object.values(bot.entities).find((entity) => entity.name === "item" && entity.position.distanceTo(bot.entity.position) < 32);
  const kept = boatsCarried(bot) > 0 ? "" : `; the boat was not picked back up${lost === undefined ? "" : ` (an item ${Math.round(lost.position.distanceTo(bot.entity.position))} blocks off)`}`;
  const detail = `rode ${ridden} blocks by boat${stoppedBy === "" ? "" : ` (${stoppedBy})`}${kept}`;
  return { status: stoppedBy === "" ? "crossed" : "failed", blocks: ridden, detail };
}

/**
 * The carried boat put in the water toward `heading`, or null. Placed by the look: aimed at the water surface 2.5
 * blocks out or more (closer, it would touch the shore), the way on first, then turning away from it as the shore
 * allows (live 2026-10-04: straight on was the shore bend).
 */
async function launchBoat(bot: Bot, item: Item, heading: { readonly x: number; readonly z: number }): Promise<Entity | null> {
  await bot.equip(item, "hand");
  // A plant at the feet or the head stops the server look ray: cleared first.
  for (const dy of [0, 1]) {
    const plant = bot.blockAt(bot.entity.position.floored().offset(0, dy, 0));
    if (plant !== null && !isAir(plant.name) && plant.name !== "water" && plant.boundingBox === "empty") await bot.dig(plant, true).catch(() => undefined);
  }
  await bot.equip(item, "hand");
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const level = Math.floor(bot.entity.position.y);
  const tries: { readonly x: number; readonly z: number }[] = [];
  for (const turn of [0, 30, -30, 60, -60, 90, -90]) {
    const angle = (turn * Math.PI) / 180;
    const way = { x: heading.x * Math.cos(angle) - heading.z * Math.sin(angle), z: heading.x * Math.sin(angle) + heading.z * Math.cos(angle) };
    for (const distance of [2.5, 3, 3.5, 4]) tries.push({ x: eye.x + way.x * distance, z: eye.z + way.z * distance });
  }
  let attempts = 0;
  // Only the boat she puts in the water now: one already there (a player one) is not hers to take.
  const known = new Set(Object.values(bot.entities).map((entity) => entity.id));
  for (const at of tries) {
    if (attempts >= 6) break;
    const surface = waterSurface(bot, Math.floor(at.x), Math.floor(at.z), level);
    if (surface === null) continue;
    attempts += 1;
    await bot.lookAt(new Vec3(at.x, surface + 0.9, at.z), true);
    // Mineflayer turns the head a few degrees a tick, and the server places a boat by the look it last received
    // (live 2026-10-04: still 56 degrees off after 300 ms, nothing placed): the look is sent at once.
    bot._client.write("look", {
      yaw: (180 - (bot.entity.yaw * 180) / Math.PI),
      pitch: (-bot.entity.pitch * 180) / Math.PI,
      flags: { onGround: bot.entity.onGround, hasHorizontalCollision: false },
    });
    await sleep(150);
    const before = boatsCarried(bot);
    bot.activateItem();
    await sleep(100);
    bot.deactivateItem();
    await sleep(700);
    // Put in the water: a new boat by her, or one boat fewer carried (live 2026-10-07 on a modded server: the count
    // never dropped while her inventory was misread, and the boat placed went unseen).
    const appeared = nearestBoat(bot, bot.entity.position, 6, (entity) => !known.has(entity.id));
    const boat = appeared ?? (boatsCarried(bot) < before ? nearestBoat(bot, bot.entity.position, 6) : null);
    if (boat !== null) return boat;
  }
  return null;
}

/** Minecraft yaw (degrees) facing a horizontal unit vector. */
const yawOf = (way: { readonly x: number; readonly z: number }) => (Math.atan2(-way.x, way.z) * 180) / Math.PI;

/**
 * One ride in a boat she is in: the moves are sent here (`vehicle_move`), at a boat speed, at the water surface the
 * boat floats on. The server puts the boat back when a move runs it into something (live 2026-10-04: three "moved
 * wrongly" at a bank): taken as where the boat is, and the leg under way ends there.
 */
class BoatRide {
  readonly #bot: Bot;
  readonly #heading: { readonly x: number; readonly z: number };
  readonly #signal: AbortSignal | undefined;
  readonly #position: { x: number; y: number; z: number };
  readonly #launch: { readonly x: number; readonly z: number };
  readonly #surfaceLevel: number;
  #corrected = false;
  /** Counted from where she stood, not from where the boat went in (2.5 to 4 blocks out). */
  ridden: number;
  readonly #onCorrection = (packet: { readonly x: number; readonly y: number; readonly z: number }) => {
    this.#position.x = packet.x;
    this.#position.y = packet.y;
    this.#position.z = packet.z;
    this.#corrected = true;
  };

  constructor(bot: Bot, boat: Entity, heading: { readonly x: number; readonly z: number }, origin: Vec3, signal: AbortSignal | undefined) {
    this.#bot = bot;
    this.#heading = heading;
    this.#signal = signal;
    this.#position = { x: boat.position.x, y: boat.position.y, z: boat.position.z };
    this.#launch = { x: boat.position.x, z: boat.position.z };
    // The water the boat floats on (a boat sits lower than its surface block: floor(y) was a block under it, live).
    this.#surfaceLevel = waterSurface(bot, Math.floor(boat.position.x), Math.floor(boat.position.z), Math.floor(boat.position.y) + 1) ?? Math.floor(boat.position.y);
    this.ridden = Math.hypot(boat.position.x - origin.x, boat.position.z - origin.z);
    bot._client.on("vehicle_move", this.#onCorrection);
  }

  /** Straight on until the shore is close ahead, the distance asked for is ridden, or she is stopped. */
  async across(maxBlocks: number): Promise<{ readonly stoppedBy: string; readonly noLand: boolean }> {
    while (true) {
      // No land by the distance asked for: never out on open sea with no end (live 2026-10-04: Vex, exploring 64 blocks,
      // rode 518 blocks of ocean and was stranded at its far side).
      if (this.ridden >= maxBlocks) return { stoppedBy: `no land within ${Math.round(this.ridden)} blocks that way`, noLand: true };
      if (this.#signal?.aborted) return { stoppedBy: "stopped", noLand: false };
      const open = this.#waterAhead(SHORE_LOOKAHEAD);
      if (open === null) return { stoppedBy: "the water ahead is not loaded", noLand: false };
      if (!open) return { stoppedBy: "", noLand: false };
      await this.#step(this.#heading);
    }
  }

  /**
   * Up to the bank where it is low enough to climb (live 2026-10-04: a bank two blocks above the water held a swimmer
   * in it): along the shore to the nearest such place, then the bow against it; none along it, straight on, with a step
   * cut into the bank from the boat, as a player does. Returns why she is still out on deep water, or "".
   */
  async toBank(): Promise<string> {
    const heading = this.#heading;
    const offset = lowBankAlong(this.#bot, this.#position, heading, this.#surfaceLevel) ?? 0;
    const side = { x: -heading.z * Math.sign(offset), z: heading.x * Math.sign(offset) };
    await this.#steer(side, (along) => along < Math.abs(offset));
    await this.#steer(heading, (closer) => closer < SHORE_LOOKAHEAD + 4 && this.#waterAhead(LANDING_GAP) === true);
    const cut = await cutStep(this.#bot, this.#position, heading, this.#surfaceLevel);
    return cut !== "" && this.deepUnder() ? cut : "";
  }

  /** Back the way it came, to where the boat went in. */
  async back(): Promise<void> {
    const left = Math.hypot(this.#launch.x - this.#position.x, this.#launch.z - this.#position.z);
    await this.#steer({ x: -this.#heading.x, z: -this.#heading.z }, (gone) => left - gone > 1);
  }

  /**
   * The ride over: brought to a stop, the same place sent a few ticks (let go moving, it drifts off: live 2026-10-04,
   * its item 16 blocks out from where she got off). Returns where the boat is.
   */
  async end(): Promise<{ readonly x: number; readonly y: number; readonly z: number }> {
    this.#bot._client.removeListener("vehicle_move", this.#onCorrection);
    const { x, y, z } = this.#position;
    for (let tick = 0; tick < 4; tick += 1) {
      this.#bot._client.write("vehicle_move", { x, y, z, yaw: yawOf(this.#heading), pitch: 0, onGround: false });
      await sleep(50);
    }
    return { x, y, z };
  }

  /** Deep open water under the boat. */
  deepUnder(): boolean {
    return isDeepOpenWater((wx, wy, wz) => isWater(this.#bot, wx, wy, wz), Math.floor(this.#position.x), this.#surfaceLevel, Math.floor(this.#position.z));
  }

  /** Water `lookahead` blocks ahead on the way; null where it is not loaded. */
  #waterAhead(lookahead: number): boolean | null {
    const ahead = { x: Math.floor(this.#position.x + this.#heading.x * (lookahead + 0.7)), z: Math.floor(this.#position.z + this.#heading.z * (lookahead + 0.7)) };
    if (this.#bot.blockAt(new Vec3(ahead.x, this.#surfaceLevel, ahead.z)) === null) return null;
    return waterSurface(this.#bot, ahead.x, ahead.z, this.#surfaceLevel) !== null;
  }

  /** One leg toward `way`, a boat step a tick while `more(blocks gone)`, until the server puts the boat back or she is stopped. */
  async #steer(way: { readonly x: number; readonly z: number }, more: (gone: number) => boolean): Promise<void> {
    this.#corrected = false;
    for (let gone = 0; more(gone) && !this.#corrected && !this.#signal?.aborted; gone += BOAT_STEP) await this.#step(way);
  }

  async #step(way: { readonly x: number; readonly z: number }): Promise<void> {
    const position = this.#position;
    position.x += way.x * BOAT_STEP;
    position.z += way.z * BOAT_STEP;
    this.#bot._client.write("vehicle_move", { x: position.x, y: position.y, z: position.z, yaw: yawOf(way), pitch: 0, onGround: false });
    // Mineflayer does not move a passenger with its vehicle: kept where the boat is.
    this.#bot.entity.position = new Vec3(position.x, position.y + 0.5, position.z);
    this.ridden += BOAT_STEP;
    await sleep(50);
  }
}

/** How long a get-off from a boat holds shift (a vanilla server never answers it) before the vehicle is forgotten. */
const DISMOUNT_WAIT_MS = 3000;

/**
 * Shift down or up, which is what lets a passenger off a boat. Mineflayer's `dismount` sends the jump input instead,
 * which only a horse reads: the server kept the bot in its boat (run 14) while the client forgot the vehicle, and
 * Mineflayer, which switches physics off at a mount and back on only at a server position, never ticked again.
 */
function pressShift(bot: Bot, down: boolean): void {
  if (bot.supportFeature("newPlayerInputPacket")) bot._client.write("player_input", { inputs: { shift: down } });
  else bot._client.write("entity_action", { entityId: bot.entity.id, actionId: down ? 0 : 1, jumpBoost: 0 });
}

/**
 * Off the vehicle she rides, physics on again; returns it, and whether a server answered. A vanilla 1.21.4 server lets
 * her off on the shift and tells her nothing: no position, and its passenger list goes only to the other players (Mine
 * Labs 2026-10-17, the server put her down where her next route started). So shift is held for the whole wait (a
 * server behind by seconds, run 14b: 3 to 8 s, can read a short press and its release in one tick and keep her
 * riding), or until another server answers (her boat's passenger list without her, the boat gone, a position); then
 * the vehicle is forgotten and physics resumed, unless a position did it (run 14b: eight bots froze after a get-off
 * without this).
 */
export async function getOff(bot: Bot): Promise<{ readonly vehicle: Entity | null; readonly answered: boolean }> {
  const vehicle = currentVehicle(bot);
  let repositioned = false;
  let answered = false;
  await new Promise<void>((resolve) => {
    const done = () => {
      answered = true;
      finish();
    };
    const onPosition = () => {
      repositioned = true;
      done();
    };
    const onPassengers = (packet: { readonly entityId: number; readonly passengers: readonly number[] }) => {
      if (letsHerOff(bot, vehicle, packet)) done();
    };
    const onGone = (entity: Entity) => {
      if (vehicle !== null && entity.id === vehicle.id) done();
    };
    const finish = () => {
      clearTimeout(timer);
      bot.off("dismount", done);
      bot.off("forcedMove", onPosition);
      bot.off("entityGone", onGone);
      bot._client.off("set_passengers", onPassengers);
      resolve();
    };
    const timer = setTimeout(finish, DISMOUNT_WAIT_MS);
    bot.once("dismount", done);
    bot.once("forcedMove", onPosition);
    bot.on("entityGone", onGone);
    bot._client.on("set_passengers", onPassengers);
    pressShift(bot, true);
  });
  pressShift(bot, false);
  // Already forgotten when the runtime's vehicle watch saw the answer first: it resumed physics too.
  if (forgetVehicle(bot) !== null && !repositioned) resumePhysics(bot);
  return { vehicle, answered };
}

/**
 * Gets off the boat she rides (the next movement after a ride that stayed at sea starts here) and returns it, as
 * {@link getOff} does.
 */
export async function leaveBoat(bot: Bot): Promise<Entity | null> {
  return (await getOff(bot)).vehicle;
}

/**
 * The boat back: broken by hand, it drops and is picked up, swum after when it floats off. True when a boat is carried
 * after.
 */
export async function takeBoatBack(bot: Bot, boat: Entity | null, signal?: AbortSignal, settleMs = 1500): Promise<boolean> {
  let hits = 0;
  while (boat !== null && bot.entities[boat.id] !== undefined && hits < 15) {
    await bot.lookAt(boat.position.offset(0, 0.3, 0), true);
    bot.attack(boat);
    hits += 1;
    await sleep(300);
  }
  await sleep(settleMs);
  // Its item floated off before it was picked up: swum after, a few blocks of the water by the bank.
  if (boatsCarried(bot) === 0 && !signal?.aborted) {
    await swimToDrop(bot, (item) => item.name.endsWith("_boat") || item.name.endsWith("_raft"), DROP_REACH, () => boatsCarried(bot) > 0, 15_000);
  }
  return boatsCarried(bot) > 0;
}

/**
 * A boat she stands on (not in) out on deep water, with none carried; null otherwise. Live 2026-10-10: Vex stood on
 * a boat at sea a whole run (got off it at a login or a stop), every way refused "no boat is carried" and no
 * crafting table could be set on the water to make one: taken back, it is the way off the sea.
 */
export function boatUnderFeetAtSea(bot: Bot, justLeft?: Entity | null): Entity | null {
  if (bot.entity.vehicle || bot.entities === undefined) return null;
  const feet = bot.entity.position;
  // The boat she has just got off is hers whatever the server set her down on.
  const boat = nearestBoat(bot, feet, 1.5, (entity) => entity === justLeft || (feet.y >= entity.position.y && feet.y - entity.position.y < 1.2));
  if (boat === null || carriesBoat(bot)) return null;
  const [x, z] = [Math.floor(boat.position.x), Math.floor(boat.position.z)];
  const surface = waterSurface(bot, x, z, Math.floor(feet.y));
  return surface !== null && isDeepOpenWater((wx, wy, wz) => isWater(bot, wx, wy, wz), x, surface, z) ? boat : null;
}

/**
 * Where along the shore ahead a swimmer can climb out: the sideways offset from `from` (+ to the heading's left, - to
 * its right, the nearest first) whose first dry column ahead has its walkable top at most one block above the water,
 * with water all the way along to it; null when there is none within {@link LANDING_SEARCH} blocks.
 */
export function lowBankAlong(bot: Bot, from: { readonly x: number; readonly z: number }, heading: { readonly x: number; readonly z: number }, surface: number): number | null {
  const side = { x: -heading.z, z: heading.x };
  const open = { left: true, right: true };
  for (let distance = 0; distance <= LANDING_SEARCH; distance += 1) {
    for (const offset of distance === 0 ? [0] : [distance, -distance]) {
      const way = offset >= 0 ? "left" : "right";
      if (!open[way]) continue;
      const column = { x: from.x + side.x * offset, z: from.z + side.z * offset };
      if (waterSurface(bot, Math.floor(column.x), Math.floor(column.z), surface) === null) {
        open[way] = false;
        if (offset === 0) open.right = false;
        continue;
      }
      for (let ahead = 1; ahead <= SHORE_LOOKAHEAD + 4; ahead += 1) {
        const x = Math.floor(column.x + heading.x * ahead);
        const z = Math.floor(column.z + heading.z * ahead);
        if (waterSurface(bot, x, z, surface) !== null) continue;
        if (climbable(bot, x, z, surface)) return offset;
        break;
      }
    }
  }
  return null;
}

/** A dry column a swimmer at this water surface steps onto: its top at the water's level or one above, room over it. */
function climbable(bot: Bot, x: number, z: number, surface: number): boolean {
  const passable = (block: { readonly boundingBox: string; readonly name: string } | null) => block !== null && block.boundingBox === "empty" && block.name !== "water";
  for (const top of [surface, surface + 1]) {
    const ground = bot.blockAt(new Vec3(x, top, z));
    if (ground?.boundingBox === "block" && passable(bot.blockAt(new Vec3(x, top + 1, z))) && passable(bot.blockAt(new Vec3(x, top + 2, z)))) return true;
  }
  return false;
}

/**
 * Makes the bank ahead climbable from the water: the blocks of its first dry column above one over the water dug out,
 * so its top is a step up. A ledge over the water (nothing under it at the water's level, live 2026-10-04: grass over a
 * gap) is dug open and the column behind it is the bank. "" when done or nothing was needed, else why not.
 */
async function cutStep(bot: Bot, from: { readonly x: number; readonly z: number }, heading: { readonly x: number; readonly z: number }, surface: number): Promise<string> {
  const dig = async (x: number, z: number): Promise<string> => {
    for (const y of [surface + 2, surface + 3]) {
      const block = bot.blockAt(new Vec3(x, y, z));
      if (block === null || block.boundingBox === "empty") continue;
      if (!bot.canDigBlock(block)) return `the bank ahead (${block.name}) cannot be dug from the boat`;
      try {
        await bot.dig(block, true);
      } catch (error) {
        return `the bank ahead could not be dug: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return "";
  };
  for (let ahead = 1; ahead <= SHORE_LOOKAHEAD + 4; ahead += 1) {
    const x = Math.floor(from.x + heading.x * ahead);
    const z = Math.floor(from.z + heading.z * ahead);
    if (waterSurface(bot, x, z, surface) !== null) continue;
    if (climbable(bot, x, z, surface)) return "";
    const ledge = bot.blockAt(new Vec3(x, surface + 1, z))?.boundingBox !== "block";
    const failed = await dig(x, z);
    if (failed !== "") return failed;
    if (ledge) continue;
    return climbable(bot, x, z, surface) ? "" : "the bank ahead is still too high after a step was cut";
  }
  return "no bank to climb out on within reach ahead";
}

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
 * server takes a dismount from `entity_action` press shift (the `player_input` shift flag only from 1.21.6); and
 * Mineflayer misses the dismount (the passenger list it is sent no longer names the bot), so it is cleared here.
 */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { swimToDrop } from "../../navigation/mineflayer/swim-to-drop.js";
import { holdsWater, isDeepOpenWater, type WaterAt } from "../../navigation/world/deep-water.js";

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
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function boatsCarried(bot: Bot): number {
  return bot.inventory.items().filter((item) => item.name.endsWith("_boat") || item.name.endsWith("_raft")).reduce((sum, item) => sum + item.count, 0);
}

function nearestBoat(bot: Bot, around: Vec3, within: number): Entity | null {
  const boats = Object.values(bot.entities).filter((entity) =>
    entity !== bot.entity && (entity.name?.endsWith("_boat") || entity.name?.endsWith("_raft") || entity.name === "boat") &&
    entity.position.distanceTo(around) <= within);
  boats.sort((a, b) => a.position.distanceTo(around) - b.position.distanceTo(around));
  return boats[0] ?? null;
}

/**
 * Puts the carried boat in the water toward `heading` (a unit vector), rides straight across, gets off a block short
 * of the far shore and takes the boat back. The bot stands at the shore, facing the water.
 */
export async function crossByBoat(bot: Bot, heading: { readonly x: number; readonly z: number }, signal?: AbortSignal): Promise<CrossingResult> {
  const item = bot.inventory.items().find((stack) => stack.name.endsWith("_boat") || stack.name.endsWith("_raft"));
  if (item === undefined) return { status: "failed", blocks: 0, detail: "no boat is carried" };
  await bot.equip(item, "hand");
  // A plant at the feet or the head stops the server's look ray: cleared first.
  for (const dy of [0, 1]) {
    const plant = bot.blockAt(bot.entity.position.floored().offset(0, dy, 0));
    if (plant !== null && !isAir(plant.name) && plant.name !== "water" && plant.boundingBox === "empty") await bot.dig(plant, true).catch(() => undefined);
  }
  await bot.equip(item, "hand");
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const level = Math.floor(bot.entity.position.y);
  // Placed by the look: aimed at the water's surface 2.5 blocks out or more (closer, it would touch the shore), the way
  // on first, then turning away from it as the shore allows (live 2026-10-04: straight on was the shore's bend).
  let boat: Entity | null = null;
  const tries: { readonly x: number; readonly z: number }[] = [];
  for (const turn of [0, 30, -30, 60, -60, 90, -90]) {
    const angle = (turn * Math.PI) / 180;
    const way = { x: heading.x * Math.cos(angle) - heading.z * Math.sin(angle), z: heading.x * Math.sin(angle) + heading.z * Math.cos(angle) };
    for (const distance of [2.5, 3, 3.5, 4]) tries.push({ x: eye.x + way.x * distance, z: eye.z + way.z * distance });
  }
  let attempts = 0;
  for (const at of tries) {
    if (boat !== null || attempts >= 6) break;
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
    boat = boatsCarried(bot) < before ? nearestBoat(bot, bot.entity.position, 6) : null;
  }
  if (boat === null) return { status: "failed", blocks: 0, detail: "could not put the boat in the water here" };

  const mounted = new Promise<boolean>((resolve) => bot.once("mount", () => resolve(true)));
  bot.mount(boat);
  if (!(await Promise.race([mounted, sleep(3000).then(() => false)]))) return { status: "failed", blocks: 0, detail: "could not get into the boat" };

  // Straight across, at the water's surface the boat floats on, until the shore is close ahead.
  const yaw = (Math.atan2(-heading.x, heading.z) * 180) / Math.PI;
  const position = { x: boat.position.x, y: boat.position.y, z: boat.position.z };
  const move = (step: { readonly x: number; readonly z: number }, facing: number) => {
    position.x += step.x;
    position.z += step.z;
    bot._client.write("vehicle_move", { x: position.x, y: position.y, z: position.z, yaw: facing, pitch: 0, onGround: false });
    // Mineflayer does not move a passenger with its vehicle: kept where the boat is.
    bot.entity.position = new Vec3(position.x, position.y + 0.5, position.z);
  };
  // The water the boat floats on (a boat sits lower than its surface block: floor(y) was a block under it, live).
  // The server puts the boat back when a move runs it into something (live 2026-10-04: three "moved wrongly" at a
  // bank): taken as where the boat is, and the approach to the bank ends there.
  let corrected = false;
  const onCorrection = (packet: { readonly x: number; readonly y: number; readonly z: number }) => {
    position.x = packet.x;
    position.y = packet.y;
    position.z = packet.z;
    corrected = true;
  };
  bot._client.on("vehicle_move", onCorrection);
  const surfaceLevel = waterSurface(bot, Math.floor(position.x), Math.floor(position.z), Math.floor(position.y) + 1) ?? Math.floor(position.y);
  const waterAhead = (from: { readonly x: number; readonly z: number }, lookahead: number): boolean | null => {
    const ahead = { x: Math.floor(from.x + heading.x * (lookahead + 0.7)), z: Math.floor(from.z + heading.z * (lookahead + 0.7)) };
    if (bot.blockAt(new Vec3(ahead.x, surfaceLevel, ahead.z)) === null) return null;
    return waterSurface(bot, ahead.x, ahead.z, surfaceLevel) !== null;
  };
  let ridden = 0;
  let stoppedBy = "";
  while (ridden < MAX_CROSSING) {
    if (signal?.aborted) {
      stoppedBy = "stopped";
      break;
    }
    const open = waterAhead(position, SHORE_LOOKAHEAD);
    if (open === null) {
      stoppedBy = "the water ahead is not loaded";
      break;
    }
    if (!open) break;
    move({ x: heading.x * BOAT_STEP, z: heading.z * BOAT_STEP }, yaw);
    ridden += BOAT_STEP;
    await sleep(50);
  }

  // Stopped over water that is not deep (live 2026-10-04: shallows one or two deep, with stone islets): no bank is
  // needed, she gets off and the route wades on.
  const deepUnder = () => isDeepOpenWater((wx, wy, wz) => isWater(bot, wx, wy, wz), Math.floor(position.x), surfaceLevel, Math.floor(position.z));
  if (stoppedBy === "" && deepUnder()) {
    // A bank a swimmer cannot climb (live 2026-10-04: two blocks above the water) is not where she gets off: the boat
    // goes along the shore to where it is low enough, then up to it, its bow against the bank.
    // None along it: straight on, with a step cut into the bank from the boat, as a player does.
    const offset = lowBankAlong(bot, position, heading, surfaceLevel) ?? 0;
    {
      const side = { x: -heading.z * Math.sign(offset), z: heading.x * Math.sign(offset) };
      const sideYaw = (Math.atan2(-side.x, side.z) * 180) / Math.PI;
      corrected = false;
      for (let along = 0; along < Math.abs(offset) && !corrected && !signal?.aborted; along += BOAT_STEP) {
        move({ x: side.x * BOAT_STEP, z: side.z * BOAT_STEP }, sideYaw);
        ridden += BOAT_STEP;
        await sleep(50);
      }
      corrected = false;
      for (let closer = 0; closer < SHORE_LOOKAHEAD + 4 && waterAhead(position, LANDING_GAP) === true && !corrected && !signal?.aborted; closer += BOAT_STEP) {
        move({ x: heading.x * BOAT_STEP, z: heading.z * BOAT_STEP }, yaw);
        ridden += BOAT_STEP;
        await sleep(50);
      }
      const cut = await cutStep(bot, position, heading, surfaceLevel);
      if (cut !== "" && deepUnder()) stoppedBy = cut;
    }
  }
  bot._client.removeListener("vehicle_move", onCorrection);
  const { x, y, z } = position;

  // Brought to a stop first, the same place sent a few ticks: let go moving, it drifts off (live 2026-10-04: its
  // item 16 blocks out from where she got off).
  for (let tick = 0; tick < 4; tick += 1) {
    bot._client.write("vehicle_move", { x, y, z, yaw, pitch: 0, onGround: false });
    await sleep(50);
  }
  // Off: press and release shift (1.21.4), then clear the vehicle Mineflayer kept.
  bot._client.write("entity_action", { entityId: bot.entity.id, actionId: 0, jumpBoost: 0 });
  await sleep(400);
  bot._client.write("entity_action", { entityId: bot.entity.id, actionId: 1, jumpBoost: 0 });
  await sleep(600);
  // Mineflayer keeps `vehicle` on the bot and on its entity (its type omits the first); both are cleared, or the next
  // movement's preparation sees the entity still riding and fails "dismount: not mounted" (live 2026-10-04).
  const riding = bot as unknown as { vehicle: Entity | null };
  const vehicle = riding.vehicle ?? bot.entity.vehicle ?? null;
  riding.vehicle = null;
  if (bot.entity.vehicle) {
    const passengers = bot.entity.vehicle.passengers;
    const index = passengers.indexOf(bot.entity);
    if (index !== -1) passengers.splice(index, 1);
    (bot.entity as unknown as { vehicle: Entity | null }).vehicle = null;
  }
  if (vehicle !== null) bot.emit("dismount", vehicle);

  // The boat back: broken by hand, it drops and is picked up.
  const left = nearestBoat(bot, new Vec3(x, y, z), 6);
  let hits = 0;
  while (left !== null && bot.entities[left.id] !== undefined && hits < 15) {
    await bot.lookAt(left.position.offset(0, 0.3, 0), true);
    bot.attack(left);
    hits += 1;
    await sleep(300);
  }
  await sleep(1500);
  // Its item floated off before it was picked up: swum after, a few blocks of the water by the bank.
  if (boatsCarried(bot) === 0 && !signal?.aborted) {
    await swimToDrop(bot, (item) => item.name.endsWith("_boat") || item.name.endsWith("_raft"), DROP_REACH, () => boatsCarried(bot) > 0, 15_000);
  }
  const lost = Object.values(bot.entities).find((entity) => entity.name === "item" && entity.position.distanceTo(bot.entity.position) < 32);
  const kept = boatsCarried(bot) > 0 ? "" : `; the boat was not picked back up${lost === undefined ? "" : ` (an item ${Math.round(lost.position.distanceTo(bot.entity.position))} blocks off)`}`;
  const detail = `rode ${Math.round(ridden)} blocks by boat${stoppedBy === "" ? "" : ` (${stoppedBy})`}${kept}`;
  return { status: stoppedBy === "" ? "crossed" : "failed", blocks: Math.round(ridden), detail };
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

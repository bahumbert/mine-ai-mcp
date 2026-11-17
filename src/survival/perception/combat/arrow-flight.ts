import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { observedEyeHeight } from "../../../world/block-visibility.js";
import { familyIndexOf, hasItemFamily } from "../../../world/item-families.js";
import { AGE_PACKET_TICKS, serverPacedWallMs } from "../../../world/world-age.js";
import { monotonicNow } from "../../../utils/index.js";
import { combatReadout } from "../../weapons/equipment.js";

type Entity = Bot["entity"];
type OwnLaunch = { position: Vec3; direction: Vec3; feet: Vec3; arrows: number };
type Flight = { entity: Entity; position: Vec3; velocity: Vec3; at: number; positionAt: number | null; velocityAt: number | null;
  ownLaunch: OwnLaunch | null };
const trackers = new WeakMap<Bot, Map<number, Flight>>();
const ownership = new WeakMap<Bot, { users: number; close: () => void }>();

/** Unknown spread stays incoming; only the commanded direction within protocol velocity quantisation matches. */
function retainOwnLaunch(launch: OwnLaunch | null, position: Vec3, velocity: Vec3): OwnLaunch | null {
  if (!launch || position.distanceTo(launch.position) > 1e-6) return null;
  const along = velocity.dot(launch.direction);
  // Native velocity components have 1/8000 resolution (projectile-spawn.ts); this is not an inferred spread cone.
  return along > 0 && velocity.minus(launch.direction.scaled(along)).norm() <= Math.sqrt(3) / 8_000 ? launch : null;
}

/** Match only a commanded main-hand bow release at its measured eye-minus-0.1 origin (contract, 2026-11-17). */
function observeOwnBowRelease(bot: Bot) {
  let drawing = false, active = true;
  let release: (OwnLaunch & { age: number; ms: number }) | null = null;
  const client = bot._client, originalWrite = client.write;
  const clear = () => { drawing = false; release = null; };
  const write: typeof client.write = function (this: typeof client, name, params) {
    if (!active) return originalWrite.call(this, name, params);
    if (name === "use_item") {
      drawing = params.hand === 0 && !!bot.heldItem && hasItemFamily(bot, bot.heldItem.name, "bow");
      release = null;
    } else if (name === "held_item_slot") clear();
    else if (name === "block_dig" && params.status === 5) {
      const { yaw, pitch } = bot.entity;
      release = drawing ? { position: bot.entity.position.offset(0, observedEyeHeight(bot.entity) - 0.1, 0),
        direction: new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)),
        feet: bot.entity.position.clone(), arrows: combatReadout(bot).arrows, age: bot.time.age, ms: monotonicNow() } : null;
      drawing = false;
    }
    try { return originalWrite.call(this, name, params); }
    catch (error) { clear(); throw error; }
  };
  client.write = write;
  return {
    take(entity: Entity): OwnLaunch | null {
      // Allow the cached age's one-packet uncertainty; late or stopped-server replies stay unknown (a11 T1c).
      if (release && (bot.time.age - release.age > AGE_PACKET_TICKS ||
          monotonicNow() - release.ms > serverPacedWallMs(AGE_PACKET_TICKS))) release = null;
      const launch = retainOwnLaunch(release, entity.position, entity.velocity);
      if (!launch) return null;
      release = null;
      return launch;
    },
    clear,
    [Symbol.dispose]() {
      active = false;
      clear();
      if (client.write === write) client.write = originalWrite;
    },
  };
}
function lease(owner: { users: number; close: () => void }): Disposable {
  owner.users++;
  let released = false;
  return { [Symbol.dispose]() {
    if (released) return;
    released = true;
    if (--owner.users === 0) owner.close();
  } };
}
/** Whether the entity is in the family `arrow_entity` (entity tag `arrows`, the server's when it sent one). */
export function isArrowEntity(bot: Bot, entity: Entity | undefined): entity is Entity & { name: string } {
  return entity?.name !== undefined && familyIndexOf(bot).entityFamilies(entity.name).includes("arrow_entity");
}

/** Advance only the estimate. Mineflayer's position remains the last packet observation. */
function advance(bot: Bot, flight: Flight, now: number): Flight {
  let { position, velocity, at } = flight;
  const ticks = Math.max(0, Math.floor((now - at) / 50));
  for (let tick = 0; tick < ticks && velocity.norm() > 0; tick++) {
    const speed = velocity.norm();
    if (bot.world.raycast(position, velocity.scaled(1 / speed), speed)) {
      velocity = velocity.scaled(0);
      break;
    }
    position = position.plus(velocity);
    velocity = velocity.scaled(0.99).offset(0, -0.05, 0);
  }
  return { ...flight, position, velocity, at: at + ticks * 50, ownLaunch: ticks > 0 ? null : flight.ownLaunch };
}

export function arrowFlight(bot: Bot, entity: Entity, now = performance.now()) {
  const flight = trackers.get(bot)?.get(entity.id);
  if (flight?.entity === entity) {
    const state = advance(bot, flight, now);
    // A release can fire nothing. Until the measured ammunition loss arrives, ownership remains unknown.
    return { ...state, ownLaunch: state.ownLaunch && combatReadout(bot).arrows < state.ownLaunch.arrows ? state.ownLaunch : null };
  }
  return {
    entity, position: entity.position.clone(), velocity: entity.velocity.clone(), at: now, positionAt: null, velocityAt: null, ownLaunch: null,
  };
}

/** Owned by combat perception, not diagnostics. Packet handlers run after Mineflayer. */
export function trackArrowFlights(bot: Bot, now = () => performance.now()): Disposable {
  const existing = ownership.get(bot);
  if (existing) return lease(existing);
  const flights = new Map<number, Flight>();
  const releases = observeOwnBowRelease(bot);
  trackers.set(bot, flights);
  const anchor = (entity: Entity, observed = true, launch: OwnLaunch | null = null) => {
    const at = now();
    const previous = flights.get(entity.id);
    const retained = previous?.entity === entity ? advance(bot, previous, at).ownLaunch : null;
    const ownLaunch = launch ?? retainOwnLaunch(retained, entity.position, entity.velocity);
    flights.set(entity.id, { entity, position: entity.position.clone(), velocity: entity.velocity.clone(), at, ownLaunch,
      positionAt: observed ? at : null, velocityAt: observed ? at : null });
  };
  for (const entity of Object.values(bot.entities)) if (isArrowEntity(bot, entity)) anchor(entity, false);
  const spawned = (entity: Entity) => {
    if (!isArrowEntity(bot, entity)) return;
    const launch = releases.take(entity);
    if (launch) anchor(entity, true, launch);
  };
  bot.on("entitySpawn", spawned);
  const names = ["spawn_entity", "entity_velocity", "rel_entity_move", "entity_move_look", "entity_teleport", "sync_entity_position", "entity_destroy"];
  const listeners = names.map((name) => {
    const listener = (packet: { entityId: number; entityIds?: number[]; dX?: number; dY?: number; dZ?: number }) => {
      if (name === "entity_destroy") {
        for (const id of packet.entityIds ?? []) flights.delete(id);
        return;
      }
      const entity = bot.entities[packet.entityId];
      if (!entity || !isArrowEntity(bot, entity)) return;
      if (name === "spawn_entity" || name === "sync_entity_position" || !flights.has(entity.id)) {
        anchor(entity);
        return;
      }
      // A look-only relative packet is not a fresh flight position.
      if ((name === "rel_entity_move" || name === "entity_move_look") && !packet.dX && !packet.dY && !packet.dZ) return;
      const at = now();
      const estimate = advance(bot, flights.get(entity.id)!, at);
      const observed = name === "entity_velocity"
        ? { ...estimate, velocity: entity.velocity.clone(), at, velocityAt: at }
        : { ...estimate, position: entity.position.clone(), at, positionAt: at };
      flights.set(entity.id, { ...observed, ownLaunch: retainOwnLaunch(observed.ownLaunch, observed.position, observed.velocity) });
    };
    bot._client.on(name, listener);
    return { name, listener };
  });
  const clear = () => { flights.clear(); releases.clear(); };
  bot.on("respawn", clear);
  const owner = { users: 0, close() {
    for (const { name, listener } of listeners) bot._client.off(name, listener);
    bot.off("respawn", clear);
    bot.off("entitySpawn", spawned);
    releases[Symbol.dispose]();
    trackers.delete(bot);
    ownership.delete(bot);
    flights.clear();
  } };
  ownership.set(bot, owner);
  return lease(owner);
}

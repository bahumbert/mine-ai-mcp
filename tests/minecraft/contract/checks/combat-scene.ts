/** What the combat checks share: a mob the server leaves still and unarmored, and what the client heard of a fight. */
import assert from "node:assert/strict";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { type ContractSubject, holdsWithin, settleWithin } from "../subject.ts";

/** A mob the server leaves where it stands (no AI, no despawn) with no armor, so a hit costs it the weapon's damage and nothing less. */
export const STILL_MOB_NBT = '{NoAI:1b,PersistenceRequired:1b,attributes:[{id:"minecraft:armor",base:0d}]}';
/** Night: an undead mob does not burn in the sun and send `damage_event`s of its own. */
export const NIGHT = 18_000;
/** A mob the fixture summoned shows up on the client within this wall time. */
export const MOB_WALL_MS = 5_000;
/** Server ticks are 50 ms. */
export const TICK_MS = 50;
/** The zombie's health when it is summoned. */
export const ZOMBIE_HEALTH = 20;

/** The mob's health: the float the server files in its metadata under the registry's `health` key. */
export function healthOf(bot: Bot, mob: Entity): number {
  const key = bot.registry.entitiesByName[mob.name!]!.metadataKeys!.indexOf("health");
  const health: unknown = mob.metadata[key];
  if (typeof health !== "number") throw new Error(`${mob.name} ${mob.id} has no health metadata`);
  return health;
}

/** The fixture's `name` standing at the arena-local `x` `z` (the client has them a moment after the join); found at that place in the subject's lane. */
export async function mobAt(subject: ContractSubject, name: string, x: number, z: number): Promise<Entity> {
  const place = subject.world([x, 0, z]);
  const find = () => Object.values(subject.bot.entities).find((entity) => entity.name === name && Math.abs(entity.position.x - place.x) < 0.1 && Math.abs(entity.position.z - place.z) < 0.1);
  assert.ok(await holdsWithin(subject, () => find() !== undefined, MOB_WALL_MS), `no ${name} at ${place.x} ${place.z}`);
  return find()!;
}

/** What the client heard of one entity's fight, with when. */
export interface FightHeard {
  readonly hurts: { readonly atMs: number; readonly source: Entity | undefined }[];
  readonly deaths: number[];
  readonly gone: number[];
}

/** Listen to `mob`'s hurts, death and removal until `stop`. */
export function listenToFight(subject: ContractSubject, mob: Entity): { readonly heard: FightHeard; stop(): void } {
  const { bot } = subject;
  const heard: FightHeard = { hurts: [], deaths: [], gone: [] };
  const onHurt = (entity: Entity, source?: Entity) => {
    if (entity === mob) heard.hurts.push({ atMs: subject.now(), source });
  };
  const onDead = (entity: Entity) => {
    if (entity === mob) heard.deaths.push(subject.now());
  };
  const onGone = (entity: Entity) => {
    if (entity === mob) heard.gone.push(subject.now());
  };
  bot.on("entityHurt", onHurt);
  bot.on("entityDead", onDead);
  bot.on("entityGone", onGone);
  return {
    heard,
    stop() {
      bot.off("entityHurt", onHurt);
      bot.off("entityDead", onDead);
      bot.off("entityGone", onGone);
    },
  };
}

/** Let time pass until `promise` settles (a fake clock moves only when told); the subject's reading when it did, or its error thrown. */
export async function finishWithin(subject: ContractSubject, promise: Promise<unknown>, maxMs: number, what: string): Promise<number> {
  const settled = await settleWithin(subject, promise, maxMs);
  if (settled === null) throw new Error(`${what}: not finished after ${maxMs} ms`);
  if (settled.error !== undefined) throw settled.error;
  return settled.atMs;
}

/** Wall bound of a call that waits for one server answer. */
export const CALL_WALL_MS = 5_000;

/** Equip the named item (carried by the fixture) in the hand. */
export async function holdInHand(subject: ContractSubject, name: string): Promise<void> {
  const item = subject.bot.inventory.items().find((stack) => stack.name === name);
  assert.ok(item !== undefined, `${name} is not carried`);
  await finishWithin(subject, subject.bot.equip(item, "hand"), CALL_WALL_MS, `equip ${name}`);
}

/** The bit of the bot's `living_entity_flags` the server sets while the hand uses an item (bit 0 a hand in use, bit 1 the off hand's). */
export function useFlagsOf(bot: Bot): number {
  const key = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("living_entity_flags");
  return Number(bot.entity.metadata[key] ?? 0);
}

/** The id the server gives a damage type: its place in the registry the login data sends. */
export function damageTypeId(registry: unknown, name: string): number {
  const { loginPacket } = registry as { loginPacket?: { dimensionCodec?: Record<string, { entries?: { key: string }[] }> } };
  const index = (loginPacket?.dimensionCodec?.["minecraft:damage_type"]?.entries ?? []).findIndex(({ key }) => key === `minecraft:${name}`);
  assert.ok(index >= 0, `the registry has no damage type ${name}`);
  return index;
}

/** The fields of a `damage_event` packet the checks state (it also holds a `sourcePosition`). */
export interface DamageEvent {
  readonly entityId: number;
  readonly sourceTypeId: number;
  readonly sourceCauseId: number;
  readonly sourceDirectId: number;
}

/** The client's packet emitter, typed for the packets the checks read raw. */
export type PacketListening = { on(event: string, listener: (packet: never) => void): void; off(event: string, listener: (packet: never) => void): void };

/** What an `update_health` packet tells the checks read. */
export interface HealthPacket {
  readonly health: number;
}

/** Whether the bot's entity flags (`entity_metadata` key 0, bit 0) say she is on fire. */
export function burning(bot: Bot): boolean {
  return (Number(bot.entity.metadata[0] ?? 0) & 1) === 1;
}

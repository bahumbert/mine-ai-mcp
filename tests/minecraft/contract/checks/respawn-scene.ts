/**
 * The respawn checks' shared recorder and steps: the packets and bot events the client hears from a death until its physics ticks
 * again, in the order it hears them. The real server sends more than these (chunks, `abilities`, `spawn_position`, `experience`, `window_items`, a
 * second `entity_status`, `entity_update_attributes`); the checks name the ones the shared fake sends and its consumers read.
 */
import assert from "node:assert/strict";
import type { ContractSubject } from "../subject.ts";
import { answerArrives } from "../server-answer.ts";

/**
 * A packet or bot event the client heard: its name (`update_health` carries the health: `update_health:0`), the subject's clock when it came, and for a
 * `position` the place it names. The gap between two packets is read in ms of this clock: the world age the client holds moves in steps of 20 ticks, too
 * coarse for the tick or two between a `respawn` and the new life's health.
 */
export interface Heard {
  readonly name: string;
  readonly atMs: number;
  readonly at?: { readonly x: number; readonly y: number; readonly z: number };
}

/** The packets of a death and a respawn the fake sends. */
export const DEATH_PACKETS = ["animation", "damage_event", "death_combat_event", "entity_status", "update_health", "respawn", "position"] as const;
/** `entity_status` 3 is the death (`entities.js:385-395`); the second one the real server sends at a respawn (28, the permission level) is none of the fake's concern. */
const STATUS_DEAD = 3;
/** The bot events of the same time that code reads (`health.js`, `physics.js`). */
export const DEATH_EVENTS = ["death", "respawn", "spawn", "forcedMove"] as const;

interface PacketData {
  readonly health?: number;
  readonly animation?: number;
  readonly entityId?: number;
  readonly entityStatus?: number;
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
}

/** What is noted of a packet: its name, with the value that tells apart the ones the checks compare (`update_health:0`, `animation:2`, `entity_status:3`); null for a packet to skip. */
function noteOf(bot: ContractSubject["bot"], name: string, data: PacketData): string | null {
  if (name === "update_health") return `${name}:${data.health}`;
  if (name === "animation") return data.entityId === bot.entity.id ? `${name}:${data.animation}` : null;
  if (name === "entity_status") return data.entityId === bot.entity.id && data.entityStatus === STATUS_DEAD ? `${name}:${data.entityStatus}` : null;
  return name;
}

/** Record the packets of `DEATH_PACKETS` and the events of `DEATH_EVENTS` of `subject`'s bot until `stop`; the packets are `name`, or `name:value` for the ones `noteOf` names, and the events `event:name`. */
export function recordDeath(subject: ContractSubject): { readonly heard: Heard[]; readonly stop: () => void } {
  const { bot } = subject;
  const heard: Heard[] = [];
  const client = bot._client as unknown as { on(name: string, listener: (data: PacketData) => void): void; off(name: string, listener: (data: PacketData) => void): void };
  const note = (name: string, at?: Heard["at"]) => void heard.push({ name, atMs: subject.now(), ...(at && { at }) });
  const packetListeners = DEATH_PACKETS.map((name) => {
    const listener = (data: PacketData) => {
      const noted = noteOf(bot, name, data);
      if (noted !== null) note(noted, name === "position" ? { x: data.x!, y: data.y!, z: data.z! } : undefined);
    };
    client.on(name, listener);
    return { name, listener };
  });
  const eventListeners = DEATH_EVENTS.map((name) => {
    const listener = () => note(`event:${name}`);
    bot.on(name as "death", listener);
    return { name, listener };
  });
  return {
    heard,
    stop() {
      for (const { name, listener } of packetListeners) client.off(name, listener);
      for (const { name, listener } of eventListeners) bot.off(name as "death", listener);
    },
  };
}

/** The names in the order heard. */
export const namesOf = (heard: readonly Heard[]): string[] => heard.map(({ name }) => name);

/** The places the `position` packets named, in order. */
export const positionsOf = (heard: readonly Heard[]): NonNullable<Heard["at"]>[] => heard.flatMap(({ name, at }) => (name === "position" && at ? [at] : []));

/** Within a hundredth of a block on each axis: the server's positions are block centres and half blocks. */
const SAME_PLACE = 0.01;
export const samePlace = (a: NonNullable<Heard["at"]>, b: { readonly x: number; readonly y: number; readonly z: number }): boolean =>
  Math.abs(a.x - b.x) < SAME_PLACE && Math.abs(a.y - b.y) < SAME_PLACE && Math.abs(a.z - b.z) < SAME_PLACE;

/** Wait for what ends a respawn on the client: the second life's health, then Mineflayer's physics running again (it waits 1500 ms after a position that follows a death, `physics.js:426-430`). */
export async function untilPhysicsAgain(subject: ContractSubject, heard: readonly Heard[]): Promise<void> {
  const { bot } = subject;
  let ticks = 0;
  const count = () => void (ticks += 1);
  bot.on("physicsTick", count);
  try {
    await answerArrives(subject, () => heard.some(({ name }) => name === "event:forcedMove"), "no forced move after the respawn", () => namesOf(heard).join(", "));
    ticks = 0;
    await answerArrives(subject, () => ticks >= 3, "no physics tick after the respawn", () => namesOf(heard).join(", "));
  } finally {
    bot.off("physicsTick", count);
  }
  assert.equal(bot.health, 20, "the second life starts at full health");
}

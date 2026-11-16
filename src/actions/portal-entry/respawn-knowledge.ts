import type { Bot } from "mineflayer";

export interface PersonalRespawnObservation {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly dimension: "overworld";
  readonly observedAt: number;
}

const observations = new WeakMap<Bot, PersonalRespawnObservation>();
const wakes = new WeakMap<Bot, { position: { x: number; y: number; z: number }; dimension: string; observedAt: number }>();
const watched = new WeakSet<Bot>();

function watchReset(bot: Bot): void {
  if (watched.has(bot)) return;
  watched.add(bot);
  bot.on("spawnReset", () => { observations.delete(bot); });
}

/** Record only a server-accepted bed use, never Mineflayer's world-spawn coordinate. */
export function recordPersonalRespawn(bot: Bot, position: { x: number; y: number; z: number }): void {
  watchReset(bot);
  observations.set(bot, { position: { ...position }, dimension: "overworld", observedAt: Date.now() });
}

/** Session-local knowledge. Missing means unknown, not world spawn. */
export function personalRespawnObservation(bot: Bot): PersonalRespawnObservation | null {
  watchReset(bot);
  return observations.get(bot) ?? null;
}

/** Record the position the server gave after a death, independently of bed resets. */
export function recordWake(bot: Bot, position: { x: number; y: number; z: number }, dimension: string): void {
  wakes.set(bot, { position: { ...position }, dimension, observedAt: Date.now() });
}

/** The last observed post-death wake in this session. */
export function lastWake(bot: Bot) {
  return wakes.get(bot) ?? null;
}

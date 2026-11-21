// Estimate the remaining burn from the contacts of the body's current burning episode.
import type { Bot } from "mineflayer";
import { isBurning } from "./body.js";

/** Ticks a body burns after its last lava tick: measured 15.04-15.25 s in 19 of 30 runs (facts `lava-pool-footing-and-deep-pools.md`). */
export const BURN_AFTER_LAVA_TICKS = 300;
/**
 * Ticks a body burns after its last fire or soul fire block tick: the longest of 5 runs at 20 and at 10 tps of contract check
 * `fire-block-burn` (2026-11-21; 161-177 ticks after a fire block for a 20 to 40-tick contact, not growing with the time spent in it).
 * A fire block under a body that already burns adds a tick of burn per tick spent in it (lava, then 1-3 ticks in fire: 305-307 ticks
 * after the lava against 301): left out, the estimate is under by a few ticks there.
 */
export const BURN_AFTER_FIRE_TICKS = 177;
export const BURN_TICKS_PER_HP = 20;

/** What each contact kind owes: the burning ticks after its last contact (a soul fire block is read as fire, `body.ts`). */
const BURN_AFTER_CONTACT: Readonly<Record<"lava" | "fire", number>> = { lava: BURN_AFTER_LAVA_TICKS, fire: BURN_AFTER_FIRE_TICKS };

/** One burning episode: the world age its burn ends at, the burn that end was set by, and the age of its latest contact. */
interface Episode {
  endAge: number;
  owed: number;
  lastContactAge: number;
}

const episodes = new WeakMap<Bot, Episode>();

/** Remember a contact in the current episode until the body stops burning or dies; a later contact never shortens what is owed. */
export function recordFireContact(bot: Bot, kind: "lava" | "fire", age: number): void {
  if (!episodes.has(bot)) bot.once("death", () => { episodes.delete(bot); });
  // An unknown kind (a caller outside the type) keeps today's 300 ticks.
  const owed = BURN_AFTER_CONTACT[kind] ?? BURN_AFTER_LAVA_TICKS;
  const episode = episodes.get(bot);
  if (episode === undefined) {
    episodes.set(bot, { endAge: age + owed, owed, lastContactAge: age });
    return;
  }
  episode.lastContactAge = Math.max(episode.lastContactAge, age);
  if (age + owed > episode.endAge) {
    episode.endAge = age + owed;
    episode.owed = owed;
  }
}

/**
 * Estimate ticks and damage left, capped by the burn the episode's last-ending contact owes when the server clock moves backwards.
 * A read that finds the body not burning, after the world age of the latest contact, ends the episode: the burn was put out or
 * ran out, and nothing of it is owed to a later ignition. At the contact's own age the burning flag may still be a packet behind.
 */
export function burnLeft(bot: Bot): { ticks: number; hp: number } {
  const episode = episodes.get(bot);
  if (episode === undefined) return { ticks: 0, hp: 0 };
  if (!isBurning(bot) && bot.time.age > episode.lastContactAge) {
    episodes.delete(bot);
    return { ticks: 0, hp: 0 };
  }
  const ticks = Math.max(0, Math.min(episode.owed, episode.endAge - bot.time.age));
  return { ticks, hp: Math.ceil(ticks / BURN_TICKS_PER_HP) };
}

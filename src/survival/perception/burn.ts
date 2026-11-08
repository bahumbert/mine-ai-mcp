// Estimate the remaining burn from the last observed fire or lava contact.
import type { Bot } from "mineflayer";

export const BURN_AFTER_CONTACT_TICKS = 300;
export const BURN_TICKS_PER_HP = 20;

const contacts = new WeakMap<Bot, number>();

/** Remember the most recent contact until death. */
export function recordFireContact(bot: Bot, _kind: "lava" | "fire", age: number): void {
  if (!contacts.has(bot)) bot.once("death", () => { contacts.delete(bot); });
  contacts.set(bot, Math.max(contacts.get(bot) ?? age, age));
}

/** Estimate ticks and damage left, capped when the server clock moves backwards. */
export function burnLeft(bot: Bot): { ticks: number; hp: number } {
  const contact = contacts.get(bot);
  if (contact === undefined) return { ticks: 0, hp: 0 };
  const ticks = Math.max(0, Math.min(BURN_AFTER_CONTACT_TICKS, BURN_AFTER_CONTACT_TICKS - (bot.time.age - contact)));
  return { ticks, hp: Math.ceil(ticks / BURN_TICKS_PER_HP) };
}

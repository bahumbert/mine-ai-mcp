// The fire reflex and emergency cleanup read the same contact and residual-burn danger.
import type { Bot } from "mineflayer";
import { isBurning, isInFire, isInLava } from "./body.js";
import { burnLeft, recordFireContact } from "./burn.js";

/** Observe current contact before estimating whether the residual burn can kill this body. */
export function readFireDanger(bot: Bot) {
  const inLava = isInLava(bot);
  const inFire = isInFire(bot);
  const burning = isBurning(bot);
  if (inLava) recordFireContact(bot, "lava", bot.time.age);
  if (inFire) recordFireContact(bot, "fire", bot.time.age);
  const burn = burnLeft(bot);
  return { inLava, inFire, burning, lethalBurn: burning && bot.health <= burn.hp, burnTicks: burn.ticks };
}

/** A cleanup must release the body for active fire/lava or a burn that can still kill it. */
export function hasFireDanger(bot: Bot): boolean {
  const danger = readFireDanger(bot);
  return danger.inLava || danger.inFire || danger.lethalBurn;
}

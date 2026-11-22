// Received boat damage and decay pace swings on server progress, including catch-up bursts.
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { entityMetadata } from "../../world/end-fight.js";
import { itemAttack } from "../../world/combat-data.js";
import { SERVER_ANSWER_TICKS, waitForWorldAge } from "../../world/world-age.js";

/** Observe progress before sending a hit; damage decay counts server ticks, never client physics or wall time. */
export function observeBoatAttackProgress(bot: Bot, boat: Entity) {
  let previous = entityMetadata(bot, boat, "damage");
  let recoveredTicks = 0;
  const cooldownTicks = Math.ceil(20 / itemAttack(bot.heldItem?.name ?? null, bot.version).attackSpeed);
  const sentAtAge = bot.time?.age;
  const onUpdate = (entity: Entity) => {
    if (entity !== boat) return;
    const damage = entityMetadata(bot, boat, "damage");
    if (typeof damage !== "number") return;
    if (typeof previous === "number") {
      recoveredTicks += Math.max(0, previous - damage);
    }
    previous = damage;
  };
  bot.on("entityUpdate", onUpdate);
  return {
    // Damage falls once per server tick. Each swing spends fresh progress; catch-up credit is never saved (T15, 2026-11-09).
    wait: (wallMs: number, stopped: () => boolean) => waitForWorldAge(bot, Number.POSITIVE_INFINITY, {
      wallMs,
      until: () => stopped() || recoveredTicks >= cooldownTicks
        || (sentAtAge !== undefined && bot.time?.age - sentAtAge >= SERVER_ANSWER_TICKS),
    }),
    [Symbol.dispose]() { bot.off("entityUpdate", onUpdate); },
  };
}

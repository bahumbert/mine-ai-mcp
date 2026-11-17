import type { BotEvents } from "mineflayer";
import { Vec3 } from "vec3";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { ScenarioCombat } from "../../src/combat.ts";
import { observeIdleWindow } from "../../flat/combat/idle-reflex-window.ts";
import { prepareFortress, releaseThreats } from "./fortress-common.ts";

/** Isolate physical cover under native fortress fire; this does not claim a rod-collection success. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  await prepareFortress(context);
  let shots = 0;
  let covered = false;
  let hitsAfterCover = 0;
  const spawn: BotEvents["entitySpawn"] = (entity) => {
    if (entity.name === "small_fireball") shots++;
  };
  const hurt: BotEvents["entityHurt"] = (entity, source) => {
    if (covered && entity.id === bot.entity.id && source?.name === "blaze") hitsAfterCover++;
  };
  bot.on("entitySpawn", spawn);
  bot.on("entityHurt", hurt);
  try {
    await releaseThreats(context);
    while (shots === 0 && bot.health > 0) await observeIdleWindow(bot, 1, () => shots > 0 || bot.health <= 0, signal);
    const healthBefore = bot.health;
    using responseOwner1 = new ScenarioCombat(bot, context.navigation);
    const shelter = await responseOwner1.hide(bot, { signal, recoverTo: 18, maximumMs: 60_000 });
    covered = shelter.kind !== "failed";
    // Outlast fire already burning when construction finished; the shelter
    // should exclude new blaze hits without consuming a shield.
    await observeIdleWindow(bot, 400, () => bot.health <= 0, signal);
    const protectionBlock = bot.blockAt(new Vec3(-28, 83, 354))?.name ?? null;
    const detail = JSON.stringify({ shots, healthBefore, shelter, hitsAfterCover, health: bot.health, protectionBlock });
    log(`FORTRESS COVER ${detail}`);
    return {
      status: shots > 0 && covered && hitsAfterCover === 0 && bot.health >= 18 ? "succeeded" : "failed",
      detail,
    };
  } finally {
    bot.off("entitySpawn", spawn);
    bot.off("entityHurt", hurt);
  }
};

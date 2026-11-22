import type { BotEvents } from "mineflayer";
import { Vec3 } from "vec3";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { ScenarioCombat } from "../../src/combat.ts";
import { isBurning } from "../../../src/survival/perception/body.ts";
import { observeIdleWindow } from "../../flat/combat/idle-reflex-window.ts";
import { prepareFortress, releaseThreats } from "./fortress-common.ts";
import { observeCombatDecision } from "../../../src/survival/control/combat/observation.ts";

/** Isolate physical cover under native fortress fire; this does not claim a rod-collection success. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  await prepareFortress(context);
  let shots = 0;
  let covered = false;
  let hitsAfterCover = 0;
  /**
   * Every hurt the bot takes, with the source the packet names (null when unattributed), so no damage is relabelled.
   * `healthAtEvent` is the last health the bot holds at the event: the damage's own `update_health` may follow it.
   */
  const hurts: { source: string | null; healthAtEvent: number; covered: boolean; burning: boolean; age: number | null }[] = [];
  const spawn: BotEvents["entitySpawn"] = (entity) => {
    if (entity.name === "small_fireball") shots++;
  };
  const hurt: BotEvents["entityHurt"] = (entity, source) => {
    if (entity.id !== bot.entity.id) return;
    hurts.push({ source: source?.name ?? null, healthAtEvent: bot.health, covered, burning: isBurning(bot), age: bot.time.age });
    if (covered && source?.name === "blaze") hitsAfterCover++;
  };
  bot.on("entitySpawn", spawn);
  bot.on("entityHurt", hurt);
  try {
    await releaseThreats(context);
    while (shots === 0 && bot.health > 0) await observeIdleWindow(bot, 1, () => shots > 0 || bot.health <= 0, signal);
    const healthBefore = bot.health;
    const burningBeforeHide = isBurning(bot);
    const ageBeforeHide = bot.time.age;
    using responseOwner1 = new ScenarioCombat(bot, context.navigation);
    // The residual burn holds the recovery too: the window never opens on a bot still burning or below 18.
    const response = await responseOwner1.respond({ kind: "hide", reason: "hurt",
      threats: observeCombatDecision(bot, responseOwner1.context).contacts,
      recovery: { recoverTo: 18, maximumMs: 60_000, holdWhile: () => isBurning(bot) },
    }, signal);
    if (response.response !== "hide") throw new Error("Fortress cover expected a hide response.");
    const { result: shelter, followUp } = response;
    const protectable = shelter.kind === "recovered" && !isBurning(bot) && bot.health >= 18;
    covered = protectable;
    const atHideEnd = { burning: isBurning(bot), health: bot.health, food: bot.food, age: bot.time.age };
    // Outlast fire already burning when construction finished; the shelter
    // should exclude new blaze hits without consuming a shield.
    if (protectable) await observeIdleWindow(bot, 400, () => bot.health <= 0, signal);
    const protectionBlock = bot.blockAt(new Vec3(-28, 83, 354))?.name ?? null;
    const detail = JSON.stringify({
      shots, healthBefore, burningBeforeHide, ageBeforeHide, shelter, followUp, hitsAfterCover, health: bot.health, food: bot.food,
      protectionBlock, atHideEnd, burningAtEnd: isBurning(bot), ageAtEnd: bot.time.age, hurts,
    });
    log(`FORTRESS COVER ${detail}`);
    return {
      status: shots > 0 && bot.health > 0 && ((covered && hitsAfterCover === 0 && bot.health >= 18) ||
        (shelter.kind === "failed" && shelter.refusal?.cause === "occupied" &&
          (followUp?.response === "evade" && followUp.result.kind === "separated" ||
           followUp?.response === "fight" && followUp.result.kind === "died"))) ? "succeeded" : "failed",
      detail,
    };
  } finally {
    bot.off("entitySpawn", spawn);
    bot.off("entityHurt", hurt);
  }
};

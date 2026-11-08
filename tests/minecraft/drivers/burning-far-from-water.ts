import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { arenaPoint } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";
import { isBurning, isInLava } from "../../../src/survival/perception/body.ts";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";

/** Prove a lethal residual burn selects water and is extinguished there, using the carried bucket when requested. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { contact, start, waterBucket } = z.strictObject({ contact: arenaPoint(context.arena), start: arenaPoint(context.arena), waterBucket: z.boolean().default(false) }).parse(context.scenario.params);
  const { bot } = context;
  const count = (name: string) => bot.inventory.items().filter(item => item.name === name).reduce((total, item) => total + item.count, 0);
  if (waterBucket && (count("water_bucket") !== 1 || count("bucket") !== 0))
    return { status: "failed", detail: "Expected one full water bucket and no empty bucket." };
  bot.chat("/attribute @s minecraft:max_health base set 8");
  await context.waitForTicks(10);
  bot.chat(`/tp @s ${contact.join(" ")}`);
  let touched = false;
  const contactDeadline = monotonicNow() + 4_000;
  while (monotonicNow() < contactDeadline && !touched) {
    touched = isInLava(bot) && isBurning(bot);
    await delay(20);
  }
  if (!touched) return { status: "failed", detail: "Lava contact did not ignite the bot." };
  bot.chat(`/tp @s ${start.join(" ")}`);
  const began = monotonicNow();
  const deadline = began + (waterBucket ? 3_000 : 6_000);
  let selected = false;
  let reached = false;
  while (monotonicNow() < deadline && bot.health > 0) {
    const status = await context.call("view_status", {});
    const fire = status.survival?.decisions.find((entry) => entry.reflex === "fire_reflex")?.decision;
    if (fire && typeof fire === "object" && !Array.isArray(fire) && "kind" in fire && fire.kind === "respond" && "response" in fire && fire.response === "escape_fire" && "reason" in fire && typeof fire.reason === "string" && fire.reason.startsWith("[FIRE] lethal_burn:") && (waterBucket || status.survival?.response?.capability === "fire_reflex")) selected = true;
    if (selected && Reflect.get(bot.entity, "isInWater") && !isBurning(bot) && (!waterBucket || (count("water_bucket") === 0 && count("bucket") === 1))) { reached = true; break; }
    await delay(waterBucket ? 20 : 100);
  }
  const detail = JSON.stringify({ touched, selected, reached, elapsedMs: monotonicNow() - began, health: bot.health, position: bot.entity.position, full: count("water_bucket"), empty: count("bucket") });
  return { status: reached ? "succeeded" : "failed", detail };
}

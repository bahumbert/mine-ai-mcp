import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { arenaPoint } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";
import { isBurning, isInLava } from "../../../src/survival/perception/body.ts";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";

/** Prove a lethal residual burn selects the water route and is extinguished there. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { contact, start } = z.strictObject({ contact: arenaPoint(context.arena), start: arenaPoint(context.arena) }).parse(context.scenario.params);
  const { bot } = context;
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
  const deadline = monotonicNow() + 6_000;
  let selected = false;
  let reached = false;
  while (monotonicNow() < deadline && bot.health > 0) {
    const status = await context.call("view_status", {});
    const fire = status.survival?.decisions.find((entry) => entry.reflex === "fire_reflex")?.decision;
    if (fire && typeof fire === "object" && !Array.isArray(fire) && "kind" in fire && fire.kind === "respond" && "response" in fire && fire.response === "escape_fire" && "reason" in fire && typeof fire.reason === "string" && fire.reason.startsWith("[FIRE] lethal_burn:") && status.survival?.response?.capability === "fire_reflex") selected = true;
    if (selected && Reflect.get(bot.entity, "isInWater") && !isBurning(bot)) { reached = true; break; }
    await delay(100);
  }
  const detail = JSON.stringify({ touched, selected, reached, health: bot.health, position: bot.entity.position });
  return { status: reached ? "succeeded" : "failed", detail };
}

import type { MineAiScenario } from "../../src/scenario-client.ts";
import { openRuntime, standStill } from "../../src/runtime.ts";
import { readEncounters, hurt } from "./reflex.ts";
import type { Bot } from "mineflayer";
import { observeIdleWindow } from "./idle-reflex-window.ts";

/** Observe native hostile contact until the fixture ends or its player dies. */
export async function observeNewContact(bot: Bot, signal: AbortSignal) {
  let died = false;
  const death = () => { died = true; };
  bot.on("death", death);
  try {
    const { observedTicks } = await observeIdleWindow(bot, 400, () => died, signal);
    return { died, observedTicks };
  } finally {
    bot.off("death", death);
  }
}

/** Survive native contact from both sides; the runtime chooses its response. */
export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  await standStill(context);
  if (!(await hurt(context, 11))) return { status: "failed", detail: "Could not arrange wounded health." };
  const blazes = Object.values(bot.entities).filter((entity) => entity.name === "blaze");
  if (blazes.length !== 2) return { status: "failed", detail: "Both declared blazes must be present." };
  const runtime = await openRuntime(context, "new-blaze-contact");
  try {
    bot.chat("/execute as @e[type=blaze] run data merge entity @s {NoAI:0b}");
    const { died, observedTicks } = await observeNewContact(bot, context.signal);
    const encounters = await readEncounters(context, runtime);
    return {
      status: !died && bot.health > 0 ? "succeeded" : "failed",
      detail: JSON.stringify({ died, observedTicks, health: bot.health, encounters }),
    };
  } finally {
    await runtime.close();
  }
};

import type { ClientCompletion } from "mine-labs/client";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { openRuntime } from "../../src/runtime.ts";
import { observeIdleWindow } from "./idle-reflex-window.ts";

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot, signal } = context;
  const runtime = await openRuntime(context, "ghast-return-to-sender");
  const origin = bot.entity.position.clone();

  let ghastDied = false;
  let reflected = false;
  const died = (entity: Parameters<typeof bot.attack>[0]) => {
    if (entity.name === "ghast") ghastDied = true;
  };
  const moved = (entity: Parameters<typeof bot.attack>[0]) => {
    if (entity.name === "fireball" && entity.isValid && entity.velocity.x > 0) reflected = true;
  };
  bot.on("entityDead", died);
  bot.on("entityMoved", moved);
  try {
    await observeIdleWindow(bot, 600, () => ghastDied || bot.health < 20 || bot.entity.position.y < origin.y - 0.5, signal);
    const stayed = bot.entity.position.distanceTo(origin) < 0.5;
    return {
      status: ghastDied && reflected && stayed && bot.health === 20 ? "succeeded" : "failed",
      detail: JSON.stringify({ ghastDied, reflected, stayed, health: bot.health }),
    };
  } finally {
    bot.off("entityDead", died);
    bot.off("entityMoved", moved);
    await runtime.close();
  }
}

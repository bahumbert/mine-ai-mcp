/** Hold combat fixtures still while attaching the runtime at their declared health. */
import { declaredEntitiesArranged, openRuntime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { hurt } from "./reflex.ts";

/** Keep setup time from giving native attackers a head start (T17a, 2026-11-10). */
export async function openAtArrangedHealth(context: MineAiScenarioContext, health: number | undefined, worldId = "combat-idle") {
  if (health === undefined) return openRuntime(context, worldId);
  await declaredEntitiesArranged(context);
  context.bot.chat("/tick freeze");
  context.bot.chat("/gamerule naturalRegeneration false");
  try {
    if (!(await hurt(context, health))) throw new Error(`Arrangement could not establish ${health} health.`);
    const runtime = await openRuntime(context, worldId);
    context.log(`Runtime attached at arranged health ${context.bot.health} (requested ${health}).`);
    return runtime;
  } finally {
    context.bot.chat(`/gamerule naturalRegeneration ${context.scenario.world.gamerules.naturalRegeneration ?? true}`);
    context.bot.chat("/tick unfreeze");
  }
}

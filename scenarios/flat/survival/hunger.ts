/**
 * The bot is asked to do nothing and is made hungry; the hunger reflex must
 * eat what it carries without being asked, and the bot must end fed.
 */
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import { waitServerTicks } from "../../../tests/minecraft/drivers/server-ticks.ts";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  /** Hunger to bring the bot down to before the reflex may act. Requires `op`. */
  hungerTo: z.number().int().min(0).max(20),
  waitTicks: z.number().int().positive(),
});

/** The hunger effect is given for 60 s and the bar gets this many server ticks to reach its target. */
const STARVE_TICKS = 1200;

/** Take the hunger effect off; a chat that fails here never replaces the result of the wait that ended. */
function clearHunger(bot: MineAiScenarioContext["bot"]): void {
  try {
    bot.chat("/effect clear @s minecraft:hunger");
  } catch {
    // The effect times out by itself after its 60 s.
  }
}

/**
 * Drain hunger with the hunger effect, from the client so the scenario can
 * wait for the bar to actually reach the target before the trial starts; the effect is cleared on every exit.
 */
// @function-metrics size=9 branches=2 fan-out=5 depth=2 interface=2 fan-in=1
export async function starve(context: MineAiScenarioContext, target: number): Promise<boolean> {
  const { bot, signal } = context;
  bot.chat("/effect give @s minecraft:hunger 60 255 true");
  try {
    await waitServerTicks(bot, STARVE_TICKS, { signal, until: () => bot.food <= target });
    return bot.food <= target;
  } finally {
    clearHunger(bot);
  }
}

// @function-metrics size=19 branches=6 fan-out=10 depth=3 interface=1 fan-in=0
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const params = paramsSchema.parse(context.scenario.params ?? {});
  if (!(await starve(context, params.hungerTo)))
    return { status: "failed", detail: "Arrangement did not establish the declared hunger." };
  const { bot, signal } = context;
  const hungerAtStart = bot.food;
  const runtime = await openRuntime(context, "survival-hunger");
  let died = false;
  const death = () => {
    died = true;
  };
  bot.on("death", death);
  try {
    const fed = () => died || (bot.food > hungerAtStart && bot.health > 0);
    const waited = await waitServerTicks(bot, params.waitTicks, { signal, until: fed });
    if (!died && bot.food > hungerAtStart && bot.health > 0) {
      const detail = `hunger ${hungerAtStart} -> ${bot.food}; health ${bot.health}`;
      return { status: "succeeded", detail };
    }
    const stalled = waited === "stalled" ? " The server's world age stalled." : "";
    return { status: "failed", detail: `Hunger did not rise; food ${bot.food}, died ${died}.${stalled}` };
  } finally {
    bot.off("death", death);
    await runtime.close();
  }
}

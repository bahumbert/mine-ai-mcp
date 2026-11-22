import type { Bot } from "mineflayer";
import type { ClientCompletion } from "mine-labs/client";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { declareProductiveProgress } from "../../../tests/minecraft/drivers/productive-progress.ts";
import { waitServerTicks } from "../../../tests/minecraft/drivers/server-ticks.ts";
import { SERVER_ANSWER_TICKS } from "../../../src/world/world-age.ts";
import { openRuntime } from "../../src/runtime.ts";
import { hurt } from "../combat/reflex.ts";
import { starve } from "./hunger.ts";

/** Health the YAML's goal asks for (`wounded-bot-eats.yaml` health goal). */
const RECOVERED_HEALTH = 18;
/**
 * After the meal's saturation is spent, regeneration adds only one health every four seconds
 * (80 server ticks): the slow phase of 400 server ticks must be able to cross eighteen as well.
 */
const RECOVERY_TICKS = 400;

export type MealStart = { health: number; food: number; bread: number };

type Meal = Extract<ClientCompletion, { status: "succeeded" | "failed" }>;

/** Bread the bot carries, read from its inventory. */
export function breadCarried(bot: Bot): number {
  return bot.inventory.count(bot.registry.itemsByName.bread!.id, null);
}

/** Why the arranged vitals cannot show a meal (null: they can): wounded, food in (14, 18), bread to eat. */
export function admissionRefusal({ health, food, bread }: MealStart): string | null {
  if (food <= 14 || food >= 18) return `Expected hunger between 14 and 18, observed ${food}.`;
  if (health > 14) return `Expected health at most 14, observed ${health}.`;
  if (bread < 1) return "Carried no bread: a meal could never be seen.";
  return null;
}

/**
 * Judge a meal in server ticks: health back to 18 (the bar reads 17.999998092651367 on the saturation plateau and
 * crosses 18 on the next slow heal, about 79 world ticks later), alive, and one bread fewer than at the start.
 * `progress` hears "healed" while health rises.
 */
export async function awaitMeal(
  bot: Bot, start: MealStart, signal: AbortSignal, progress: (reason: string) => void = () => {},
): Promise<Meal> {
  let died = false;
  const onDeath = () => {
    died = true;
  };
  bot.on("death", onDeath);
  using _progress = declareProductiveProgress(bot, progress, signal);
  try {
    const healed = () => died || bot.health >= RECOVERED_HEALTH;
    const recovery = await waitServerTicks(bot, RECOVERY_TICKS, { signal, until: healed });
    const ate = () => breadCarried(bot) < start.bread;
    // The bread's slot update may arrive after the health that crossed 18.
    if (!died && bot.health >= RECOVERED_HEALTH && !ate()) await waitServerTicks(bot, SERVER_ANSWER_TICKS, { signal, until: ate });
    const seen = `health ${start.health} -> ${bot.health}, hunger ${start.food} -> ${bot.food}, bread ${start.bread} -> ${breadCarried(bot)}`;
    if (died) return { status: "failed", detail: `The bot died during recovery: ${seen}.` };
    if (bot.health < RECOVERED_HEALTH) {
      const stalled = recovery === "stalled" ? " The server's world age stalled." : "";
      return { status: "failed", detail: `Recovery did not complete: ${seen}.${stalled}` };
    }
    if (!ate()) return { status: "failed", detail: `Health recovered but no bread was eaten: ${seen}.` };
    return { status: "succeeded", detail: `Recovered: ${seen}.` };
  } finally {
    bot.off("death", onDeath);
  }
}

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  if (!(await starve(context, 17)) || !(await hurt(context, 14))) {
    return { status: "failed", detail: "Could not arrange wounded, regeneration-blocked vitals." };
  }
  const start = { health: bot.health, food: bot.food, bread: breadCarried(bot) };
  const refusal = admissionRefusal(start);
  if (refusal) return { status: "failed", detail: refusal };
  const runtime = await openRuntime(context, "wounded-hunger");
  try {
    return await awaitMeal(bot, start, signal, context.progress);
  } finally {
    await runtime.close();
  }
};

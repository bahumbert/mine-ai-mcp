/** A hurt bot afloat in a pool must fight or evade, never hide, and keep answering status reads. */
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { describe, hurt, readEncounters, type Encounter } from "./reflex.ts";

const paramsSchema = z.strictObject({
  hurtTo: z.number().int().positive(),
  /** Observation window; the fight or evade is expected well inside it. */
  waitTicks: z.number().int().positive(),
  /** The longest a recent-events read may take while the reflex runs. */
  statusLimitMs: z.number().int().positive(),
});

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const runtime = await openRuntime(context, "combat-in-water");
  const { bot } = context;
  let died = false;
  const death = () => {
    died = true;
  };
  bot.on("death", death);
  try {
    if (Reflect.get(bot.entity, "isInWater") !== true) return { status: "failed", detail: "The arrangement did not leave the bot in water." };
    if (!(await hurt(context, params.hurtTo)))
      return { status: "failed", detail: `Arrangement could not establish ${params.hurtTo} health.` };
    const seen: Encounter[] = [];
    let slowestReadMs = 0;
    for (let tick = 0; tick < params.waitTicks && !died; tick += 5) {
      context.signal.throwIfAborted();
      const started = Date.now();
      seen.push(...(await readEncounters(context, runtime)));
      slowestReadMs = Math.max(slowestReadMs, Date.now() - started);
      if (seen.some((encounter) => encounter.response !== "hide")) break;
      await bot.waitForTicks(5);
    }
    const hid = seen.filter((encounter) => encounter.response === "hide");
    const answered = seen.filter((encounter) => encounter.response !== "hide");
    const detail =
      `died ${died}; hides ${hid.length}; fights or evades ${answered.length}; slowest status read ${slowestReadMs} ms; ` +
      seen.map(describe).join(" | ");
    const passed = hid.length === 0 && answered.length > 0 && slowestReadMs < params.statusLimitMs;
    return { status: passed ? "succeeded" : "failed", detail };
  } finally {
    bot.off("death", death);
    await runtime.close();
  }
}

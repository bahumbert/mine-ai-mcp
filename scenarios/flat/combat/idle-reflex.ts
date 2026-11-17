/** Observe an idle bot under the declared conditions; YAML owns the world goals. */
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import { Vec3 } from "vec3";
import { fullProtectionBlock } from "../../../src/survival/positioning/combat/build-protection.js";
import { wearArmor } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { describe, excessExplosions, readEncounters, watchExplosions, watchShield } from "./reflex.ts";
import { openAtArrangedHealth } from "./arranged-health.ts";
import { observeIdleWindow } from "./idle-reflex-window.ts";

const paramsSchema = z.strictObject({
  provoke: z.string().optional(),
  hurtTo: z.number().int().nonnegative().optional(),
  wearArmor: z.boolean().default(false),
  /** Observation duration in server ticks, not a deadline for a particular survival response. */
  waitTicks: z.number().int().positive(),
  /** Single-quarry fixtures can finish once its death and the combat handoff are observed. */
  finishAfterTargetDeath: z.string().optional(),
  maxExplosions: z.number().int().nonnegative().optional(),
  requiredWallCells: z.array(z.tuple([z.number().int(), z.number().int(), z.number().int()])).default([]),
});

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const runtime = await openAtArrangedHealth(context, params.hurtTo);
  const explosions = watchExplosions(context);
  const shield = watchShield(context);
  let died = false;
  let targetDied = false;
  const targetDeath = (entity: typeof context.bot.entity) => {
    if (params.finishAfterTargetDeath && entity.name === params.finishAfterTargetDeath) targetDied = true;
  };
  context.bot.on("entityDead", targetDeath);
  const death = () => {
    died = true;
  };
  context.bot.on("death", death);
  try {
    if (params.wearArmor) await wearArmor(context);
    if (params.provoke)
      context.bot.chat(
        `/damage @e[type=minecraft:${params.provoke},limit=1,sort=nearest] 1 minecraft:player_attack by @s`,
      );
    const { observedTicks } = await observeIdleWindow(
      context.bot,
      params.waitTicks,
      () => died || (targetDied && !runtime.status().busy),
      context.signal,
    );
    const encounters = await readEncounters(context, runtime);
    const exploded = excessExplosions(explosions.count(), params.maxExplosions);
    const openWalls = params.requiredWallCells.filter(([x, y, z]) => !fullProtectionBlock(context.bot.blockAt(new Vec3(x, y, z))));
    return {
      status: !died && context.bot.health > 0 && !exploded && openWalls.length === 0 ? "succeeded" : "failed",
      detail: `observedTicks ${observedTicks}; ${exploded ?? ""}; open required walls ${JSON.stringify(openWalls)}; health ${context.bot.health}; died ${died}; ${encounters.map(describe).join(" | ")}; ${shield.summary()}`,
    };
  } finally {
    context.bot.off("entityDead", targetDeath);
    context.bot.off("death", death);
    shield.close();
    explosions.close();
    await runtime.close();
  }
}


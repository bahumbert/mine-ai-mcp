import fs from "node:fs";
import path from "node:path";
import type { Bot } from "mineflayer";
import { z } from "zod";
import { entityHealth, dragonPhase } from "../../src/world/end-fight.ts";
import { endCombatActionResultSchema } from "../../src/actions/end-combat-result.ts";
import { declareProductiveProgress } from "../../tests/minecraft/drivers/productive-progress.ts";
import { waitServerTicks } from "../../tests/minecraft/drivers/server-ticks.ts";
import { declaredStart, openRuntime, type Runtime } from "./runtime.ts";
import { recordSourceIdentity } from "./source-identity.ts";
import type { MineAiScenario } from "./scenario-client.ts";
export { prepare } from "./ender-dragon.ts";

/** Let a running reflex keep the body and stop waiting if the server clock stalls. */
async function waitForBowBody(bot: Bot, runtime: Runtime, signal: AbortSignal): Promise<void> {
  const ready = await waitServerTicks(bot, Infinity, { signal, until: () => !runtime.status().busy });
  if (ready !== "until") throw new Error(`Bow fighter waiting for the body ${ready}`);
}

/** Native world kill/survival goals own the verdict. No melee or phase forcing. */
export const run: MineAiScenario = async context => {
  const { bot, signal } = context;
  using _progress = declareProductiveProgress(bot, context.progress, signal);
  const { hitbox_margin } = z.object({ hitbox_margin: z.number().default(0.5) }).parse(context.scenario.params);
  await recordSourceIdentity();
  await using runtime = await openRuntime(context, "dragon-bow");
  const action = runtime.actions.find(action => action.name === "shoot_dragon");
  const navigate = runtime.actions.find(action => action.name === "navigate");
  if (!action || !navigate) throw Error("Missing bow scenario actions");
  const start = declaredStart(context).floored();
  const write = (file: string, value: unknown) => fs.appendFileSync(path.join(process.env.MINE_LABS_ARTIFACTS_DIR!, file), JSON.stringify({ at: Date.now(), ...value as object }) + "\n");
  let ticks = 0;
  const observe = () => {
    if (++ticks % 20) return;
    write("bow-observations.jsonl", { health: bot.health, position: bot.entity.position,
      arrows: bot.inventory.items().filter(i => i.name === "arrow").reduce((sum, i) => sum + i.count, 0),
      dragons: Object.values(bot.entities).filter(e => e.isValid && e.name === "ender_dragon")
        .map(e => ({ id: e.id, health: entityHealth(bot, e), phase: dragonPhase(bot, e) })) });
  };
  bot.on("physicsTick", observe);
  try {
    for (;;) {
      signal.throwIfAborted();
      if (bot.health <= 0) throw Error("Bow fighter died");
      const dragon = Object.values(bot.entities).find(e => e.isValid && e.name === "ender_dragon");
      if (!dragon) { await bot.waitForTicks(20); continue; }
      await waitForBowBody(bot, runtime, signal);
      const output = await runtime.run(action, { entity_id: dragon.id, hitbox_margin }, signal);
      const receipt = endCombatActionResultSchema.parse(output.result);
      write("bow-calls.jsonl", receipt);
      context.log(JSON.stringify(receipt));
      if (receipt.combat.outcome === "dragon_died") return { status: "succeeded", detail: "Observed native dragon death using bow calls." };
      if (receipt.combat.outcome === "weapon_unavailable") throw Error(receipt.combat.reason ?? "Bow unavailable");
      // Defense can leave us beneath a shelter. The caller owns repositioning;
      // repeatedly asking for a shot through that roof cannot make progress.
      if (receipt.combat.reason?.startsWith("[DRAGON_SHOT_BLOCKED]") && bot.entity.position.distanceTo(start) > 2) {
        await waitForBowBody(bot, runtime, signal);
        const moved = await runtime.run(navigate, { x: start.x, y: start.y, z: start.z, range: 0, scaffold: false }, signal);
        write("bow-reposition.jsonl", moved.result);
      }
      await bot.waitForTicks(20);
    }
  } finally { bot.off("physicsTick", observe); }
};

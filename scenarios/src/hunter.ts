/**
 * Run one `collect_mob_drop` request against a real Mine Labs fixture, through
 * the production runtime so the hostile reflex is live alongside the hunt.
 */
import { COLLECT_MOB_DROP, huntMobResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import type { Bot } from "mineflayer";
import { z } from "zod";

import { SERVER_ANSWER_TICKS, STALE_AGE_TICKS } from "../../src/world/world-age.ts";
import { DRIVER_CLOCK_STOPPED_MS, waitServerTicks } from "../../tests/minecraft/drivers/server-ticks.ts";
import { openRuntime, wearArmor } from "./runtime.ts";
import type { MineAiScenarioContext } from "./scenario-client.ts";

const paramsSchema = z.strictObject({
  mob_name: z.string().min(1),
  drop_name: z.string().min(1),
  count: z.number().int().positive().default(1),
  /** Equip the armor the fixture granted before the hunt starts. */
  wear_armor: z.boolean().default(false),
  /** Explicit defeat-only goal for finite mobs with random loot. Never substitutes for acquisition. */
  defeat_count: z.number().int().positive().optional(),
});

/**
 * One line a second on how the fight is going: health, the nearest target's
 * range and height, whether the bot is burning, and the blows landed and
 * taken. A bot that dies takes its hunt result with it, and this is the record
 * that survives. Whether the shield is up is deliberately not here: mineflayer
 * clears its using-item flag on every entity status the bot receives, so the
 * flag reads false through most of a fight the shield is up for.
 */
// @function-metrics size=9 branches=3 fan-out=6 depth=3 interface=2 fan-in=1
function watchFight(context: MineAiScenarioContext, mobName: string): { close(): void; deaths(): number } {
  const { bot } = context;
  let landed = 0;
  let taken = 0;
  let deaths = 0;
  let ticks = 0;
  const onHurt = (entity: { id: number; name?: string }) => {
    if (entity.id === bot.entity.id) taken += 1;
    else if (entity.name === mobName) landed += 1;
  };
  /** Deaths of the species by any hand: the hunt's, or the reflex's when it took the body between kills. */
  const onDead = (entity: { name?: string }) => {
    if (entity.name === mobName) deaths += 1;
  };
  const onTick = () => {
    ticks += 1;
    if (ticks % 20 !== 0) return;
    const nearest = bot.nearestEntity((entity) => entity.name === mobName && entity.isValid);
    const range = nearest ? nearest.position.distanceTo(bot.entity.position).toFixed(1) : "-";
    const rise = nearest ? (nearest.position.y - bot.entity.position.y).toFixed(1) : "-";
    const flags = bot.entity.metadata?.[0];
    const burning = typeof flags === "number" && (flags & 0x01) !== 0;
    const feet = bot.entity.position.floored();
    const roof = bot.blockAt(feet.offset(0, 2, 0))?.boundingBox === "block" ? "roofed" : "open";
    const keys = bot.registry.entitiesByName[mobName]?.metadataKeys ?? [];
    const mood = ["creepy", "stared_at", "flags"]
      .filter((key) => keys.includes(key))
      .map((key) => `${key} ${String(nearest?.metadata?.[keys.indexOf(key)])}`)
      .join(" ");
    const look = `yaw ${bot.entity.yaw.toFixed(2)} pitch ${bot.entity.pitch.toFixed(2)}`;
    context.log(
      `t=${ticks / 20}s health ${bot.health} at ${feet.x},${feet.z} ${roof} ${look} ${mobName} at ${range} (dy ${rise}) ${mood} burning ${burning} landed ${landed} taken ${taken}`,
    );
  };
  bot.on("entityHurt", onHurt);
  bot.on("entityDead", onDead);
  bot.on("physicsTick", onTick);
  return {
    deaths: () => deaths,
    close: () => {
      bot.off("entityHurt", onHurt);
      bot.off("entityDead", onDead);
      bot.off("physicsTick", onTick);
    },
  };
}

/** Reserve enough of the trial deadline for the wait's rounding and completion. */
export function quarryBudgetTicks(goalTimeoutSeconds: number | undefined, firstAge: number | null, ageNow: number | null): number {
  if (goalTimeoutSeconds === undefined) throw new Error("Fixture: the shared hunter needs a goal timeout");
  const elapsed = firstAge === null || ageNow === null ? 0 : ageNow - firstAge;
  return Math.max(0, goalTimeoutSeconds * 20 - elapsed - 2 * SERVER_ANSWER_TICKS - (STALE_AGE_TICKS + 1));
}

/** Wait until the hunt's target predicate can see a loaded quarry. */
export async function awaitQuarry(
  bot: Bot, mobName: string, budgetTicks: number,
  options: { signal?: AbortSignal; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  options.signal?.throwIfAborted();
  const type = bot.registry.entitiesByName[mobName]?.id;
  if (type === undefined) return 0;
  let firstAge = bot.time?.age ?? null;
  let foundAge: number | null = null;
  const loaded = () => {
    const age = bot.time?.age ?? null;
    firstAge ??= age;
    const found = Object.values(bot.entities).some(entity => entity.isValid && entity.entityType === type);
    if (found) foundAge = age;
    return found;
  };
  if (loaded()) return 0;
  const missing = `Fixture: no loaded ${mobName} within ${budgetTicks} server ticks (the hunt would refuse it unloaded)`;
  if (budgetTicks <= 0) throw new Error(missing);
  const result = await waitServerTicks(bot, budgetTicks, { ...options, until: loaded });
  if (result === "stalled") throw new Error(`Fixture: no loaded ${mobName}: the server clock stood still for ${DRIVER_CLOCK_STOPPED_MS} ms`);
  if (result !== "until") throw new Error(missing);
  return firstAge === null || foundAge === null ? 0 : foundAge - firstAge;
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const { bot } = context;
  const firstAge = bot.time?.age ?? null;
  const runtime = await openRuntime(context, "hunt");
  const watch = watchFight(context, params.mob_name);
  const itemId = bot.registry.itemsByName[params.drop_name]!.id;
  const before = bot.inventory.count(itemId, null);
  const died = new AbortController();
  const signal = AbortSignal.any([context.signal, died.signal]);
  const death = () => died.abort("bot died");
  bot.on("death", death);
  try {
    const hunt = runtime.actions.find((action) => action.name === COLLECT_MOB_DROP)!;
    if (params.wear_armor) await wearArmor(context);
    const waited = await awaitQuarry(bot, params.mob_name, quarryBudgetTicks(context.scenario.goal.timeout, firstAge, bot.time?.age ?? null), { signal });
    context.log(`quarry ${params.mob_name} loaded after ${waited} server ticks`);
    const output = await runtime.run(
      hunt,
      {
        mob_name: params.mob_name,
        drop_name: params.drop_name,
        count: params.count,
      },
      signal,
    );
    const parsed = huntMobResultSchema.safeParse(output.result);
    const gained = bot.inventory.count(itemId, null) - before;
    const achieved = params.defeat_count === undefined ? gained >= params.count : watch.deaths() >= params.defeat_count;
    const detail = JSON.stringify({
      goal:
        params.defeat_count === undefined
          ? { drop: params.drop_name, count: params.count }
          : { defeat: params.mob_name, count: params.defeat_count },
      gained,
      deathsObserved: watch.deaths(),
      botDied: died.signal.aborted,
      health: bot.health,
      quarryWaitTicks: waited,
      output,
      combat: parsed.success ? parsed.data.hunt : null,
    });
    context.log(detail);
    return { status: achieved && !died.signal.aborted && bot.health > 0 ? "succeeded" : "failed", detail };
  } catch (cause) {
    if (!died.signal.aborted) throw cause;
    return { status: "failed", detail: "Bot died during the hunt." };
  } finally {
    bot.off("death", death);
    watch.close();
    await runtime.close();
  }
}

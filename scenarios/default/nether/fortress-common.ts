/** Arrangement checks and observed combat evidence shared by the fortress trials. */
import { NAVIGATE } from "@aibengineering/mine-ai-mcp";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import { waitForWorldAge } from "../../../src/world/world-age.ts";
import { DRIVER_CLOCK_STOPPED_MS, waitServerTicks } from "../../../tests/minecraft/drivers/server-ticks.ts";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";
import { z } from "zod";
import { declaredEntitiesArranged, standStill, wearArmor } from "../../src/runtime.ts";
import type { Runtime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { isReturn, requestOf } from "./withdrawal-judge.ts";
import type { WithdrawalRequest } from "./withdrawal-judge.ts";

/** The surveyed exit a fortress trial returns to. Everything else is declared in the scenario file. */
export const fortressParamsSchema = z.strictObject({
  exit: z.tuple([z.number(), z.number(), z.number()]),
});
export type FortressParams = z.output<typeof fortressParamsSchema>;

/**
 * Confirm what the scenario file arranged, then dress for the fight.
 *
 * Mine Labs has already put the bot on its surveyed floor in the Nether,
 * wounded it if the scenario says so, and summoned every declared threat
 * with its AI off. The driver checks that the survey still holds and that
 * the threats are loaded; nothing here moves anything.
 */
export async function prepareFortress(context: MineAiScenarioContext): Promise<void> {
  const { bot } = context;
  if (bot.inventory.items().some((item) => item.name === "blaze_rod"))
    throw new Error("Fortress trial must begin without blaze rods.");
  await bot.waitForChunksToLoad();
  const ground = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
  if (ground?.name !== "nether_bricks")
    throw new Error(`Surveyed fortress floor is ${ground?.name}, not nether_bricks.`);
  if (!(await standStill(context))) throw new Error("Fortress arrangement did not settle on its surveyed floor.");
  await wearArmor(context);
  await declaredEntitiesArranged(context);
  context.log(
    `ARRANGED ${JSON.stringify({ dimension: bot.game.dimension, position: bot.entity.position, health: bot.health, threats: context.scenario.entities })}`,
  );
}

/** The final arrangement command; no operator writes follow it in either trial. */
export async function releaseThreats(context: MineAiScenarioContext): Promise<void> {
  const { bot } = context;
  let acknowledge = () => {};
  let rejectAcknowledgement = (_reason: unknown) => {};
  const acknowledged = new Promise<void>((resolve, reject) => {
    acknowledge = resolve;
    rejectAcknowledgement = reject;
  });
  const abort = () => rejectAcknowledgement(context.signal.reason);
  const message = (text: string) => {
    if (text.includes("fortress_native_ai_ready")) acknowledge();
  };
  bot.on("messagestr", message);
  context.signal.addEventListener("abort", abort, { once: true });
  try {
    bot.chat("/execute as @e[tag=fortress_trial] run data merge entity @s {NoAI:0b}");
    // The connection's commands execute in order. This message confirms AI
    // release was processed before the first measured action can attack.
    bot.chat("/say fortress_native_ai_ready");
    await acknowledged;
  } finally {
    bot.off("messagestr", message);
    context.signal.removeEventListener("abort", abort);
  }
}

/**
 * Ask the server whether the bot stands within `radius` blocks of `exit`: the server's own answer, not the client's
 * position. True when the answer arrives within 40 server ticks; false otherwise. The listener is removed on every exit.
 */
export async function confirmArrival(context: MineAiScenarioContext, exit: Vec3, radius: number): Promise<boolean> {
  const { bot } = context;
  let arrived = false;
  const arrival = (text: string) => {
    if (text.includes("fortress_arrived")) arrived = true;
  };
  bot.on("messagestr", arrival);
  try {
    const { x, y, z } = exit;
    bot.chat(`/execute as ${bot.username} at @s if entity @s[x=${x},y=${y},z=${z},distance=..${radius}] run say fortress_arrived`);
    await waitServerTicks(bot, 40, { signal: context.signal, until: () => arrived });
    return arrived;
  } finally {
    bot.off("messagestr", arrival);
  }
}

/** How a wait for the runner to be free ended: free, the bot died, or the world age stood still for `DRIVER_CLOCK_STOPPED_MS`. */
export type IdleWait = { kind: "idle" } | { kind: "dead" } | { kind: "stalled" };
type Output = Awaited<ReturnType<Runtime["run"]>>;
export interface NavigateInput {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly range: number;
}
export type ReturnRun =
  | { kind: "not_admitted"; wait: IdleWait & { owners: string[] }; outputs: Output[] }
  /** `wait` is how the last wait ended: `idle` after the last admitted navigate, or death or a stall during a wait for a second one. */
  | { kind: "completed"; wait: IdleWait; outputs: Output[]; last: Output; requests: WithdrawalRequest[]; returns: number; owners: string[] };

/** The most navigates a hand-back admits: the first and one fresh one after a return. */
const MOST_ADMITTED_NAVIGATES = 2;

/**
 * Wait until `runtime.status().busy` is false: nothing holds the body and no request is settling. The bot's death
 * (`died` or no health), a world age still for `DRIVER_CLOCK_STOPPED_MS` of wall time, or an abort of `signal`
 * (throws) end it. `owners` lists each action seen holding the body, in order. The status is read on every poll, not
 * only on a time packet: a reflex hands the body back between two packets.
 */
export async function waitForIdleRunner(
  runtime: Pick<Runtime, "status">, bot: Bot, died: AbortSignal, signal: AbortSignal,
): Promise<IdleWait & { owners: string[] }> {
  const owners: string[] = [];
  const dead = () => died.aborted || bot.health <= 0;
  const end = await waitForWorldAge(bot, Infinity, {
    signal, wallMs: Infinity, stallMs: DRIVER_CLOCK_STOPPED_MS,
    until: () => {
      const { busy, activeAction } = runtime.status();
      if (activeAction && !owners.includes(activeAction.action)) owners.push(activeAction.action);
      return !busy || dead();
    },
  });
  if (dead()) return { kind: "dead", owners };
  return { kind: end === "until" ? "idle" : "stalled", owners };
}

/** A request the runner refused before it ran, because the body was taken in between: nothing ran, so it is no request of ours. */
function isUnadmitted(output: Output): boolean {
  return output.durationMs === 0 && (requestOf(output).error ?? "").startsWith("[ACTION_BUSY]");
}

/**
 * Navigate once the runner is idle; one return (a stalled or cover-refused request) gets one fresh navigate, never a third.
 * Each call follows `waitForIdleRunner`, so a navigate is never sent into a body a reflex still holds. A refused
 * `[ACTION_BUSY]` is waited out again: one world-age tick, then the idle wait, bounded by the same death, stall and abort.
 */
export async function navigateWithOneReturn(
  runtime: Pick<Runtime, "run" | "status" | "actions">, bot: Bot, input: NavigateInput, died: AbortSignal, signal: AbortSignal,
): Promise<ReturnRun> {
  const navigate = runtime.actions.find((action) => action.name === NAVIGATE);
  if (!navigate) throw new Error("Fortress hand-back requires navigate.");
  const travel = AbortSignal.any([signal, died]);
  const outputs: Output[] = [];
  const admitted: Output[] = [];
  // Every action seen holding the body across all the waits, in order.
  const owners: string[] = [];
  const finish = (wait: IdleWait): ReturnRun => {
    if (admitted.length === 0) return { kind: "not_admitted", wait: { ...wait, owners }, outputs };
    const requests = admitted.map(requestOf);
    return { kind: "completed", wait: { kind: wait.kind }, outputs, last: admitted[admitted.length - 1]!, requests, returns: requests.filter(isReturn).length, owners };
  };
  for (;;) {
    const wait = await waitForIdleRunner(runtime, bot, died, signal);
    for (const owner of wait.owners) if (!owners.includes(owner)) owners.push(owner);
    if (wait.kind !== "idle") return finish(wait);
    const output = await runtime.run(navigate, input, travel);
    outputs.push(output);
    if (isUnadmitted(output)) {
      // A refusal returns at once: without a pause a runner that stays busy would be asked again with no time between.
      const paused = await waitForWorldAge(bot, 1, { signal, wallMs: Infinity, stallMs: DRIVER_CLOCK_STOPPED_MS, until: () => died.aborted });
      if (paused === "stalled") return finish({ kind: "stalled" });
      continue;
    }
    admitted.push(output);
    if (admitted.length >= MOST_ADMITTED_NAVIGATES || !isReturn(requestOf(output))) return finish({ kind: "idle" });
  }
}

export function observeFortress(context: MineAiScenarioContext) {
  const { bot } = context;
  const started = monotonicNow();
  const initialHealth = bot.health;
  const start = bot.entity.position.clone();
  const dimension = bot.game.dimension;
  let maximumDistanceFromStart = 0;
  let minimumY = bot.entity.position.y;
  let maximumY = bot.entity.position.y;
  const initialArrows = bot.inventory
    .items()
    .filter((item) => item.name === "arrow")
    .reduce((total, item) => total + item.count, 0);
  let previousHealth = initialHealth;
  let minimumHealth = initialHealth;
  let damage = 0;
  let deaths = 0;
  let ticks = 0;
  let hurtEvents = 0;
  let fireballs = 0;
  const mobDeaths: Record<string, number> = {};
  const health = () => {
    damage += Math.max(0, previousHealth - bot.health);
    previousHealth = bot.health;
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  const death = () => {
    deaths++;
  };
  const mobDead = (entity: Entity) => {
    if (entity.name) mobDeaths[entity.name] = (mobDeaths[entity.name] ?? 0) + 1;
  };
  const hurtEntity = (entity: Entity) => {
    if (entity.id === bot.entity.id) hurtEvents++;
  };
  const spawnEntity = (entity: Entity) => {
    if (entity.name === "small_fireball" || entity.name === "fireball") fireballs++;
  };
  const snapshot = () => ({
    elapsedMs: monotonicNow() - started,
    deaths,
    initialHealth,
    minimumHealth,
    health: bot.health,
    damage,
    minimumY,
    maximumY,
    maximumDistanceFromStart,
    mobDeaths,
    hurtEvents,
    fireballs,
    dimension: bot.game.dimension,
    position: bot.entity.position,
    rods: bot.inventory
      .items()
      .filter((item) => item.name === "blaze_rod")
      .reduce((total, item) => total + item.count, 0),
    arrowsConsumedNet:
      initialArrows -
      bot.inventory
        .items()
        .filter((item) => item.name === "arrow")
        .reduce((total, item) => total + item.count, 0),
  });
  const tick = () => {
    // Respawn belongs to the death verdict, not the fortress movement range.
    if (deaths === 0 && bot.game.dimension === dimension) {
      minimumY = Math.min(minimumY, bot.entity.position.y);
      maximumY = Math.max(maximumY, bot.entity.position.y);
      maximumDistanceFromStart = Math.max(maximumDistanceFromStart, bot.entity.position.distanceTo(start));
    }
    if (++ticks % 20 === 0) context.log(`COMBAT ${JSON.stringify(snapshot())}`);
  };
  bot.on("health", health);
  bot.on("death", death);
  bot.on("entityDead", mobDead);
  bot.on("entityHurt", hurtEntity);
  bot.on("entitySpawn", spawnEntity);
  bot.on("physicsTick", tick);
  return {
    snapshot,
    close: () => {
      bot.off("health", health);
      bot.off("death", death);
      bot.off("entityDead", mobDead);
      bot.off("entityHurt", hurtEntity);
      bot.off("entitySpawn", spawnEntity);
      bot.off("physicsTick", tick);
    },
  };
}

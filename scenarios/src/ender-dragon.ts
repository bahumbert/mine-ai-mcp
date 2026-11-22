import { monotonicNow } from "../../src/utils/monotonic-clock.ts";
import type { Bot } from "mineflayer";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { endCombatActionResultSchema } from "../../src/actions/end-combat-result.ts";
import { dragonPhase, entityHealth } from "../../src/world/end-fight.ts";
import { readDragonClouds } from "../../src/world/dragon-hazards.ts";
import { openRuntime, wearArmor } from "./runtime.ts";
import type { MineAiScenario, MineAiScenarioPreparation } from "./scenario-client.ts";
import { recordSourceIdentity } from "./source-identity.ts";
import { createCombatController } from "../../src/survival/control/combat/controller.ts";
import { carriedCount } from "../../src/world/inventory-count.ts";
import { waitForServerPaced } from "../../src/world/server-paced.ts";
import { SERVER_ANSWER_TICKS } from "../../src/world/world-age.ts";
import { declareProductiveProgress } from "../../tests/minecraft/drivers/productive-progress.ts";
import { waitServerTicks } from "../../tests/minecraft/drivers/server-ticks.ts";

const paramsSchema = z.object({
  phase: z.enum(["crystals", "perch", "full"]).default("full"),
  crystal_strategy: z.enum(["mixed", "bow", "melee"]).default("mixed"),
  /** How melee climbs: the reusable spiral, or a scaffold pillar straight up beside the tower. */
  crystal_approach: z.enum(["staircase", "pillar"]).default("staircase"),
  call_gap_ticks: z.number().int().nonnegative().default(20),
});
export type EndActionCall = (name: string, input: unknown) => ReturnType<Awaited<ReturnType<typeof openRuntime>>["run"]>;
type CrystalStrategy = z.infer<typeof paramsSchema>["crystal_strategy"];
type CrystalApproach = z.infer<typeof paramsSchema>["crystal_approach"];
/** Total material the next staircase attempt needs to carry, with the refused attempt's count. */
export interface CrystalShortfall { readonly name: string; readonly needed: number; readonly carried: number }
type CrystalRefill = (shortfall: CrystalShortfall | null) => Promise<void>;

/** Read the material and carried total requested by a staircase refusal. */
export function parseShortfall(error: string): CrystalShortfall | null {
  if (!error.startsWith("[CRYSTAL_STAIRCASE_SHORTFALL]")) return null;
  const match = /: (\d+) (\w+) blocks still needed; carrying (\d+)\./u.exec(error);
  return match ? { needed: Number(match[1]), name: match[2]!, carried: Number(match[3]) } : null;
}

/** Success requires a living player still present in the dimension we observed. */
export function requireLiveEndPlayer(bot: Bot): void {
  if (bot.health <= 0) throw new Error("Player died during End scenario");
  if (bot.game.dimension !== "the_end") throw new Error("Player left the End during the scenario");
}

/** Confirm the objective has stayed gone for 40 server ticks with the fighter alive in the End. */
export async function confirmEndObjective(bot: Bot, signal: AbortSignal, restored?: () => boolean): Promise<boolean> {
  const result = await waitServerTicks(bot, SERVER_ANSWER_TICKS, { signal, until: () => {
    requireLiveEndPlayer(bot);
    return restored?.() ?? false;
  } });
  if (result === "moved") return true;
  if (result === "until") return false;
  throw new Error(`End objective confirmation ${result}`);
}

/** Confirm continuous crystal absence, including a spawn between two world-age looks. */
async function confirmCrystalAbsence(bot: Bot, signal: AbortSignal): Promise<void> {
  const hasCrystals = () => {
    requireLiveEndPlayer(bot);
    return Object.values(bot.entities).some(entity => entity.isValid && entity.name === "end_crystal");
  };
  let reappeared = false;
  const onSpawn = (entity: Bot["entity"]) => { if (entity.name === "end_crystal") reappeared = true; };
  bot.on("entitySpawn", onSpawn);
  try {
    for (;;) {
      const clear = await waitServerTicks(bot, Infinity, { signal, until: () => !hasCrystals() });
      if (clear !== "until") throw new Error(`Waiting for crystals to disappear ${clear}`);
      reappeared = false;
      if (await confirmEndObjective(bot, signal, () => hasCrystals() || reappeared)) return;
    }
  } finally {
    bot.off("entitySpawn", onSpawn);
  }
}

/** Native island boundary, also used by the retained defense regression. */
export const prepare: MineAiScenarioPreparation = async context => {
  const { bot, signal } = context;
  await wearArmor(context);
  const pumpkin = bot.inventory.items().find(item => item.name === "carved_pumpkin");
  if (pumpkin) await bot.equip(pumpkin, "head");
  await bot.waitForChunksToLoad();
  const crystalsEnd = await waitForServerPaced(bot, 400, { signal,
    until: () => Object.values(bot.entities).filter(e => e.isValid && e.name === "end_crystal").length === 10,
  });
  if (crystalsEnd !== "until")
    throw new Error(`Expected all ten native crystals before the scenario starts (${crystalsEnd})`);
  if (paramsSchema.parse(context.scenario.params ?? {}).phase !== "perch") return;
  // Arrange only the zero-crystal boundary. Landing and head direction remain native.
  bot.chat("/execute in minecraft:the_end run kill @e[type=end_crystal]");
  const zeroEnd = await waitForServerPaced(bot, 100, { signal,
    until: () => !Object.values(bot.entities).some(e => e.isValid && e.name === "end_crystal"),
  });
  if (zeroEnd !== "until") throw new Error(`Zero-crystal setup was not acknowledged (${zeroEnd})`);
};

/** Classify observed cages, never seed-specific tower heights. */
export function crystalIsCaged(bot: Bot, crystal: Bot["entity"]): boolean {
  let caged = false;
  const center = crystal.position.floored();
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = -1; y <= 3; y++) {
    const block = bot.blockAt(center.offset(x, y, z));
    if (!block) throw new Error("Crystal cage area is not loaded: " + crystal.id);
    caged ||= block.name === "iron_bars";
  }
  return caged;
}

/** Give this refusal one retry if no inventory changed, preserving the action's explanation on failure. */
async function refillForCrystal(bot: Bot, refill: CrystalRefill | undefined, shortfall: CrystalShortfall,
  refusal: string, unfilledRefusal: string | null): Promise<string | null> {
  if (!refill || refusal === unfilledRefusal) throw new Error(refusal);
  const carried = carriedCount(bot, shortfall.name);
  await refill(shortfall);
  return carriedCount(bot, shortfall.name) > carried ? null : refusal;
}

/** Shared by crystal-only and full fights. Replay callers can resupply before each tower. */
export async function clearCrystals(bot: Bot, call: EndActionCall, strategy: CrystalStrategy,
  beforeCrystal?: CrystalRefill, signal?: AbortSignal, approach: CrystalApproach = "staircase"): Promise<void> {
  const targets = Object.values(bot.entities).filter(e => e.isValid && e.name === "end_crystal")
    .map(entity => ({ entity, caged: crystalIsCaged(bot, entity) }));
  if (targets.length !== 10) throw new Error("Expected ten observed crystals, found " + targets.length);
  targets.sort((a, b) => (strategy === "mixed" ? Number(a.caged) - Number(b.caged) : 0) || a.entity.position.y - b.entity.position.y);
  for (const { entity, caged } of targets) {
    signal?.throwIfAborted();
    await beforeCrystal?.(null);
    let unfilledRefusal: string | null = null;
    const weapon = strategy === "mixed" ? (caged ? "melee" : "bow") : strategy;
    for (;;) {
      signal?.throwIfAborted();
      const observed = Object.values(bot.entities).find(candidate => candidate.isValid && candidate.name === "end_crystal" && candidate.position.distanceTo(entity.position) < 2);
      if (!observed) { await bot.waitForTicks(20); continue; }
      const output = await call("destroy_end_crystal", { entity_id: observed.id, weapon, approach });
      const receipt = endCombatActionResultSchema.parse(output.result);
      // A failed descent does not resurrect the crystal. The action retains
      // its native destruction observation independently of route success.
      if (receipt.combat.outcome === "crystal_destroyed" || output.request?.evidence?.completion.observed === true) break;
      const refusal = receipt.status === "failed" ? receipt.error : undefined;
      const shortfall = refusal ? parseShortfall(refusal) : null;
      if (refusal && shortfall) {
        unfilledRefusal = await refillForCrystal(bot, beforeCrystal, shortfall, refusal, unfilledRefusal);
        continue;
      }
      if (receipt.combat.outcome === "shot_missed") continue;
      if (receipt.status !== "succeeded") {
        await bot.waitForTicks(20);
        continue;
      }
      await bot.waitForTicks(20);
    }
  }
}

/** One preparation/attack caller for fresh perch fights and complete runs, returning the observed dead dragon. */
export async function fightPerches(bot: Bot, call: EndActionCall, signal: AbortSignal): Promise<Bot["entity"]> {
  let prepared = false;
  for (;;) {
    signal.throwIfAborted();
    const dragon = Object.values(bot.entities).find(e => e.isValid && e.name === "ender_dragon");
    if (!dragon) { await bot.waitForTicks(20); continue; }
    if (entityHealth(bot, dragon) === 0) return dragon;
    if (!prepared) {
      const receipt = endCombatActionResultSchema.parse((await call("prepare_dragon_perch", { entity_id: dragon.id })).result);
      if (receipt.status === "cancelled" && receipt.interruptedBy?.kind === "preempted" && receipt.interruptedBy.by === "recover_footing") continue;
      if (receipt.combat.reason?.startsWith("[PERCH_PASSAGE_CLOUDED]")) {
        await bot.waitForTicks(20);
        continue;
      }
      if (receipt.status !== "succeeded") { await bot.waitForTicks(20); continue; }
      prepared = receipt.combat.outcome === "perch_ready";
      // An early landing yield attacks immediately; unfinished preparation
      // resumes between later requests rather than replacing this window.
    }
    const receipt = endCombatActionResultSchema.parse((await call("attack_dragon_perch", { entity_id: dragon.id })).result);
    signal.throwIfAborted();
    if (receipt.combat.outcome === "dragon_died") return dragon;
    if (receipt.status === "cancelled" && receipt.interruptedBy?.kind === "preempted" && receipt.interruptedBy.by === "recover_footing") continue;
    if (receipt.combat.reason?.startsWith("[PERCH_PASSAGE_CLOUDED]")) {
      prepared = false;
      await bot.waitForTicks(20);
      continue;
    }
    if (receipt.status !== "succeeded") { prepared = false; await bot.waitForTicks(20); continue; }
  }
}

/** Retain only perch decision evidence, alongside the call that produced it. */
function recordPerchDecisions(combat: ReturnType<typeof createCombatController>, artifacts: string,
  call: () => { ms: number; callSequence: number; action: string | null }): () => void {
  return combat.onDecision(event => {
    if (event.kind !== "response" || !event.evidence || typeof event.evidence !== "object" ||
        Array.isArray(event.evidence) || !("boundary" in event.evidence) || event.evidence.boundary !== "dragon_perch") return;
    appendFileSync(path.join(artifacts, "perch-decisions.jsonl"), JSON.stringify({ ...call(), ...event.evidence }) + "\n");
  });
}

/** Report completion after observing the objective with a surviving End fighter. */
export const run: MineAiScenario = async context => {
  const { bot, log } = context;
  const stop = new AbortController();
  const signal = AbortSignal.any([context.signal, stop.signal]);
  using _progress = declareProductiveProgress(bot, context.progress, signal);
  await recordSourceIdentity();
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const artifacts = process.env.MINE_LABS_ARTIFACTS_DIR!;
  const startedAt = monotonicNow();
  let callSequence = 0;
  let currentAction: string | null = null;
  let stopDiagnostics = () => {};
  await using runtime = await openRuntime(context, "ender-dragon", {
    createCombatController: (...args) => {
      const combat = createCombatController(...args);
      stopDiagnostics = recordPerchDecisions(combat, artifacts,
        () => ({ ms: monotonicNow() - startedAt, callSequence, action: currentAction }));
      return combat;
    },
  });
  let stage: "crystals" | "perch" = params.phase === "perch" ? "perch" : "crystals";
  let ticks = 0, deaths = 0, lowestHealth = bot.health;
  const snapshot = () => ({ ms: monotonicNow() - startedAt, stage, health: bot.health, lowestHealth, deaths,
    position: bot.entity.position, grounded: bot.entity.onGround,
    crystals: Object.values(bot.entities).filter(e => e.isValid && e.name === "end_crystal").length,
    dragons: Object.values(bot.entities).filter(e => e.isValid && e.name === "ender_dragon")
      .map(e => ({ id: e.id, health: entityHealth(bot, e), phase: dragonPhase(bot, e) })),
    clouds: readDragonClouds(bot) });
  const observe = () => {
    lowestHealth = Math.min(lowestHealth, bot.health);
    if (++ticks % 20 === 0) appendFileSync(path.join(artifacts, "fight-observations.jsonl"), JSON.stringify(snapshot()) + "\n");
    if (ticks % 100 === 0) log(JSON.stringify(snapshot()));
  };
  const death = () => { deaths++; lowestHealth = 0; stop.abort(new Error("Player died during End scenario")); };
  bot.on("physicsTick", observe);
  bot.on("death", death);
  const call: EndActionCall = async (name, input) => {
    signal.throwIfAborted();
    for (let t = 0; t < params.call_gap_ticks; t++) { signal.throwIfAborted(); await bot.waitForTicks(1); }
    while (runtime.status().busy) { signal.throwIfAborted(); await bot.waitForTicks(1); }
    const action = runtime.actions.find(a => a.name === name);
    if (!action) throw new Error("Missing action " + name);
    const at = monotonicNow();
    callSequence++;
    currentAction = name;
    appendFileSync(path.join(artifacts, "calls.jsonl"), JSON.stringify({ ms: at - startedAt, callSequence, name, input }) + "\n");
    log("CALL " + name + " " + JSON.stringify(input));
    const output = await runtime.run(action, input, signal);
    appendFileSync(path.join(artifacts, "calls.jsonl"), JSON.stringify({ ms: monotonicNow() - startedAt, callSequence, name, durationMs: monotonicNow() - at, output }) + "\n");
    currentAction = null;
    log("RESULT " + name + ": " + output.result.status);
    return output;
  };
  try {
    if (params.phase !== "perch") await clearCrystals(bot, call, params.crystal_strategy, undefined, signal, params.crystal_approach);
    if (params.phase === "crystals") await confirmCrystalAbsence(bot, signal);
    else {
      stage = "perch";
      await fightPerches(bot, call, signal);
      await confirmEndObjective(bot, signal);
    }
    signal.throwIfAborted();
    requireLiveEndPlayer(bot);
    return { status: "succeeded" };
  } catch (error) {
    if (!context.signal.aborted) {
      const failure = { error: String(error), ...snapshot() };
      writeFileSync(path.join(artifacts, "failure.json"), JSON.stringify(failure, null, 2));
      return { status: "failed", detail: JSON.stringify(failure) };
    }
    throw error;
  } finally {
    stopDiagnostics();
    bot.off("physicsTick", observe);
    bot.off("death", death);
  }
};

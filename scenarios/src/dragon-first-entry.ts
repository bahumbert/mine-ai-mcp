/** Reproduce the recorded first End entry and retain its first failure with server-paced waits. */
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { MAX_COLLECT_BLOCKS } from "../../src/actions/collect-block/contract.ts";
import { dragonPhase, entityHealth } from "../../src/world/end-fight.ts";
import { carriedCount } from "../../src/world/inventory-count.ts";
import { serverPacedElapsed, serverPacedSignal, waitForServerPaced } from "../../src/world/server-paced.ts";
import { SERVER_ANSWER_TICKS } from "../../src/world/world-age.ts";
import { declareProductiveProgress } from "../../tests/minecraft/drivers/productive-progress.ts";
import { openRuntime, type Runtime } from "./runtime.ts";
import type { MineAiScenario, MineAiScenarioPreparation } from "./scenario-client.ts";
import { recordSourceIdentity } from "./source-identity.ts";
import { clearCrystals, confirmEndObjective, fightPerches, type CrystalShortfall, type EndActionCall } from "./ender-dragon.ts";
import { recordedLoadoutSchema, restoreRecordedLoadout } from "./recorded-loadout.ts";

const paramsSchema = z.object({
  loadout: recordedLoadoutSchema,
});
const junk = ["leather", "coal", "gravel", "oak_log", "porkchop", "stone_button", "mossy_stone_bricks", "smooth_stone_slab", "string", "gunpowder", "furnace", "blaze_powder"];
const ACTION_BUDGET_TICKS = 3_600;
const ACTION_STOPPED_MS = 180_000;

/** Bound a first-entry action while preserving its caller's cancellation. */
export async function runActionWithin(runtime: Pick<Runtime, "run">, action: Parameters<Runtime["run"]>[0], input: unknown, bot: Bot, signal: AbortSignal) {
  signal.throwIfAborted();
  using budget = serverPacedSignal(bot, ACTION_BUDGET_TICKS, { stoppedMs: ACTION_STOPPED_MS });
  return await runtime.run(action, input, AbortSignal.any([signal, budget.signal]));
}

/** Observe the native dragon removal before declaring the fight complete. */
export async function awaitDragonRemoval(bot: Bot, dragon: Entity | undefined, signal: AbortSignal): Promise<void> {
  const elapsed = serverPacedElapsed(bot);
  // The approved removal observation ends at its 39 s wall backstop, beyond the default 20 s stall (part 2 T3).
  const end = await waitForServerPaced(bot, 240, { until: () => !dragon?.isValid, stoppedMs: null, signal });
  if (end !== "until") throw new Error(`Native death/removal was not observed: ${JSON.stringify({ end, ...elapsed() })}`);
}

/** Allow a late health/death answer before recording the first failure. */
export async function settleFailure(bot: Bot, signal: AbortSignal): Promise<void> {
  await waitForServerPaced(bot, SERVER_ANSWER_TICKS, { until: () => bot.health <= 0, signal });
}

/** Setup restores recorded slots/durability, which Mine Labs' inventory list cannot express. */
export const prepare: MineAiScenarioPreparation = async ({ bot, scenario, signal, log }) => {
  const { loadout } = paramsSchema.parse(scenario.params);
  await restoreRecordedLoadout(bot, loadout, signal);
  if (bot.health !== 20 || !bot.entity.onGround || bot.blockAt(bot.entity.position)?.name !== "air")
    throw new Error("First-entry fixture did not start healthy on clear island footing");
  log(JSON.stringify({ verifiedLoadout: loadout, position: bot.entity.position, health: bot.health, food: bot.food }));
};

/** Keep the recorded fight evidence and first-death stop alive only while the trial runs. */
function observeFirstEntry(bot: Bot, artifacts: string, log: (line: string) => void, stop: AbortController) {
  const state = { deaths: 0, lowestHealth: bot.health, calls: 0, stage: "preparing_inventory" };
  const snapshot = () => ({ at: new Date().toISOString(), stage: state.stage, health: bot.health, food: bot.food,
    position: bot.entity.position.clone(), velocity: bot.entity.velocity.clone(), onGround: bot.entity.onGround,
    held: bot.heldItem?.name ?? null, water: bot.inventory.items().filter(i => i.name === "water_bucket" || i.name === "bucket").map(i => ({ name: i.name, slot: i.slot })),
    crystals: Object.values(bot.entities).filter(e => e.isValid && e.name === "end_crystal").map(e => ({ id: e.id, position: e.position.clone() })),
    dragons: Object.values(bot.entities).filter(e => e.isValid && e.name === "ender_dragon").map(e => ({ id: e.id, health: entityHealth(bot, e), phase: dragonPhase(bot, e) })),
  });
  let deathSnapshot: ReturnType<typeof snapshot> | null = null;
  const death = () => {
    state.deaths++;
    state.lowestHealth = 0;
    deathSnapshot ??= snapshot();
    stop.abort(new Error("First player death; stop this trial and retain its incident"));
  };
  let ticks = 0;
  const observe = () => {
    state.lowestHealth = Math.min(state.lowestHealth, bot.health);
    if (++ticks % 20 === 0) appendFileSync(path.join(artifacts, "fight-observations.jsonl"), JSON.stringify(snapshot()) + "\n");
    if (ticks % 200 === 0) log(JSON.stringify(snapshot()));
  };
  bot.on("death", death);
  bot.on("physicsTick", observe);
  return { state, snapshot, deathSnapshot: () => deathSnapshot, [Symbol.dispose]: () => {
    bot.off("death", death);
    bot.off("physicsTick", observe);
  } };
}

/** Dependencies for one recorded call, including its trial-scoped evidence and cancellation. */
interface FirstEntryCallOptions {
  readonly runtime: Runtime;
  readonly bot: Bot;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
  readonly artifacts: string;
  readonly observation: ReturnType<typeof observeFirstEntry>;
}

/** Wait for admission, execute under a fresh action budget, and retain the observed call/result. */
async function callFirstEntryAction(name: string, input: unknown, options: FirstEntryCallOptions) {
  const { runtime, bot, signal, log, artifacts, observation: { state, snapshot } } = options;
  signal.throwIfAborted();
  const elapsed = serverPacedElapsed(bot);
  const ready = await waitForServerPaced(bot, ACTION_BUDGET_TICKS, {
    until: () => !runtime.status().busy, stoppedMs: ACTION_STOPPED_MS, signal,
  });
  if (ready !== "until") throw new Error(`Runtime remained busy: ${JSON.stringify({ end: ready, ...elapsed() })}`);
  const action = runtime.actions.find(a => a.name === name);
  if (!action) throw new Error(`Missing action ${name}`);
  const start = snapshot();
  log(`CALL ${++state.calls} ${name} ${JSON.stringify(input)}`);
  const output = await runActionWithin(runtime, action, input, bot, signal);
  appendFileSync(path.join(artifacts, "fight-calls.jsonl"), JSON.stringify({ name, input, start, end: snapshot(), output }) + "\n");
  log(`RESULT ${name} ${output.result.status}`);
  signal.throwIfAborted();
  return output;
}

/** Collect what the tower requested, stopping if a collection leaves the inventory unchanged. */
async function refillStaircase(bot: Bot, call: EndActionCall, { name, needed }: CrystalShortfall): Promise<void> {
  let carried = carriedCount(bot, name);
  while (carried < needed) {
    await call("collect_block", { block_name: name, count: Math.min(MAX_COLLECT_BLOCKS, needed - carried) });
    const after = carriedCount(bot, name);
    if (after <= carried) return;
    carried = after;
  }
}

/** A small scripted caller: mine carried scaffolding, clear towers, then prepare/attack perches. */
export const run: MineAiScenario = async (context) => {
  const { bot, log } = context;
  const stop = new AbortController();
  const signal = AbortSignal.any([context.signal, stop.signal]);
  using _progress = declareProductiveProgress(bot, context.progress, signal);
  await recordSourceIdentity();
  const staging = bot.entity.position.floored();
  const artifacts = process.env.MINE_LABS_ARTIFACTS_DIR!;
  // A separate directory per trial plus a larger cap keeps the first failure's
  // physical window. No later death/recovery loop can prune it from this run.
  await using runtime = await openRuntime(context, `dragon-first-entry-${context.scenario.world.seed}`, {
    incidents: { retention: { days: 5, maxBytes: 512 * 1024 * 1024 } },
  });
  using observation = observeFirstEntry(bot, artifacts, log, stop);
  const { state, snapshot } = observation;
  const call = (name: string, input: unknown) => callFirstEntryAction(name, input, {
    runtime, bot, signal, log, artifacts, observation,
  });
  const requireCall = async (name: string, input: unknown) => {
    const output = await call(name, input);
    // Partial collection is usable when the inventory really gained supplies.
    if (name === "collect_block" && output.result.status === "partial" &&
      output.result.error?.startsWith("[DROP_RECOVERY_EXHAUSTED]")) return output;
    if (output.result.status !== "succeeded") throw new Error(`${name} stopped: ${JSON.stringify(output.result)}`);
    return output;
  };
  try {
    const status = await requireCall("view_status", {});
    if (!status.survivalPolicy) throw new Error("Survival policy revision unavailable before fight setup");
    await requireCall("set_survival_policy", { operation: "set", expected_revision: status.survivalPolicy.revision,
      changes: { combat: { engagement: "defend_only", hide: "never" } }, lifetime: { kind: "session" },
      reason: "Reproduce Claude's first End fight: defend against endermen without pursuing or hiding." });
    await requireCall("drop_item", { items: junk.map(item_name => ({ item_name })), in_a_hole: true });
    state.stage = "crystals";
    await clearCrystals(bot, call, "melee", async shortfall => {
      // Return to staging before a new tower. A return after resupply could spend the blocks the retry needs.
      if (shortfall) await refillStaircase(bot, requireCall, shortfall);
      else await requireCall("navigate", { x: staging.x, y: staging.y, z: staging.z, range: 1, build: true });
    }, signal);
    state.stage = "perches";
    const dragon = await fightPerches(bot, call, signal);
    await awaitDragonRemoval(bot, dragon, signal);
    await confirmEndObjective(bot, signal);
    const result = { status: "succeeded" as const, detail: JSON.stringify({ deaths: state.deaths, lowestHealth: state.lowestHealth, calls: state.calls, final: snapshot() }) };
    writeFileSync(path.join(artifacts, "fight-result.json"), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    if (context.signal.aborted) throw error;
    // A dry client-side impact can precede the server's health/death packet.
    // Observe that short settlement before freezing the failure summary.
    await settleFailure(bot, context.signal);
    context.signal.throwIfAborted();
    const incident = await runtime.captureIncident();
    await runtime.flushIncidents();
    const result = { status: "failed" as const, detail: JSON.stringify({ error: String(error), deaths: state.deaths, lowestHealth: state.lowestHealth, calls: state.calls, death: observation.deathSnapshot(), final: snapshot() }) };
    writeFileSync(path.join(artifacts, "fight-result.json"), JSON.stringify(result, null, 2));
    writeFileSync(path.join(artifacts, "failure-incident.json"), JSON.stringify(incident, null, 2));
    return result;
  }
};

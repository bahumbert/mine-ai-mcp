import { randomUUID } from "node:crypto";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import { huntCheckpointSchema } from "../../../src/actions/checkpoint-schemas.ts";
import { COLLECT_MOB_DROP } from "../../../src/actions/hunt-mob/contract.ts";
import type { LiveProgress } from "../../../src/session/async-actions.ts";
import { AGE_PACKET_TICKS, waitForWorldAge } from "../../../src/world/world-age.ts";
import { declareProductiveProgress } from "../../../tests/minecraft/drivers/productive-progress.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "../../../tests/minecraft/drivers/server-ticks.ts";
import type { Bot, BotEvents } from "mineflayer";
import { Vec3 } from "vec3";
import {
  declaredEntities,
  declaredEntitiesArranged,
  declaredStart,
  openRuntime,
  wearArmor,
} from "../../src/runtime.ts";
import type { MineAiScenario, MineAiScenarioContext } from "../../src/scenario-client.ts";
import type { Runtime } from "../../src/runtime.ts";
import { observe } from "./hazards/pit.ts";
import { confirmArrival, navigateWithOneReturn, releaseThreats } from "./fortress-common.ts";
import { isSafeHuntRefusal, judgeFortressHunt } from "./fortress-judge.ts";
import { readReflexOutcomes } from "../../flat/combat/reflex.ts";
import { z } from "zod";
import { recordSourceIdentity } from "../../src/source-identity.ts";
import { judgeDrops } from "../../src/game-rate.ts";
import { serverPacedElapsed, waitForServerPaced } from "../../../src/world/server-paced.ts";

const collectionSchema = z.strictObject({
  drops: z.number().int().positive().default(12),
  minimumDropsPerMinute: z.number().positive().optional(),
  camp_spawner: z.boolean().default(false),
  observe_for_ms: z.number().int().positive().default(720_000),
  handBack: z.tuple([z.number(), z.number(), z.number()]),
});

/** The outer hunt's observing phase also covers camp return travel, whose own phase has precedence. */
function isObservingHunt({ request }: LiveProgress): boolean {
  if (request?.state.kind !== "running") return false;
  const checkpoint = huntCheckpointSchema.safeParse(request.evidence?.checkpoint);
  if (!checkpoint.success) return false;
  const { phase, camp } = checkpoint.data;
  if (phase !== "observing") return false;
  return !camp || camp.phase === "waiting_away" || camp.phase === "waiting_at_spawner";
}

/** Verify observation credit against the live request just before a time packet can reset the watchdog. */
export function declareFortressProgress(
  actions: Pick<Runtime["asyncActions"], "status">,
  bot: Bot,
  publish: MineAiScenarioContext["progress"],
  signal: AbortSignal,
) {
  let observedActionId: string | null = null;
  const observer = declareProductiveProgress(bot, (reason) => {
    if (reason === "observing") {
      const active = actions.status().active;
      if (!active || active.actionId !== observedActionId || !isObservingHunt(active)) return;
    }
    publish(reason);
  }, signal);
  return {
    observeHunt(actionId: string | null) {
      observedActionId = actionId;
      observer.observing(actionId !== null);
    },
    [Symbol.dispose]: () => observer[Symbol.dispose](),
  };
}

/** Retrieve the hunt before a hand-back, reading its live checkpoint on each server time packet. */
export async function runFortressHunt(
  { actions, asyncActions }: Pick<Runtime, "actions" | "asyncActions">,
  bot: Bot,
  input: { mob_name: string; drop_name: string; count: number; observe_for_ms?: number; camp_spawner?: boolean },
  progress: ReturnType<typeof declareFortressProgress>,
  signal: AbortSignal,
) {
  const died = new AbortController();
  const huntSignal = AbortSignal.any([signal, died.signal]);
  huntSignal.throwIfAborted();
  const hunt = actions.find((action) => action.name === COLLECT_MOB_DROP);
  if (!hunt) throw new Error("Fortress collection requires collect_mob_drop.");
  const admission = asyncActions.submit(hunt, input, { submission_id: randomUUID() }, 1);
  if (admission.state === "refused") throw new Error(admission.error);

  const { actionId } = admission;
  const death = () => died.abort(new Error("Fortress bot died during the hunt."));
  bot.on("death", death);
  let active = true;
  let clockStopped = false;
  try {
    for (;;) {
      const wait = await asyncActions.wait(actionId, 0, huntSignal);
      if (wait.state === "settled") {
        active = false;
        return wait.output;
      }
      if (wait.state !== "pending") throw new Error(wait.error);
      if (clockStopped) throw new Error("Fortress hunt world age stopped advancing.");
      progress.observeHunt(isObservingHunt(wait.progress) ? actionId : null);
      const slice = await waitForWorldAge(bot, AGE_PACKET_TICKS, {
        signal: huntSignal, wallMs: Infinity, stallMs: DRIVER_CLOCK_STOPPED_MS,
      });
      clockStopped = slice === "stalled";
    }
  } finally {
    bot.off("death", death);
    progress.observeHunt(null);
    if (active) asyncActions.cancel(actionId, "Fortress trial ended before the hunt settled.");
  }
}

/** Report all reflex outcomes observed during the fortress trial. */
async function reportReflexOutcomes(context: MineAiScenarioContext, runtime: Runtime) {
  const reflex = await readReflexOutcomes(context, runtime);
  for (const encounter of reflex.encounters) context.log(`FORTRESS ENCOUNTER ${JSON.stringify(encounter)}`);
  for (const limit of reflex.limits) context.log(`FORTRESS REFLEX LIMIT ${JSON.stringify(limit)}`);
  for (const failure of reflex.failures) context.log(`FORTRESS REFLEX FAILURE ${JSON.stringify(failure)}`);
  return { reflexLimits: reflex.limits.length, reflexFailures: reflex.failures.length };
}

/** Confirm equipment and the surveyed fortress before attaching runtime defence. */
async function prepareFortress(context: MineAiScenarioContext, spawner: Vec3): Promise<void> {
  const { bot } = context;
  const start = declaredStart(context);
  // Spectator inventory clicks are rejected by vanilla. Equip while still
  // in survival, then require the server's equipment slots before teleporting.
  await wearArmor(context);
  const boots = bot.inventory.slots[8]?.name;
  if (boots !== "diamond_boots" && boots !== "golden_boots") throw new Error("Unexpected fortress boots");
  let equipped = false;
  const confirm = (message: string) => {
    if (message === "FORTRESS_ARMOR_CONFIRMED") equipped = true;
  };
  bot.on("messagestr", confirm);
  try {
    bot.chat(
      `/execute if items entity @s armor.head diamond_helmet if items entity @s armor.chest diamond_chestplate if items entity @s armor.legs diamond_leggings if items entity @s armor.feet ${boots} run tellraw @s "FORTRESS_ARMOR_CONFIRMED"`,
    );
    await observe(bot, () => equipped, "server-confirmed expedition armour");
  } finally {
    bot.off("messagestr", confirm);
  }
  await bot.waitForChunksToLoad();
  if (bot.blockAt(spawner)?.name !== "spawner" || bot.blockAt(start.offset(0, -1, 0))?.name !== "nether_bricks")
    throw new Error("The surveyed live fortress spawner/floor changed.");
  for (const p of [start, start.offset(0, 1, 0)])
    if (bot.blockAt(p)?.boundingBox !== "empty") throw new Error(`Fortress starting body intersects ${p}.`);
  for (const { position } of declaredEntities(context)) {
    if ([position, position.offset(0, 1, 0)].some((cell) => bot.blockAt(cell)?.boundingBox !== "empty"))
      throw new Error(`Initial blaze body intersects generated terrain at ${position}.`);
  }
  await declaredEntitiesArranged(context);
  const rodId = bot.registry.itemsByName.blaze_rod!.id;
  if (bot.inventory.count(rodId, null) !== 0) throw new Error("Fortress hunt must start with no rods.");
  // Finish arrangement before attaching the runtime. Otherwise its idle
  // defence can claim the body while we await the native-AI acknowledgement,
  // and the single measured hunt is refused before it ever starts.
  await releaseThreats(context);
}

/** Read the same native-combat evidence for periodic, incident and final observations. */
function fortressSnapshot(bot: Bot, runtime: Runtime, spawner: Vec3, rodId: number, started: number, phase: unknown) {
  const useFlags = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("living_entity_flags");
  return {
    ms: monotonicNow() - started,
    position: bot.entity.position.clone(),
    velocity: bot.entity.velocity.clone(),
    health: bot.health,
    food: bot.food,
    onGround: bot.entity.onGround,
    inLava: Reflect.get(bot.entity, "isInLava"),
    rods: bot.inventory.count(rodId, null),
    shield:
      bot.inventory.slots[45]?.name === "shield"
        ? {
            durabilityUsed: bot.inventory.slots[45].durabilityUsed,
            maxDurability: bot.inventory.slots[45].maxDurability,
          }
        : null,
    owner: runtime.status().activeAction?.action,
    supplies: bot.inventory
      .items()
      .filter((item) => ["cobblestone", "cooked_beef", "shield"].includes(item.name))
      .map((item) => ({ name: item.name, count: item.count, durabilityUsed: item.durabilityUsed })),
    held: bot.heldItem?.name,
    using: bot.usingHeldItem,
    useFlags: bot.entity.metadata[useFlags],
    yaw: bot.entity.yaw,
    controls: Object.fromEntries(
      (["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const).map((key) => [
        key,
        bot.getControlState(key),
      ]),
    ),
    phase,
    spawner: bot.blockAt(spawner)?.name ?? null,
    threats: Object.values(bot.entities)
      .filter((e) => e.isValid && ["blaze", "small_fireball"].includes(e.name ?? ""))
      .map((e) => ({ id: e.id, name: e.name, position: e.position.clone(), velocity: e.velocity.clone() })),
  };
}

/** Observe native fortress damage and keep every listener inside one disposable lifetime. */
function observeFortress(context: MineAiScenarioContext, runtime: Runtime, spawner: Vec3, rodId: number, started: number, died: AbortController) {
  const { bot, log } = context;
  const state = { deaths: 0, minimumHealth: bot.health, shieldBlocks: 0, fireballs: 0, phase: null as unknown };
  let ticks = 0;
  const snapshot = () => fortressSnapshot(bot, runtime, spawner, rodId, started, state.phase);
  const onDeath = () => {
    state.deaths++;
    log(`FORTRESS DEATH ${JSON.stringify(snapshot())}`);
    died.abort("fortress bot died");
  };
  const onHurt: BotEvents["entityHurt"] = (entity, source) => {
    if (entity.id === bot.entity.id) log(`FORTRESS HIT ${JSON.stringify({ ...snapshot(), source: source?.id })}`);
  };
  const onBlockUpdate: BotEvents["blockUpdate"] = (previous, current) => {
    if (previous?.position.equals(spawner) && previous.name === "spawner" && current?.name !== "spawner") {
      log(
        `FORTRESS SPAWNER LOST ${JSON.stringify({ previous: previous.name, current: current?.name, ...snapshot() })}`,
      );
    }
  };
  const onTick = () => {
    state.minimumHealth = Math.min(state.minimumHealth, bot.health);
    if (++ticks % 20 === 0) log(`FORTRESS BODY ${JSON.stringify(snapshot())}`);
  };
  const onSpawn: BotEvents["entitySpawn"] = (entity) => {
    if (entity.name === "small_fireball") state.fireballs++;
  };
  const onStatus = (packet: { entityId: number; entityStatus: number }) => {
    if (packet.entityId === bot.entity.id && packet.entityStatus === 29) state.shieldBlocks++;
  };
  const stopTrace = runtime.navigation.onEvent((event) => {
    if (["step_started", "step_phase", "step_failed", "run_settled"].includes(event.kind)) {
      state.phase = event;
      log(`FORTRESS NAV ${JSON.stringify(event)}`);
    }
  });
  bot.on("blockUpdate", onBlockUpdate);
  bot.on("death", onDeath);
  bot.on("entityHurt", onHurt);
  bot.on("physicsTick", onTick);
  bot.on("entitySpawn", onSpawn);
  bot._client.on("entity_status", onStatus);
  return { state, snapshot, close() {
    stopTrace();
    bot.off("blockUpdate", onBlockUpdate);
    bot.off("death", onDeath);
    bot.off("entityHurt", onHurt);
    bot.off("physicsTick", onTick);
    bot.off("entitySpawn", onSpawn);
    bot._client.off("entity_status", onStatus);
  } };
}

/** Delayed fire must get a full native charge and volley after the last pickup (spec D5 S8). */
async function observeLastVolley(bot: Bot, signal: AbortSignal) {
  const elapsed = serverPacedElapsed(bot);
  const end = await waitForServerPaced(bot, 100, { signal });
  return { end, ...elapsed() };
}

/**
 * Start the next action once the runner is idle (one return gets one fresh navigate) and require the server's arrival
 * answer at the fixture's starting cell for the last request. `context.signal` is the trial's abort; `died` the bot's death.
 */
async function handBackAfterHunt(context: MineAiScenarioContext, runtime: Runtime, target: Vec3, died: AbortSignal) {
  const run = await navigateWithOneReturn(
    runtime, context.bot, { x: Math.floor(target.x), y: target.y, z: Math.floor(target.z), range: 1 }, died, context.signal,
  );
  const arrived = run.kind === "completed" && run.last.result.status === "succeeded" && !context.signal.aborted
    && !died.aborted && await confirmArrival({ ...context, signal: AbortSignal.any([context.signal, died]) }, target, 2);
  return { run, arrived };
}

/** The driver supplies the task; all combat, recovery, and movement remain production actions. */
export const run: MineAiScenario = async (context) => {
  await recordSourceIdentity();
  const { bot, log } = context;
  const collection = collectionSchema.parse(context.scenario.params ?? {});
  const spawner = new Vec3(-28, 82, 357);
  const died = new AbortController();
  const signal = AbortSignal.any([context.signal, died.signal]);
  await prepareFortress(context, spawner);
  const rodId = bot.registry.itemsByName.blaze_rod!.id;
  const started = monotonicNow();
  const startAge = bot.time?.age ?? null;
  if (startAge === null) return { status: "failed", detail: "Fortress setup failed: no world age heard" };
  const runtime = await openRuntime(context, "fortress-twelve-rods");
  const observation = observeFortress(context, runtime, spawner, rodId, started, died);
  const { state, snapshot } = observation;
  const attempts: unknown[] = [];
  try {
    using progress = declareFortressProgress(runtime.asyncActions, bot, context.progress, signal);
    const result = await runFortressHunt(
      runtime, bot,
      { mob_name: "blaze", drop_name: "blaze_rod", count: collection.drops, observe_for_ms: collection.observe_for_ms, camp_spawner: collection.camp_spawner },
      progress, signal,
    );
    attempts.push(result);
    log(`FORTRESS HUNT ${JSON.stringify(result)}`);
    const volley = bot.inventory.count(rodId, null) >= collection.drops ? await observeLastVolley(bot, signal) : null;
    const gained = bot.inventory.count(rodId, null);
    const rate = judgeDrops({ gained, requested: collection.drops, startAge, endAge: bot.time?.age ?? null,
      minimumPerMinute: collection.minimumDropsPerMinute ?? 0 });
    const quotaMet = rate.passed && volley?.end === "ticks";
    const handBack = !quotaMet && !signal.aborted && bot.health > 0 && isSafeHuntRefusal(result.result)
      ? await handBackAfterHunt(context, runtime, new Vec3(...collection.handBack), died.signal) : null;
    const reflexCounts = await reportReflexOutcomes(context, runtime);
    const judgement = judgeFortressHunt({ alive: state.deaths === 0 && bot.health > 0, quotaMet, hunt: result.result, handBack });

    return {
      status: judgement.outcome ? "succeeded" : "failed",
      detail: JSON.stringify({
        ...judgement,
        collection,
        elapsedMs: monotonicNow() - started,
        elapsedTicks: rate.elapsedTicks,
        dropsPerMinute: rate.dropsPerMinute,
        rateFailure: rate.reason,
        volley,
        huntSucceeded: result.result.status === "succeeded",
        handBack,
        deaths: state.deaths,
        minimumHealth: state.minimumHealth,
        shieldBlocks: state.shieldBlocks,
        fireballs: state.fireballs,
        ...reflexCounts,
        final: snapshot(),
        attempts,
      }),
    };
  } catch (cause) {
    if (!died.signal.aborted) throw cause;
    return {
      status: "failed",
      detail: JSON.stringify({ outcome: null, reason: "The bot did not survive.", deaths: state.deaths, minimumHealth: state.minimumHealth, shieldBlocks: state.shieldBlocks,
        fireballs: state.fireballs, final: snapshot(), attempts }),
    };
  } finally {
    log(`FORTRESS FINAL ${JSON.stringify({ deaths: state.deaths, minimumHealth: state.minimumHealth,
      shieldBlocks: state.shieldBlocks, fireballs: state.fireballs, final: snapshot() })}`);
    observation.close();
    await runtime.close();
  }
};

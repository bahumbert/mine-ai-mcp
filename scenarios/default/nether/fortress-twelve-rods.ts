import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
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
import { releaseThreats } from "./fortress-common.ts";
import { readReflexOutcomes } from "../../flat/combat/reflex.ts";
import { z } from "zod";
import { recordSourceIdentity } from "../../src/source-identity.ts";
import { judgeDrops } from "../../src/game-rate.ts";
import { waitForServerPaced } from "../../../src/world/server-paced.ts";

const collectionSchema = z.strictObject({
  drops: z.number().int().positive().default(12),
  minimumDropsPerMinute: z.number().positive().optional(),
  camp_spawner: z.boolean().default(false),
  observe_for_ms: z.number().int().positive().default(720_000),
});

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
  const started = monotonicNow();
  const startAge = bot.time?.age ?? null;
  const end = await waitForServerPaced(bot, 100, { signal });
  return { end, elapsedMs: monotonicNow() - started,
    elapsedTicks: startAge === null || bot.time?.age == null ? null : bot.time.age - startAge };
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
    const hunt = runtime.actions.find((a) => a.name === "collect_mob_drop")!;
    const result = await runtime.run(
      hunt,
      { mob_name: "blaze", drop_name: "blaze_rod", count: collection.drops, observe_for_ms: collection.observe_for_ms, camp_spawner: collection.camp_spawner },
      signal,
    );
    attempts.push(result);
    log(`FORTRESS HUNT ${JSON.stringify(result)}`);
    const volley = bot.inventory.count(rodId, null) >= collection.drops ? await observeLastVolley(bot, signal) : null;
    const reflexCounts = await reportReflexOutcomes(context, runtime);
    const elapsedMs = monotonicNow() - started;
    const gained = bot.inventory.count(rodId, null);
    const rate = judgeDrops({ gained, requested: collection.drops, startAge, endAge: bot.time?.age ?? null,
      minimumPerMinute: collection.minimumDropsPerMinute ?? 0 });

    return {
      status:
        state.deaths === 0 &&
        bot.health > 0 &&
        rate.passed && volley?.end === "ticks"
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({
        collection,
        elapsedMs,
        elapsedTicks: rate.elapsedTicks,
        dropsPerMinute: rate.dropsPerMinute,
        rateFailure: rate.reason,
        volley,
        huntSucceeded: result.result.status === "succeeded",
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
      detail: JSON.stringify({ deaths: state.deaths, minimumHealth: state.minimumHealth, shieldBlocks: state.shieldBlocks,
        fireballs: state.fireballs, final: snapshot(), attempts }),
    };
  } finally {
    log(`FORTRESS FINAL ${JSON.stringify({ deaths: state.deaths, minimumHealth: state.minimumHealth,
      shieldBlocks: state.shieldBlocks, fireballs: state.fireballs, final: snapshot() })}`);
    observation.close();
    await runtime.close();
  }
};

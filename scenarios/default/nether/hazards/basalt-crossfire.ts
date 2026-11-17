import { monotonicNow } from "../../../../src/utils/monotonic-clock.ts";
import type { BotEvents } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { z } from "zod";
import { observeIdleWindow } from "../../../flat/combat/idle-reflex-window.ts";
import { readReflexOutcomes } from "../../../flat/combat/reflex.ts";
import { declaredEntitiesArranged, openRuntime, standStill, wearArmor } from "../../../src/runtime.ts";
import type { MineAiScenario } from "../../../src/scenario-client.ts";
import { observe } from "./pit.ts";
import { isAngry } from "./observe.ts";
import { judgeTraverse } from "./basalt-judge.ts";

const paramsSchema = z.strictObject({
  trial: z.enum(["traverse", "wounded_gaze"]).default("traverse"),
});

type Bot = Parameters<MineAiScenario>[0]["bot"];
type Runtime = Awaited<ReturnType<typeof openRuntime>>;

/** Independent inspection of the full two-high shell, cap, floor, and standing body. */
function enclosed(bot: Bot): boolean {
  const feet = bot.entity.position.floored();
  const shell = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
    .flatMap((side) => [feet.plus(side), feet.plus(side).offset(0, 1, 0)])
    .concat(feet.offset(0, 2, 0), feet.offset(0, -1, 0));
  return (
    bot.entity.onGround &&
    shell.every((p) => bot.blockAt(p)?.boundingBox === "block") &&
    [feet, feet.offset(0, 1, 0)].every((p) => bot.blockAt(p)?.boundingBox === "empty")
  );
}

/** Hold the bot for `ticks` server ticks, sampling its shelter on each body tick; the listener lives only inside the window. */
async function observeShelter(bot: Bot, ticks: number, signal: AbortSignal) {
  const counts = { samples: 0, coveredSamples: 0 };
  const onTick = () => {
    counts.samples++;
    if (enclosed(bot)) counts.coveredSamples++;
  };
  bot.on("physicsTick", onTick);
  try {
    const { observedTicks } = await observeIdleWindow(bot, ticks, () => false, signal);
    return { observedTicks, ...counts };
  } finally {
    bot.off("physicsTick", onTick);
  }
}

/** Check the built arena, arrange the declared mobs and settle the bot; a wounded gaze provokes the enderman and returns its id. */
async function prepareBasaltStart(context: Parameters<MineAiScenario>[0], trial: "traverse" | "wounded_gaze") {
  const { bot } = context;
  await bot.waitForChunksToLoad();
  if (bot.blockAt(new Vec3(36, 100, 0))?.name !== "emerald_block")
    throw new Error("The declared basalt arena is not built around the start.");
  await declaredEntitiesArranged(context);
  if (!(await standStill(context))) throw new Error("Could not settle on the basalt start.");
  await wearArmor(context);
  if (trial !== "wounded_gaze") return null;
  const target = Object.values(bot.entities).find((e) => e.name === "enderman")!;
  bot.chat(`/data merge entity @e[type=minecraft:enderman,limit=1] {NoAI:0b}`);
  await bot.lookAt(target.position.offset(0, 2.6, 0), true);
  await observe(bot, () => isAngry(bot, target), "native enderman provoked by gaze");
  return target.id;
}

/** What the trial's listeners saw: written by `trackCrossfire`, read by the verdict and the trace. */
interface CrossfireState {
  deaths: number;
  minimumHealth: number;
  inLava: boolean;
  onMagma: boolean;
  endermanAttackedFirst: boolean;
  readonly seen: Set<string>;
  readonly damage: unknown[];
  readonly samples: unknown[];
}

/** Listen through the trial (deaths, health, lava and magma, the first enderman strike, mobs in view, damage, a sample per second); `stop` removes every listener. */
function trackCrossfire(
  bot: Bot,
  runtime: Runtime,
  provokedId: number | null,
  started: number,
): { state: CrossfireState; stop(): void } {
  const state: CrossfireState = {
    deaths: 0,
    minimumHealth: bot.health,
    inLava: false,
    onMagma: false,
    endermanAttackedFirst: false,
    seen: new Set<string>(),
    damage: [],
    samples: [],
  };
  const attackers = new Set<number>();
  let lastSample = 0;
  const health = () => {
    state.minimumHealth = Math.min(state.minimumHealth, bot.health);
  };
  const death = () => {
    state.deaths++;
  };
  const hurt: BotEvents["entityHurt"] = (entity, source) => {
    if (entity.id === bot.entity.id && source) attackers.add(source.id);
    if (
      entity.name === "enderman" &&
      source?.id === bot.entity.id &&
      entity.id !== provokedId &&
      !attackers.has(entity.id)
    )
      state.endermanAttackedFirst = true;
    state.damage.push({
      ms: monotonicNow() - started,
      target: entity.name,
      id: entity.id,
      source: source?.name,
      sourceId: source?.id,
      position: entity.position.clone(),
      owner: runtime.status().activeAction?.action,
    });
  };
  const tick = () => {
    const position = bot.entity.position;
    state.inLava ||= Reflect.get(bot.entity, "isInLava") === true;
    state.onMagma ||= bot.entity.onGround && bot.blockAt(position.offset(0, -0.1, 0))?.name === "magma_block";
    for (const e of Object.values(bot.entities))
      if (e.isValid && e.position.distanceTo(position) < 32 && e.name) state.seen.add(e.name);
    if (monotonicNow() - lastSample < 1000) return;
    lastSample = monotonicNow();
    state.samples.push({
      ms: monotonicNow() - started,
      position: position.clone(),
      health: bot.health,
      owner: runtime.status().activeAction?.action,
      inLava: Reflect.get(bot.entity, "isInLava"),
      mobs: Object.values(bot.entities)
        .filter((e) => ["magma_cube", "enderman", "ghast", "fireball"].includes(e.name ?? ""))
        .map((e) => ({ id: e.id, name: e.name, position: e.position.clone() })),
    });
  };
  bot.on("health", health);
  bot.on("death", death);
  bot.on("entityHurt", hurt);
  bot.on("physicsTick", tick);
  return {
    state,
    stop: () => {
      bot.off("health", health);
      bot.off("death", death);
      bot.off("entityHurt", hurt);
      bot.off("physicsTick", tick);
    },
  };
}

/** The declared ghast's `is_charging` flag, watched from before the NoAI release: `latchedAge` is the server age of the first update that sets it. */
interface GhastCharge {
  readonly ghast: Entity;
  latchedAge: number | null;
  readonly samples: { age: number | null; dy: number; distance: number }[];
  stop(): void;
}

/**
 * Server ticks a ghast may take to charge after the NoAI release: 2 x the worst charge measured (260 ticks at 10 tps,
 * t00067 of the a7 T4 proof), rounded up to 20. Measured over 40 runs at both rates before the bound: 0-40 ticks at
 * 20 tps (36 runs), 0-36 at 10 tps (13 runs), 260 at 10 tps (one run); censored: one 10 tps run that did not charge
 * within 80 ticks (t00047, dy 4.65-4.70 outside the band). After the spawn moved to y 101: 10 tps 10 runs (0-40),
 * 20 tps 5 runs (0-40), no run over 260, so the bound is unchanged. A run that reaches the bound fails with its own text.
 */
const GHAST_CHARGE_TICKS = 520;

/** Arm the charge watch before the release: a ghast that charges is seen by its update, or already charging at arming. */
function watchGhastCharge(bot: Bot): GhastCharge {
  const ghast = Object.values(bot.entities).find((entity) => entity.name === "ghast");
  if (!ghast) throw new Error("The declared ghast is not in the basalt arena.");
  const index = bot.registry.entitiesByName.ghast?.metadataKeys?.indexOf("is_charging") ?? -1;
  if (index < 0) throw new Error("minecraft-data has no is_charging metadata key for the ghast.");
  const charging = (entity: Entity) => {
    const value: unknown = entity.metadata[index];
    return value === true;
  };
  const onUpdate: BotEvents["entityUpdate"] = (entity) => {
    if (entity.id === ghast.id && watch.latchedAge === null && charging(entity)) watch.latchedAge = bot.time.age;
  };
  // Time packets come every 20 server ticks: one sample per 20 ticks of the wait, for a trial that never charges.
  const onTime: BotEvents["time"] = () => {
    const distance = bot.entity.position.distanceTo(ghast.position);
    watch.samples.push({ age: bot.time.age, dy: Math.abs(ghast.position.y - bot.entity.position.y), distance });
  };
  const watch: GhastCharge = {
    ghast,
    latchedAge: charging(ghast) ? bot.time.age : null,
    samples: [],
    stop: () => {
      bot.off("entityUpdate", onUpdate);
      bot.off("time", onTime);
    },
  };
  bot.on("entityUpdate", onUpdate);
  bot.on("time", onTime);
  return watch;
}

/** Wait for the watched ghast to charge: its ticks from the release, or the failure text when the bound passes first. */
async function awaitGhastCharge(
  bot: Bot,
  watch: GhastCharge,
  releaseAge: number | null,
  signal: AbortSignal,
  log: Parameters<MineAiScenario>[0]["log"],
): Promise<{ chargeTicks: number | null } | { failure: string }> {
  await observeIdleWindow(bot, GHAST_CHARGE_TICKS, () => watch.latchedAge !== null, signal);
  if (watch.latchedAge === null) {
    const dy = Math.abs(watch.ghast.position.y - bot.entity.position.y);
    const distance = bot.entity.position.distanceTo(watch.ghast.position);
    return {
      failure: JSON.stringify({
        error: `ghast did not charge within ${GHAST_CHARGE_TICKS} server ticks (dy ${dy.toFixed(1)}, distance ${distance.toFixed(1)})`,
        chargeSamples: watch.samples,
      }),
    };
  }
  const chargeTicks = releaseAge === null ? null : Math.max(0, watch.latchedAge - releaseAge);
  log(`Ghast charge latched at server age ${watch.latchedAge}: chargeTicks ${chargeTicks}`);
  return { chargeTicks };
}

export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const provokedId = await prepareBasaltStart(context, params.trial);
  const started = monotonicNow();
  const runtime = await openRuntime(context, "basalt-crossfire");
  const stopNavigation = runtime.navigation.onEvent((event) => {
    if (["search_started", "step_started", "step_completed", "step_failed", "run_settled"].includes(event.kind))
      log(`Crossfire navigation: ${JSON.stringify(event)}`);
  });
  const track = trackCrossfire(bot, runtime, provokedId, started);
  const { state } = track;
  let charge: GhastCharge | null = null;
  try {
    // The traverse waits for the ghast to charge before the walk: the watch is armed before the release, which is logged after it.
    charge = params.trial === "traverse" ? watchGhastCharge(bot) : null;
    if (charge) log(`Ghast charge watch armed at server age ${bot.time.age}`);
    const releaseAge = bot.time.age;
    bot.chat("/execute as @e[type=!minecraft:player,distance=..40] run data merge entity @s {NoAI:0b}");
    log(`Ghast release sent at server age ${releaseAge}`);
    const charged = charge ? await awaitGhastCharge(bot, charge, releaseAge, signal, log) : { chargeTicks: null };
    if ("failure" in charged) return { status: "failed", detail: charged.failure };
    const action = runtime.actions.find((a) => a.name === "navigate")!;
    const travel = await runtime.run(action, { x: 36, y: 101, z: 0, range: 1 }, signal);
    const positionAtWalkEnd = bot.entity.position.clone();
    // Observe damage after arrival or handoff, and independently verify a claimed shelter.
    // The shelter is sampled on each body tick of the 40-server-tick window, not on client ticks.
    const shelter = await observeShelter(bot, 40, signal);
    const reflex = await readReflexOutcomes(context, runtime);
    const positionAfterWindow = bot.entity.position.clone();
    const handoff = reflex.encounters.findLast((response) => response.interrupted?.action === "navigate");
    const required =
      params.trial === "wounded_gaze"
        ? ["magma_cube", "enderman", "ghast"]
        : ["magma_cube", "enderman", "ghast", "fireball"];
    const exercised = required.every((name) => state.seen.has(name));
    const { arrived, finalDistance, outcome, sheltered, blastHandoff, passed } = judgeTraverse({
      travel, positionAtWalkEnd, positionAfterWindow, handoff, shelter, state, exercised,
      health: bot.health, onGround: bot.entity.onGround, dimension: bot.game.dimension,
    });
    return {
      status: passed ? "succeeded" : "failed",
      detail: JSON.stringify({
        arrived,
        finalDistance,
        outcome,
        chargeTicks: charged.chargeTicks,
        sheltered,
        blastHandoff,
        ...shelter,
        interruptions: travel.interruptions ?? [],
        returnError: "error" in travel.result ? travel.result.error : null,
        exercised,
        deaths: state.deaths,
        minimumHealth: state.minimumHealth,
        inLava: state.inLava,
        onMagma: state.onMagma,
        endermanAttackedFirst: state.endermanAttackedFirst,
        seen: [...state.seen],
        travel,
        encounters: reflex.encounters,
        reflexLimits: reflex.limits.length,
        reflexFailures: reflex.failures.length,
      }),
    };
  } finally {
    log(`Crossfire trace: ${JSON.stringify({ samples: state.samples, damage: state.damage })}`);
    stopNavigation();
    charge?.stop();
    track.stop();
    await runtime.close();
  }
};

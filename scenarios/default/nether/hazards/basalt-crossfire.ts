import { monotonicNow } from "../../../../src/utils/monotonic-clock.ts";
import type { BotEvents } from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";
import { observeIdleWindow } from "../../../flat/combat/idle-reflex-window.ts";
import { readReflexOutcomes } from "../../../flat/combat/reflex.ts";
import { declaredEntitiesArranged, openRuntime, standStill, wearArmor } from "../../../src/runtime.ts";
import type { MineAiScenario, MineAiScenarioContext } from "../../../src/scenario-client.ts";
import { observe } from "./pit.ts";
import { isAngry } from "./observe.ts";
import { judgeTraverse } from "./basalt-judge.ts";
import { awaitGhastCharge, watchGhastCharge } from "./basalt-charge.ts";

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

/** The native charge is the server's answer to the isolated ghast release. */
async function releaseBasaltGhast({ bot, signal, log }: MineAiScenarioContext) {
  signal.throwIfAborted();
  const watch = watchGhastCharge(bot);
  try {
    if (!watch.ghast.uuid) throw new Error("The declared ghast has no UUID.");
    const ghastReleaseAge = bot.time.age;
    bot.chat(`/data merge entity ${watch.ghast.uuid} {NoAI:0b}`);
    log(`Ghast release sent at server age ${ghastReleaseAge}`);
    const charged = await awaitGhastCharge(bot, watch, ghastReleaseAge, signal, log);
    const chargeAge = watch.end?.kind === "charged" ? watch.end.age : null;
    return { ...charged, ghastReleaseAge, chargeAge };
  } finally {
    watch.stop();
  }
}

/** Arm before release and retain only a fireball spawned while the navigate request is pending. */
function watchWalkFireball(bot: Bot) {
  const watch = {
    walking: false,
    id: null as number | null,
    [Symbol.dispose]: () => { bot.off("entitySpawn", spawn); },
  };
  const spawn: BotEvents["entitySpawn"] = (entity) => {
    if (watch.walking && entity.name === "fireball") watch.id ??= entity.id;
  };
  bot.on("entitySpawn", spawn);
  return watch;
}

/** Open the shot window for the navigate request, including any interruption it resumes from. */
async function walkBasalt(runtime: Runtime, shot: ReturnType<typeof watchWalkFireball>, signal: AbortSignal) {
  const action = runtime.actions.find((candidate) => candidate.name === "navigate")!;
  shot.walking = true;
  try {
    return await runtime.run(action, { x: 36, y: 101, z: 0, range: 1 }, signal);
  } finally {
    shot.walking = false;
  }
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
  try {
    using shot = watchWalkFireball(bot);
    // The melee control inherits the traverse params but declares no bow.
    const player = context.scenario.players.find(({ name }) => name === bot.username);
    const stagedRelease = params.trial === "traverse" && player?.inventory?.some(({ item }) => item === "bow") === true;
    const charged = stagedRelease ? await releaseBasaltGhast(context) : {
      chargeTicks: null, chargeAge: null, ghastReleaseAge: null,
    };
    if ("failure" in charged) return { status: "failed", detail: charged.failure };
    signal.throwIfAborted();
    const otherReleaseAge = bot.time.age;
    const alreadyReleased = stagedRelease ? ",type=!minecraft:ghast" : "";
    bot.chat(`/execute as @e[type=!minecraft:player${alreadyReleased},distance=..40] run data merge entity @s {NoAI:0b}`);
    log(`Basalt mob release sent at server age ${otherReleaseAge}`);
    const travel = await walkBasalt(runtime, shot, signal);
    const positionAtWalkEnd = bot.entity.position.clone();
    // Observe damage after arrival or handoff, and independently verify a claimed shelter.
    // The shelter is sampled on each body tick of the 40-server-tick window, not on client ticks.
    const shelter = await observeShelter(bot, 40, signal);
    const reflex = await readReflexOutcomes(context, runtime);
    const positionAfterWindow = bot.entity.position.clone();
    const handoff = reflex.encounters.findLast((response) => response.interrupted?.action === "navigate");
    const required =
      params.trial === "traverse" && !stagedRelease
        ? ["magma_cube", "enderman", "ghast", "fireball"]
        : ["magma_cube", "enderman", "ghast"];
    const exercised = required.every((name) => state.seen.has(name)) &&
      (!stagedRelease || shot.id !== null);
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
        ...charged,
        otherReleaseAge,
        walkFireballId: shot.id,
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
    track.stop();
    await runtime.close();
  }
};

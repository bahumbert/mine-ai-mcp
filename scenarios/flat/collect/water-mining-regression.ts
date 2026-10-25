import { Vec3 } from "vec3";
import { SqlBotData } from "../../../src/bot-data/index.ts";
import { createMovements } from "../../../src/navigation/index.ts";
import { createMinecraftRuntime } from "../../../src/runtime/minecraft-runtime.ts";
import { ActionRunner } from "../../../src/session/action-runner.ts";
import { attachIdleWaterControl } from "../../../src/survival/baseline/idle-water.ts";
import { ReflexDriver } from "../../../src/survival/control/driver.ts";
import { isBurning, isInLava } from "../../../src/survival/perception/body.ts";
import { attachBreathReflex } from "../../../src/survival/reflexes/breath.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

type ScenarioContext = Parameters<MineAiScenario>[0];
type ScenarioResult = Awaited<ReturnType<MineAiScenario>>;
type MinecraftRuntime = Awaited<ReturnType<typeof createMinecraftRuntime>>;

const OBSIDIAN_ONE = { block_name: "obsidian", count: 1, scaffold: false };
/** The next action from the water after the lava-escape scenario: east over the bank, 4 blocks past the water. */
const WALK_EAST_FROM_WATER = { x: 6, y: -59, z: 0, range: 0 };

function findCollectBlockAction(runtime: MinecraftRuntime) {
  const collect = runtime.actions.find((action) => action.name === "collect_block");
  if (!collect) throw new Error("Collect action missing");
  return collect;
}

function findNavigateAction(runtime: MinecraftRuntime) {
  const navigate = runtime.actions.find((action) => action.name === "navigate");
  if (!navigate) throw new Error("Navigate action missing");
  return navigate;
}

function countObsidian(bot: ScenarioContext["bot"]): number {
  return bot.inventory
    .items()
    .filter((item) => item.name === "obsidian")
    .reduce((sum, item) => sum + item.count, 0);
}

/** Water arrives during a long obsidian dig; cancelling must stop the pickaxe and keep the idle stance. */
async function runCancelDuringSubmergedDig(context: ScenarioContext): Promise<ScenarioResult> {
  const { bot, signal } = context;
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "current-cancel", scope: { kind: "bot", botId: bot.username } },
  });
  const runner = new ActionRunner();
  // The physical primitive owns the body until cancellation settles. The
  // idle water controller takes over at that exact boundary.
  let digging = true;
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, runner));
  resources.use(attachBreathReflex(bot, driver));
  resources.use(
    attachIdleWaterControl(
      bot,
      {
        get active() {
          return digging;
        },
        get steering() {
          return digging;
        },
      },
      runner,
    ),
  );
  const stop = new AbortController();
  let digTicks = 0;
  const tick = () => {
    // The dig is admitted while dry; native flow then reaches it. A caller
    // must not bypass liquid safety just to arrange the cancellation test.
    if (bot.targetDigBlock && digTicks === 0) bot.chat("/setblock 0 -59 0 water");
    if (bot.targetDigBlock && ++digTicks === 20) stop.abort("Scenario cancellation during a submerged obsidian dig");
  };
  bot.on("physicsTick", tick);
  const start = bot.entity.position.clone();
  try {
    await context.navigation
      .breakBlockInPlace({
        movements: createMovements(bot),
        position: { x: 2, y: -59, z: 1 },
        signal: AbortSignal.any([signal, stop.signal]),
      })
      .catch((error) => {
        if (!stop.signal.aborted) throw error;
      });
    digging = false;
    const cancelledAt = bot.entity.position.clone();
    await bot.waitForTicks(80);
    const drift = Math.hypot(cancelledAt.x - bot.entity.position.x, cancelledAt.z - bot.entity.position.z);
    return {
      status: stop.signal.aborted && !bot.targetDigBlock && drift < 0.3 && bot.health === 20 ? "succeeded" : "failed",
      detail: JSON.stringify({
        digTicks,
        horizontalDrift: drift,
        verticalRise: bot.entity.position.y - cancelledAt.y,
        displacement: start.distanceTo(bot.entity.position),
        health: bot.health,
        target: bot.targetDigBlock?.name,
      }),
    };
  } finally {
    bot.off("physicsTick", tick);
    data.close();
  }
}

/** The dig must start this soon after the action starts: alone it starts 0.3 s in, the rest is the walk to the block. */
const DIG_START_MS = 10_000;
/** From the lava to out of it and not burning: lava-escape-step's bound for the same escape. */
const ESCAPE_MS = 5_000;
/**
 * From the escape to the obsidian breaking again: 14.1-15.1 s in 15 runs alone (the lava wait 3 s, 4 s idle before the
 * next route, a 9.4 s dig). 30 s because on a server shared with other runs 4 of 5 took over 20 s.
 */
const RESUMED_BREAK_MS = 30_000;
/** After the break: time for the pickup to end the action on its own, before the scenario stops it. */
const SETTLE_MS = 5_000;
/** The obsidian block the dig breaks. */
const OBSIDIAN_CELL = new Vec3(0, -59, -1);

/**
 * Resolves true when `done()` holds on a physics tick, false when `boundMs` of wall clock pass (also when ticks have
 * stopped) or the bot dies; rejects when `signal` aborts. Its listeners and timer are gone when it settles.
 */
function waitTicksUntil(
  bot: ScenarioContext["bot"],
  done: () => boolean,
  boundMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      bot.off("physicsTick", check);
      bot.off("death", dead);
      signal.removeEventListener("abort", aborted);
      finish();
    };
    const check = () => {
      if (done()) settle(() => resolve(true));
    };
    const dead = () => settle(() => resolve(false));
    const aborted = () => settle(() => reject(signal.reason));
    bot.on("physicsTick", check);
    bot.once("death", dead);
    signal.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(() => settle(() => resolve(done())), boundMs);
    if (signal.aborted) aborted();
    else if (done()) settle(() => resolve(true));
  });
}

/**
 * Lava appears under the bot during an obsidian dig: the reflex must get it out within `ESCAPE_MS`, and the resumed
 * dig must break the obsidian within `RESUMED_BREAK_MS` of that. The pickup is reported, not asserted: the collect is
 * stopped when it has not ended `SETTLE_MS` after the break (with `burnDrop` the drop is killed at the break, which
 * is what lava does to it now and then).
 */
async function runLavaInterruptsDig(
  context: ScenarioContext,
  runtime: MinecraftRuntime,
  { burnDrop }: { burnDrop: boolean },
): Promise<ScenarioResult> {
  const { bot, signal } = context;
  const stopMining = new AbortController();
  const mining = runtime.run(findCollectBlockAction(runtime), OBSIDIAN_ONE, AbortSignal.any([signal, stopMining.signal]));
  const miningEnd = mining.then(
    (outcome) => ({ outcome }),
    (error: unknown) => ({ error: String(error) }),
  );
  let broken = false;
  const onBlockUpdate = (_before: unknown, after: { position: Vec3; name: string } | null) => {
    if (broken || !after?.position.equals(OBSIDIAN_CELL) || after.name !== "air") return;
    broken = true;
    if (burnDrop) bot.chat("/kill @e[type=item]");
  };
  bot.on("blockUpdate", onBlockUpdate);
  const facts = { injected: false, sawLava: false, escapedMs: null as number | null, resumedBreakMs: null as number | null };
  const fail = async (why: string): Promise<ScenarioResult> => {
    stopMining.abort();
    return { status: "failed", detail: JSON.stringify({ why, ...facts, health: bot.health, mining: await miningEnd }) };
  };
  try {
    const dug = await waitTicksUntil(
      bot,
      () => {
        if (!bot.targetDigBlock) return false;
        bot.chat("/setblock 0 -60 0 lava");
        return true;
      },
      DIG_START_MS,
      signal,
    );
    facts.injected = dug;
    if (!dug) return await fail("the dig never started");
    const lavaAt = performance.now();
    let calm = 0;
    const out = await waitTicksUntil(
      bot,
      () => {
        facts.sawLava ||= isInLava(bot);
        calm = facts.sawLava && !isInLava(bot) && !isBurning(bot) ? calm + 1 : 0;
        return calm >= 10;
      },
      ESCAPE_MS,
      signal,
    );
    if (!out) return await fail("the bot was not out of the lava and the fire in time");
    const escapedAt = performance.now();
    facts.escapedMs = Math.round(escapedAt - lavaAt);
    const resumed = await waitTicksUntil(bot, () => broken, RESUMED_BREAK_MS, signal);
    if (!resumed) return await fail("the resumed dig did not break the obsidian in time");
    facts.resumedBreakMs = Math.round(performance.now() - escapedAt);
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const unsettled = new Promise<"unsettled">((resolve) => (settleTimer = setTimeout(() => resolve("unsettled"), SETTLE_MS)));
    if ((await Promise.race([miningEnd, unsettled])) === "unsettled") stopMining.abort();
    clearTimeout(settleTimer);
    const mined = await miningEnd;
    return {
      status: bot.health > 0 && !bot.targetDigBlock ? "succeeded" : "failed",
      detail: JSON.stringify({ ...facts, health: bot.health, position: bot.entity.position, mining: mined }),
    };
  } finally {
    bot.off("blockUpdate", onBlockUpdate);
    stopMining.abort();
    await miningEnd;
  }
}

/** Lava reaches the bot (placed beside it); it must get out, stop burning and then walk on from the water. */
async function runLavaEscape(context: ScenarioContext, runtime: MinecraftRuntime): Promise<ScenarioResult> {
  const { bot, signal } = context;
  let sawLava = false;
  let escaped = 0;
  for (let tick = 0; tick < 200 && bot.health > 0; tick++) {
    signal.throwIfAborted();
    sawLava ||= isInLava(bot);
    escaped = sawLava && !isInLava(bot) && !isBurning(bot) ? escaped + 1 : 0;
    if (escaped >= 10) break;
    await bot.waitForTicks(1);
  }
  // The body is left in the water, so the next action starts from there and must finish.
  const walked =
    escaped >= 10 && bot.health > 0 ? await runtime.run(findNavigateAction(runtime), WALK_EAST_FROM_WATER, signal) : null;
  return {
    status: sawLava && escaped >= 10 && bot.health > 0 && !bot.targetDigBlock && walked?.result.status === "succeeded" ? "succeeded" : "failed",
    detail: JSON.stringify({
      sawLava,
      escaped,
      health: bot.health,
      position: bot.entity.position,
      lava: isInLava(bot),
      burning: isBurning(bot),
      walked: walked?.result,
    }),
  };
}

/** Mines one obsidian next to water (modes water, scoop, drain) and checks the bot ends unhurt with the block. */
async function runObsidianMiningBesideWater(
  context: ScenarioContext,
  runtime: MinecraftRuntime,
  mode: unknown,
): Promise<ScenarioResult> {
  const { bot, signal } = context;
  let wetDig = false;
  let dug = false;
  const tick = () => {
    if (bot.targetDigBlock?.name !== "obsidian") return;
    dug = true;
    wetDig ||= Reflect.get(bot.entity, "isInWater") === true || bot.blockAt(new Vec3(2, -59, 0))?.name === "water";
  };
  bot.on("physicsTick", tick);
  try {
    const result = await runtime.run(findCollectBlockAction(runtime), OBSIDIAN_ONE, signal);
    const count = countObsidian(bot);
    const recovered = mode !== "scoop" || bot.inventory.items().some((item) => item.name === "water_bucket");
    return {
      status: result.result.status === "succeeded" && count >= 1 && bot.health === 20 ? "succeeded" : "failed",
      detail: JSON.stringify({ result: result.result, dug, wetDig, recovered, count, health: bot.health }),
    };
  } finally {
    bot.off("physicsTick", tick);
  }
}

export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  await bot.waitForChunksToLoad();
  const mode = context.scenario.params.mode;
  if (mode === "cancel") return runCancelDuringSubmergedDig(context);
  await using runtime = await createMinecraftRuntime(bot, {
    botData: {
      storage: { kind: "temporary" },
      identity: { worldId: `water-mining-${mode}`, scope: { kind: "bot", botId: bot.username } },
    },
  });
  // `return await`: the runtime must stay open until the scenario body settles.
  if (mode === "lava") return await runLavaEscape(context, runtime);
  if (mode === "lava-dig")
    return await runLavaInterruptsDig(context, runtime, { burnDrop: context.scenario.params.drop === "burns" });
  return await runObsidianMiningBesideWater(context, runtime, mode);
};

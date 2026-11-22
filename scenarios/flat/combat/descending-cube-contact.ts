import type { ClientCompletion } from "mine-labs/client";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { createCombatController } from "../../../src/survival/control/combat/controller.ts";
import type { CombatOutcome } from "../../../src/survival/control/combat/contract.ts";
import { meleeDistance } from "../../../src/survival/weapons/melee.ts";
import { SERVER_ANSWER_TICKS } from "../../../src/world/world-age.ts";
import { waitServerTicks } from "../../../tests/minecraft/drivers/server-ticks.ts";
import { openRuntime, standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

type Combat = ReturnType<typeof createCombatController>;
/** The engagement's end: its outcome, or `threw` when `engage` rejected (kept out of an unhandled rejection). */
type EngagementEnd = CombatOutcome | { readonly kind: "threw"; readonly attacks: 0; readonly error: string };

/** Server ticks the recorded contact is held before the cube is released: the cached world age moves 40, a true span of 21 to 40 (the cache is up to 19 ticks stale). */
const PAUSE_TICKS = 20;
/** The YAML's `goal.timeout` (45 s) in server ticks: the goal's clock is game time. */
const GOAL_TICKS = 900;

/** Count the client physics ticks the bot holds its shield on the cube, and the hurts it takes, until `stop`. */
function watchContact(bot: Bot, combat: Combat, cube: Entity) {
  let guarded = 0;
  let hurt = 0;
  const flagsIndex = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("living_entity_flags");
  const tick = () => {
    const flags = bot.entity.metadata[flagsIndex];
    if (
      combat.activeEngagement()?.targetId === cube.id &&
      meleeDistance(bot, cube) > 3 &&
      typeof flags === "number" &&
      (flags & 3) === 3
    )
      guarded++;
  };
  const onHurt = (entity: Entity) => {
    if (entity.id === bot.entity.id) hurt++;
  };
  bot.on("physicsTick", tick);
  bot.on("entityHurt", onHurt);
  return {
    guarded: () => guarded,
    hurt: () => hurt,
    stop: () => {
      bot.off("physicsTick", tick);
      bot.off("entityHurt", onHurt);
    },
  };
}

/** Stop the engagement and report how it ended: a fight still live is cancelled, never left running. */
async function finishRun(
  stop: AbortController,
  engagement: Promise<EngagementEnd>,
  status: "succeeded" | "failed",
  fields: Record<string, unknown>,
): Promise<ClientCompletion> {
  stop.abort();
  const outcome = await engagement;
  return {
    status,
    detail: JSON.stringify({
      ...fields,
      engagement: outcome.kind,
      attacks: outcome.attacks,
      ...("error" in outcome ? { error: outcome.error } : {}),
    }),
  };
}

/** Pause the recorded airborne contact, then let the native cube descend and fight. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  await standStill(context);
  await wearArmor(context);
  // The pack death began with the large cube six blocks overhead, horizontally
  // in contact. Pausing that pose isolates admission from server packet timing.
  bot.chat('/summon magma_cube -1.9 -53.9 3.4 {Size:3,NoAI:1b,NoGravity:1b,Tags:["descending_probe"]}');
  const summoned = (entity: { name?: string }) => entity.name === "magma_cube";
  const seen = await waitServerTicks(bot, SERVER_ANSWER_TICKS, { signal, until: () => bot.nearestEntity(summoned) !== null });
  if (seen !== "until") return { status: "failed", detail: `Summoned cube not seen: ${seen}` };
  signal.throwIfAborted();
  const cube = bot.nearestEntity(summoned)!;
  let combat!: ReturnType<typeof createCombatController>;
  const runtime = await openRuntime(context, "descending-cube-contact", {
    createCombatController: (...dependencies) => (combat = createCombatController(...dependencies)),
  });
  const contact = watchContact(bot, combat, cube);
  const stop = new AbortController();
  let engagement!: Promise<EngagementEnd>;
  try {
    // The request a hunter makes: an explicit pursuit is purpose `pursuit`, which the automatic admission gate never refuses.
    engagement = combat.engage(cube.id, AbortSignal.any([signal, stop.signal]), "pursue").catch((cause: unknown) => ({
      kind: "threw" as const,
      attacks: 0 as const,
      error: String(cause),
    }));
    // Every return stops the engagement first and reports how it ended: a fight still live is cancelled, never left.
    const finish = (status: "succeeded" | "failed", fields: Record<string, unknown>) =>
      finishRun(stop, engagement, status, fields);
    const agesBefore = bot.time.age;
    const paused = await waitServerTicks(bot, PAUSE_TICKS, { signal });
    if (paused !== "moved") return finish("failed", { reason: `Server world age ${paused}` });
    const pausedAges = [agesBefore, bot.time.age];
    const guardedBeforeDescent = contact.guarded();
    if (guardedBeforeDescent === 0)
      return finish("failed", {
        guardedBeforeDescent,
        engaged: combat.activeEngagement()?.targetId === cube.id,
        health: bot.health,
      });
    bot.chat("/data merge entity @e[tag=descending_probe,limit=1] {NoAI:0b,NoGravity:0b}");
    const waited = await waitServerTicks(bot, GOAL_TICKS, { signal, until: () => bot.health <= 0 || !cube.isValid });
    signal.throwIfAborted();
    if (waited !== "until") return finish("failed", { reason: `Cube not resolved: ${waited}` });
    return finish(bot.health > 0 && !cube.isValid ? "succeeded" : "failed", {
      guardedBeforeDescent,
      health: bot.health,
      hurt: contact.hurt(),
      targetGone: !cube.isValid,
      pausedAges,
    });
  } finally {
    try {
      stop.abort();
      await engagement;
    } finally {
      contact.stop();
      await runtime.close();
    }
  }
};

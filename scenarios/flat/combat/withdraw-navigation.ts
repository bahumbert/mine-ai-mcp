import { NAVIGATE, navigateResultSchema } from "@aibengineering/mine-ai-mcp";
import { Vec3 } from "vec3";
import { z } from "zod";
import { createCombatController } from "../../../src/survival/control/combat/controller.ts";
import { waitServerTicks } from "../../../tests/minecraft/drivers/server-ticks.ts";
import { observe } from "../../default/nether/hazards/pit.ts";
import { openRuntime, standStill, wearArmor, type Runtime } from "../../src/runtime.ts";
import type { MineAiScenario, MineAiScenarioContext } from "../../src/scenario-client.ts";
import type { ClientCompletion } from "mine-labs/client";
import { readEncounters } from "./reflex.ts";

/**
 * Arrival must not turn into a fresh pursuit while the caller reads its receipt: watch 40 world ticks. Server ticks, not
 * client ticks (a client tick is 50 ms of real time at any server rate); a world age that stands still fails the trial.
 */
async function watchArrivalSettle(bot: Parameters<typeof waitServerTicks>[0], signal: AbortSignal): Promise<void> {
  if ((await waitServerTicks(bot, 40, { signal })) === "stalled")
    throw new Error("withdraw-navigation: the server's world age stood still for 30 s after the walk's arrival");
}

/** What the walk's request left behind: the state before it, the native shots seen, the fights started since the policy change, the navigate output. */
interface WithdrawWalk {
  readonly before: { health: number; shots: number; owner: unknown; position: Vec3 };
  readonly shots: number;
  readonly engagements: readonly { targetId: number; movement: "hold" | "pursue" }[];
  readonly output: Awaited<ReturnType<Runtime["run"]>>;
}

/** A sealed exit: the walk must not succeed, the failed escape (or a proven no-path) is reported, and the bot is alive and short of the wall. */
async function judgeBlockedWalk(context: MineAiScenarioContext, runtime: Runtime, walk: WithdrawWalk): Promise<ClientCompletion> {
  const { bot } = context;
  const { before, output, engagements } = walk;
  const encounters = await readEncounters(context, runtime);
  const failedEscape = encounters.some((event) => event.response === "evade" && event.outcome === "capability_limit");
  // Search may prove the destination sealed before the next reflex tick.
  // That is an equally valid obstruction report, with no movement to resume.
  const blockedRoute = "error" in output.result && output.result.error.includes("no path");
  const newPursuit = engagements.some((entry) => entry.movement === "pursue");
  return {
    status:
      output.result.status !== "succeeded" && (failedEscape || blockedRoute) && bot.health > 0 && bot.entity.position.x < 25
        ? "succeeded"
        : "failed",
    detail: JSON.stringify({ before, output, encounters, engagements, newPursuit, health: bot.health }),
  };
}

/** An open bridge: the walk must arrive, alive, within 3 blocks of its target after the evades and fights the reflex ran. */
async function judgeResumedWalk(context: MineAiScenarioContext, runtime: Runtime, walk: WithdrawWalk): Promise<ClientCompletion> {
  const { bot, signal } = context;
  const { before, shots, output, engagements } = walk;
  if ("kind" in output.result) return { status: "failed", detail: JSON.stringify({ before, output }) };
  const result = navigateResultSchema.parse(output.result);
  await watchArrivalSettle(bot, signal);
  const encounters = await readEncounters(context, runtime);
  const evades = encounters.filter((event) => event.response === "evade" && event.outcome === "safe_separation");
  const fights = encounters.filter((event) => event.response === "fight" && event.outcome !== "cancelled");
  const evidence = {
    before,
    shots,
    result,
    encounters,
    evades,
    fights,
    engagements,
    health: bot.health,
    position: bot.entity.position,
    intent: runtime.status().survivalPolicy.effective.combat.engagement,
  };
  context.log(JSON.stringify(evidence));
  return {
    status:
      result.status === "succeeded" && bot.health > 0 && bot.entity.position.distanceTo(new Vec3(60.5, 72, 0.5)) < 3
        ? "succeeded"
        : "failed",
    detail: JSON.stringify(evidence),
  };
}

/** The model asks to leave a real, already-running fight; native shooters continue firing. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  const params = z
    .object({ mob: z.enum(["blaze", "skeleton"]).default("blaze"), blocked: z.boolean().default(false) })
    .parse(context.scenario.params ?? {});
  await standStill(context);
  await wearArmor(context);
  if (params.blocked) {
    // Bedrock makes failed escape an actual capability boundary, independent of the carried tool.
    bot.chat("/fill -12 71 -2 25 71 2 bedrock");
    bot.chat("/fill -12 78 -2 25 78 2 bedrock");
    bot.chat("/fill -12 72 -3 25 78 -3 bedrock");
    bot.chat("/fill -12 72 3 25 78 3 bedrock");
    bot.chat("/fill -13 72 -3 -13 78 3 bedrock");
    bot.chat("/fill 25 72 -3 25 78 3 bedrock");
    await observe(bot, () => bot.blockAt(new Vec3(25, 72, 0))?.name === "bedrock", "sealed exit");
  }
  let combat!: ReturnType<typeof createCombatController>;
  let withdrawing = false;
  const engagements: { targetId: number; movement: "hold" | "pursue" }[] = [];
  const runtime = await openRuntime(context, "withdraw-navigation", {
    createCombatController: (...dependencies) => {
      combat = createCombatController(...dependencies);
      const engage = combat.engage;
      combat.engage = (targetId, signal, movement) => {
        if (withdrawing) engagements.push({ targetId, movement });
        return engage(targetId, signal, movement);
      };
      return combat;
    },
  });
  let shots = 0;
  const spawned = (entity: typeof bot.entity) => {
    if (entity.name === "small_fireball" || entity.name === "arrow") shots++;
  };
  bot.on("entitySpawn", spawned);
  try {
    const y = params.mob === "blaze" ? 74 : 72;
    const nbt =
      params.mob === "blaze"
        ? "{PersistenceRequired:1b}"
        : '{PersistenceRequired:1b,HandItems:[{id:"minecraft:bow",count:1},{}]}';
    bot.chat(`/summon ${params.mob} -6.5 ${y} -1.5 ${nbt}`);
    bot.chat(`/summon ${params.mob} -6.5 ${y} 2.5 ${nbt}`);
    await observe(
      bot,
      () => combat.activeEngagement() !== null && shots > 0,
      "active reflex fight with native fireballs",
    );
    const policyAction = runtime.actions.find((action) => action.name === "set_survival_policy")!;
    withdrawing = true;
    await runtime.run(
      policyAction,
      {
        operation: "set",
        expected_revision: runtime.status().survivalPolicy.revision,
        changes: { combat: { engagement: "defend_only", hide: "never" } },
        lifetime: { kind: "session" },
        reason: "Scenario setup.",
      },
      signal,
    );
    const navigate = runtime.actions.find((action) => action.name === NAVIGATE)!;
    const before = { health: bot.health, shots, owner: runtime.status().owner, position: bot.entity.position.clone() };
    const output = await runtime.run(navigate, { x: 60, y: 72, z: 0, range: 1, dig: false, scaffold: false }, signal);
    const walk = { before, shots, engagements, output };
    return params.blocked ? await judgeBlockedWalk(context, runtime, walk) : await judgeResumedWalk(context, runtime, walk);
  } finally {
    bot.off("entitySpawn", spawned);
    await runtime.close();
  }
};

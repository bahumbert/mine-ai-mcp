import { ExecutionScope } from "../../../execution/execution-scope.js";
import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import { isHostile } from "../../perception/combat/threats.js";
import { combatDecisionEvidence } from "../../policy/combat/decision.js";
import type { CombatPosition } from "../../positioning/combat/position.js";
import { runMobFight } from "../../responses/fight/run.js";
import type { FightEnvironment } from "../../responses/fight/scene.js";
import { ProtectedAttackProgress } from "./attack-progress.js";
import { EndermanProgress } from "./enderman-progress.js";
import { QuarryProgress } from "./quarry-progress.js";
import type { CombatOutcome, CombatResult } from "./contract.js";
import { runEngagement } from "./engagement.js";
import { CombatExecution, type CombatExecutionSnapshot } from "./execution.js";
import { observeCombatDecision } from "./observation.js";
import { recoverCombatHealth } from "./recovery.js";
import { deflectWithinCombat } from "./respond.js";
import { answeredResponses } from "./scopes/response.js";

export function emptyCombatEvidence<Kind extends string>(targetId: number, kind: Kind): CombatResult<Kind> {
  return {
    kind,
    targetId,
    attacks: 0,
    stylesUsed: [],
    weaponsUsed: [],
    shieldRaisedSwings: 0,
    projectileGuards: 0,
    explosions: 0,
  };
}

export interface MobObservation {
  position(value: CombatPosition | null): void;
  execution(read: () => CombatExecutionSnapshot): void;
  policyUse(value: "fight" | "recovery"): void;
}

/** Tick and explosion evidence spans deflections, recoveries and physical fights. */
function observeEngagementEvents(bot: FightEnvironment["bot"]) {
  let explosions = 0, ticks = 0;
  const onExplosion = () => { explosions++; };
  const onTick = () => { ticks++; };
  bot._client.on("explosion", onExplosion);
  bot.on("physicsTick", onTick);
  return {
    get explosions() { return explosions; },
    ticks: () => ticks,
    stop: () => {
      bot._client.off("explosion", onExplosion);
      bot.off("physicsTick", onTick);
    },
  };
}

/** Read current policy and answered responses through the same context for every physical response. */
function engagementContext({ bot, policy, perception, survival }: FightEnvironment) {
  return {
    resolvedIds: perception.resolvedIds,
    attackerIds: perception.attackerIds,
    perception,
    survival,
    get policy() { return policy.combat; },
    get food() { return policy.food; },
    get blockedResponses() { return answeredResponses(bot, () => policy.effective, survival); },
  };
}

/** A deflect or recovery owns its own execution observation while quarry clocks are paused. */
async function runResponseEffect<T>(
  environment: FightEnvironment,
  targetId: number,
  observe: MobObservation,
  phase: "recover" | "defend",
  run: () => Promise<T>,
): Promise<T> {
  const { bot, reportDecision } = environment;
  observe.position(null);
  observe.policyUse(phase === "recover" ? "recovery" : "fight");
  using scope = new ExecutionScope({ bot: bot.username, operation: `combat_${phase}`, targetId });
  const execution = new CombatExecution(scope, (current, completedEffects) =>
    reportDecision({ kind: "phase", targetId, phase: current, completedEffects }),
  );
  observe.execution(() => execution.snapshot(0));
  const tick = () => {
    execution.tick();
    execution.progress.observe(bot.health);
  };
  bot.on("physicsTick", tick);
  try {
    return await execution.run(phase, run);
  } finally {
    bot.off("physicsTick", tick);
    observe.policyUse("fight");
  }
}

/** Bind the shared request coordinator to physical responses under one owner's signal. */
export async function runMobEngagement(
  environment: FightEnvironment,
  targetId: number,
  movement: "pursue" | "hold",
  signal: AbortSignal,
  observe: MobObservation,
): Promise<CombatOutcome> {
  const { bot, navigation, policy, survival, reportDecision } = environment;
  const minimumHealth =
    movement === "pursue" && isHostile(bot.entities[targetId]) ? policy.combat.engage_min_health : 0;
  const purpose =
    movement === "pursue"
      ? ({ kind: "pursuit", targetId, minimumHealth } as const)
      : ({ kind: "contact_defence", targetId } as const);
  const context = engagementContext(environment);
  using protectedProgress = new ProtectedAttackProgress(
    survival.budgets,
    targetId,
    policy.combat.protected_wait_ticks,
  );
  using endermanProgress = new EndermanProgress(survival.budgets, policy.combat.enderman_wait_ticks);
  using quarryProgress = new QuarryProgress(survival.budgets, targetId, policy.combat.quarry_wait_ticks, () => bot.time?.age);
  // Evidence belongs to the engagement, including intervals between physical responses.
  const events = observeEngagementEvents(bot);
  try {
    const result = await runEngagement(signal, {
      purpose,
      ticks: events.ticks,
      nextTick: () => waitForPhysicsTicks(bot, 1, signal),
      observe: () => observeCombatDecision(bot, context),
      record: (facts, response) =>
        reportDecision({ kind: "response", evidence: combatDecisionEvidence(facts, purpose, response) }),
      fight: async () => {
        const target = bot.entities[targetId];
        if (!target?.isValid) return emptyCombatEvidence(targetId, "target_lost");
        return runMobFight(
          environment,
          { target, movement, minimumHealth, signal, ownerSignal: signal },
          protectedProgress,
          endermanProgress,
          observe,
          quarryProgress,
        );
      },
      deflect: (projectileId) =>
        runResponseEffect(environment, targetId, observe, "defend", async () => {
          await deflectWithinCombat(bot, projectileId, context, signal);
        }),
      recover: () =>
        runResponseEffect(environment, targetId, observe, "recover", async () => {
          reportDecision({
            kind: "recovery",
            targetId,
            state: "started",
            reason: `Health ${bot.health} requires protection and recovery.`,
          });
          const result = await recoverCombatHealth(bot, navigation, context, signal, (evidence) =>
            reportDecision({ kind: "response", evidence }),
          );
          reportDecision({
            kind: "recovery",
            targetId,
            state: result.kind,
            reason: result.kind === "blocked" ? result.observation : `Recovered to health ${bot.health}.`,
          });
          return result;
        }),
    });
    return { ...result, explosions: events.explosions };
  } finally {
    events.stop();
  }
}

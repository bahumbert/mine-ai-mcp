import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import { ProtectedAttackProgress } from "../../control/combat/attack-progress.js";
import { EndermanProgress } from "../../control/combat/enderman-progress.js";
import type { QuarryProgress } from "../../control/combat/quarry-progress.js";
import type { FightOutcome } from "../../control/combat/engagement.js";
import { type CombatExecutionSnapshot } from "../../control/combat/execution.js";
import { CombatPosition } from "../../positioning/combat/position.js";

import { CoverFight } from "./cover.js";
import { EndermanFight } from "./enderman.js";
import { FightMovement } from "./movement.js";
import { observeFight } from "./observe.js";
import { FightScene, type FightEnvironment, type FightRequest } from "./scene.js";
import { runFightTurn } from "./turn.js";
import { FightWeapons } from "./weapons.js";
import { BlastDefence } from "./blast.js";
import type { CombatTactic } from "../../policy/combat/tactics.js";
function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Owner cancellation wins; quarry exhaustion retains its physical fight outcome through tactic cancellation. */
function interruptedFightOutcome(scene: FightScene, cause: unknown): FightOutcome {
  if (scene.parentSignal.aborted) return scene.result("cancelled");
  if (scene.noProgress.signal.aborted) return scene.noProgressLimit();
  if (scene.dragonDefense.signal.aborted)
    return { ...scene.result("defence_required"), observation: String(scene.dragonDefense.signal.reason) };
  if (scene.responseRequired.signal.aborted)
    return { ...scene.result("response_required"), observation: String(scene.responseRequired.signal.reason) };
  return scene.signal.aborted ? scene.result("cancelled") : scene.failure(message(cause));
}

/** Dispatch the selected physical effect, preserving the quarry while an incidental threat owns focus. */
async function runFightTactic(
  scene: FightScene, weapons: FightWeapons, locomotion: FightMovement,
  cover: CoverFight, roof: EndermanFight, blast: BlastDefence, tactic: CombatTactic,
): Promise<FightOutcome | null> {
  if (tactic.kind === "recover_footing") { await locomotion.recoverFooting(); return null; }
  if (tactic.kind === "counter_blast") return blast.counter(tactic.targetId);
  if (tactic.kind === "blast_barrier") return blast.barrier(tactic.cell);
  if (tactic.kind === "brace_blast") return blast.brace();
  if (tactic.kind === "constrained") return { ...scene.result("capability_blocked"), reason: "policy",
    observation: "[COMBAT_CONSTRAINED] Blast danger requires withdrawal, but combat retreat is prohibited." };
  // Clearance is independent of the quarry's death verdict.
  if (tactic.kind === "escape") {
    const threats = tactic.threatIds.map(id => scene.bot.entities[id])
      .filter(entity => entity?.isValid && !scene.perception.resolvedIds.has(entity.id))
      .sort((a, b) => a.position.distanceTo(scene.bot.entity.position) - b.position.distanceTo(scene.bot.entity.position));
    const threat = threats.find(entity => entity === scene.target) ?? threats[0];
    if (threat && scene.target !== threat) {
      scene.focus(threat);
      // Reconsider with the threat's equipment and cornered melee mechanics.
      return null;
    }
    return locomotion.retreat();
  }
  return runFightTurn(scene, weapons, locomotion, cover, roof, tactic);
}
/** Compose one physical fight. The enclosing request owns recovery and resumption. */
export async function runMobFight(
  environment: FightEnvironment,
  request: FightRequest,
  protectedProgress: ProtectedAttackProgress,
  endermanProgress: EndermanProgress,
  observe: { position(value: CombatPosition): void; execution(read: () => CombatExecutionSnapshot): void },
  quarryProgress: QuarryProgress,
): Promise<FightOutcome> {
  using scene = new FightScene(environment, request, protectedProgress, endermanProgress, quarryProgress);
  scene.reportProgress("started");
  if (!scene.requestedTarget.isValid) {
    scene.reportProgress("ended", "target_lost");
    return scene.result("target_lost");
  }
  const weapons = new FightWeapons(scene, {
    recoverFooting: () => locomotion.recoverFooting(),
    returnToCover: () => cover.returnToCover(),
  });
  const blast = new BlastDefence(scene, weapons);
  const locomotion = new FightMovement(scene, weapons, blast.protect);
  const cover = new CoverFight(scene, weapons, locomotion);
  const roof = new EndermanFight(scene, weapons, locomotion);
  observe.position(scene.position);
  observe.execution(() => scene.execution.snapshot(scene.attacks));
  const observation = observeFight(scene, weapons, locomotion, cover, roof);
  let outcome: FightOutcome;
  try {
    while (true) {
      scene.observeQuarryStop(cover.recovering);
      await scene.responsiveness.checkpoint(scene.signal);
      if (scene.bot.health <= 0) { outcome = scene.result("bot_died"); break; }
      // The caller's goal is met: stop at this boundary, never inside a running guard or volley.
      if (request.satisfied?.()) { outcome = scene.result("target_lost"); break; }
      const tickBefore = scene.elapsedTicks;
      scene.observeBoundary();
      const tactic = scene.tactics.observe(scene, weapons);
      const effect = await scene.tactics.run(tactic, () =>
        runFightTactic(scene, weapons, locomotion, cover, roof, blast, tactic));
      if (effect.kind === "interrupted") continue;
      const next = effect.value;
      if (next) {
        if (scene.observed === "died" || scene.observed === "target_lost") {
          const volley = await scene.tactics.run({ kind: "guard" }, () => weapons.guardFinalVolley());
          // An arriving blast returns to this same decision/dispatch loop,
          // including counter-hit and placement when final escape is blocked.
          if (volley.kind === "interrupted") continue;
        }
        outcome = next;
        break;
      }
      // A step that awaited no physical effect returns inside the same
      // tick: a target in reach whose body terrain hides, a bystander in
      // sweep range, a stance without knockback room. Deciding again at
      // once observes the identical scene, and the loop then runs on
      // resolved promises alone: physics, packets and the MCP server never
      // get the thread, the scene can never change, and the server times
      // the bot out. Blazes behind fortress pillars held the host this way
      // for minutes on 9 September 2026. One tick lets the scene move.
      if (scene.elapsedTicks === tickBefore) await waitForPhysicsTicks(scene.bot, 1, scene.signal);
    }
  } catch (cause) {
    outcome = interruptedFightOutcome(scene, cause);
  } finally {
    observation.stopEffects();
  }
  try {
    await scene.execution.run("release", () =>
      weapons.itemUse.neutralise(async () => {
        if (scene.footingRecovery.needed && !scene.signal.aborted) await locomotion.recoverFooting();
        if (scene.ownerSignal.aborted) locomotion.footing.release();
        else await locomotion.footing.stop(scene.ownerSignal);
      }, scene.ownerSignal),
    );
    scene.reportProgress("ended", outcome.kind, "observation" in outcome ? outcome.observation : null);
    return outcome;
  } catch (cause) {
    const primary = outcome.kind === "failed" ? `${outcome.observation}; ` : "";
    scene.reportProgress("ended", "cleanup_failed");
    return scene.failure(`${primary}Combat cleanup failed: ${message(cause)}`);
  } finally {
    observation.close();
  }
}

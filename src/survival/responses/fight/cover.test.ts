// Cover and refuge admission share the observed projectile trajectory.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { createNavigationRuntime } from "../../../navigation/index.js";
import { CombatPerception } from "../../perception/combat/observations.js";
import { ProtectedAttackProgress } from "../../control/combat/attack-progress.js";
import { EndermanProgress } from "../../control/combat/enderman-progress.js";
import { survivalResources } from "../../state/resources.js";
import { SurvivalPolicyState } from "../../state/survival-policy.js";
import { FootingRecovery } from "../footing.js";
import { FightScene } from "./scene.js";
import { FightWeapons } from "./weapons.js";
import { CoverFight } from "./cover.js";

test("a drowned's incoming trident exposes a cover cell and invalidates its refuge", async () => {
  const { bot, world } = createFakeBot({ position: new Vec3(0.5, 64, 0.5), entities: {
    2: { name: "drowned", position: new Vec3(20.5, 64, 0.5) },
    3: { name: "trident", position: new Vec3(0.5, 65, 5) },
  } });
  await using navigation = createNavigationRuntime(bot);
  using perception = new CombatPerception(bot);
  using footingRecovery = new FootingRecovery(bot, navigation.world);
  const survival = survivalResources();
  using progress = new ProtectedAttackProgress(survival.budgets, 2, 100);
  using endermanProgress = new EndermanProgress(survival.budgets, 300);
  const signal = new AbortController().signal;
  using scene = new FightScene({ bot, navigation, perception, footingRecovery, survival,
    policy: new SurvivalPolicyState(bot), reportDecision: () => {} },
    { target: bot.entities[2]!, movement: "hold", signal, ownerSignal: signal, minimumHealth: 0 }, progress, endermanProgress);
  const cell = bot.entity.position.floored();
  scene.position.plan = { protected: cell, corner: cell, entrance: cell, fighting: cell, placements: [] };
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  const cover = new CoverFight(scene, weapons, {} as ConstructorParameters<typeof CoverFight>[2]);
  const exposure = () => [cover.positionFacts()!.attackExposed, !scene.position.protected()];
  const trident = bot.entities[3]!;
  assert.deepEqual(exposure(), [false, false], "a stationary projectile is not incoming");
  trident.velocity.set(0, 0, -1);
  assert.deepEqual(exposure(), [true, true], "an incoming trident invalidates cover even away from its shooter");
  trident.velocity.set(0, 0, 1);
  assert.deepEqual(exposure(), [false, false], "a receding trident releases cover");
  trident.velocity.set(0, 0, -1);
  world.setCell(new Vec3(0, 65, 3), "stone");
  assert.deepEqual(exposure(), [false, false], "terrain blocks the projectile before the body");
});

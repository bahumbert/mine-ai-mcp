// Cover and refuge admission share the observed projectile trajectory.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../../../test-support/fake-bot/index.js";
import { useNativeDigging } from "../../../test-support/fake-bot/native-digging.js";
import { installNativeDigClock } from "../../../navigation/index.js";
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

for (const ticksPerSecond of [20, 10]) test(`fire lit during a cover hold is cleared and recovery continues at ${ticksPerSecond} tps`, async () => {
  const harness = createFakeBot({ position: new Vec3(0.5, 64, 0.5), health: 8, food: 20,
    clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond }, entities: {
      2: { name: "zombie", position: new Vec3(20.5, 64, 0.5) },
    } });
  const { bot, world, clock } = harness;
  // Stopgap: occupied-fire removal awaits a real-server native-dig contract at 20 and 10 tps.
  useNativeDigging(harness);
  installNativeDigClock(bot);
  using _timers = clock.install();
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
  scene.boundaryDecision = { kind: "recover", health: 18 };
  scene.recoveryTarget = 18;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  let waits = 0;
  Reflect.set(weapons, "holdFacing", async () => {
    if (++waits === 1) world.setCell(cell, "fire");
    else {
      assert.equal(bot.blockAt(cell)?.name, "air", "recovery resumes after the server clears fire");
      assert.equal(bot.health, 8);
      assert.ok(scene.position.plan?.protected.equals(cell));
      bot.health = 18;
    }
  });
  const cover = new CoverFight(scene, weapons, {} as ConstructorParameters<typeof CoverFight>[2]);
  assert.equal(scene.position.protected(), true, "the fire-free refuge is protected");
  world.setCell(cell.offset(0, 1, 0), "soul_fire");
  assert.equal(scene.position.protected(), true, "head fire does not erase cover");
  world.setCell(cell.offset(0, 1, 0), "stone");
  assert.equal(scene.position.protected(), false, "a solid head obstruction still invalidates cover");
  world.setCell(cell.offset(0, 1, 0), "air");
  const result = await clock.settle(cover.keepPosition(signal), 90_000);
  assert.equal(result.kind, "continue");
  assert.equal(bot.blockAt(cell)?.name, "air");
  assert.equal(bot.health, 18, "recovery continued to the health update");
  assert.ok(scene.position.plan?.protected.equals(cell));
  assert.equal((await clock.settle(cover.keepPosition(signal), 90_000)).kind, "continue");
});

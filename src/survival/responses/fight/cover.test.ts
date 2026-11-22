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
import { positionThreat } from "../../perception/combat/observations.js";
import { findCombatPosition } from "../../positioning/combat/planner.js";
import { CombatPosition } from "../../positioning/combat/position.js";
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
  // Server agreement: contract/occupied-fire-dig at 20 and 10 tps (2026-11-17).
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

/** A blaze 8 blocks north, a built shell around the bot's cell, and a protected window of `limit` ticks (the case tests a window's end, not its length). */
async function shellFixture(limit: number) {
  const harness = createFakeBot({ position: new Vec3(0.5, 64, 0.5), clock: createFakeClock({ mode: "mocked" }),
    carried: { cobblestone: 64 },
    entities: { 2: { name: "blaze", position: new Vec3(0.5, 64, -8.5) } } });
  const { bot, world, clock } = harness;
  const timers = clock.install();
  const navigation = createNavigationRuntime(bot);
  const perception = new CombatPerception(bot);
  const footingRecovery = new FootingRecovery(bot, navigation.world);
  const survival = survivalResources();
  const progress = new ProtectedAttackProgress(survival.budgets, 2, limit);
  const endermanProgress = new EndermanProgress(survival.budgets, 300);
  const controller = new AbortController();
  const signal = controller.signal;
  const policy = new SurvivalPolicyState(bot);
  const scene = new FightScene({ bot, navigation, perception, footingRecovery, survival,
    policy, reportDecision: () => {} },
    { target: bot.entities[2]!, movement: "pursue", signal, ownerSignal: signal, minimumHealth: 0 }, progress, endermanProgress);
  const threat = positionThreat(bot, bot.entities[2]!);
  const plan = findCombatPosition(navigation.world, bot.entity.position.floored(), [threat], threat, 64)!;
  assert.ok(plan, "the open floor offers a refuge");
  for (const cell of plan.placements) world.setCell(cell, "cobblestone");
  bot.entity.position.set(plan.protected.x + 0.5, plan.protected.y, plan.protected.z + 0.5);
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  const cover = new CoverFight(scene, weapons, {} as ConstructorParameters<typeof CoverFight>[2]);
  const exhaustWindow = () => {
    progress.enter(plan.protected.toString());
    for (let tick = 0; tick < limit; tick++) progress.tick(false);
  };
  return { harness, scene, cover, plan, signal, progress, exhaustWindow, survival, policy, navigation, perception,
    [Symbol.asyncDispose]: async () => {
      scene[Symbol.dispose](); progress[Symbol.dispose](); endermanProgress[Symbol.dispose]();
      footingRecovery[Symbol.dispose](); perception[Symbol.dispose](); await navigation[Symbol.asyncDispose](); timers[Symbol.dispose]();
    } };
}

test("a refuge rejected for its protected wait is not adopted again for that target", async () => {
  await using fixture = await shellFixture(3);
  const { scene, cover, plan, signal, exhaustWindow } = fixture;
  scene.position.plan = plan;
  exhaustWindow();
  assert.equal((await cover.keepPosition(signal)).kind, "continue", "the exhausted window rejects the refuge");
  assert.equal(scene.position.plan, null, "the rejected refuge is dropped");
  // The live blaze moved: its key record (`protected:corner:entrance`) lapses with the target's floored position.
  fixture.harness.bot.entities[2]!.position.x += 1;
  assert.equal((await cover.keepPosition(signal)).kind, "proceed", "no cover is adopted or built for that target: the approach goes on");
  assert.equal(scene.position.plan, null, "the shell the bot stands in is not adopted again");
});

const coverWaitRecords = (fixture: Awaited<ReturnType<typeof shellFixture>>) =>
  fixture.survival.answered.snapshot().filter((entry) => entry.capability === "combat.cover_wait");

// The window counts the client's physics ticks, 20 a second at any server speed: 300 are 300 world ticks at 20 tps and
// 150 at 10 tps. The cases here run no server-paced wait; the engagement cases of `controller.test.ts` run the window
// through the production tick source at 20 and 10 tps and with the server stopped.
for (const [name, sequence] of [
  ["without damage", ["tick", "tick"]],
  ["with confirmed quarry damage after two ticks, which renews it", ["tick", "tick", "damage", "tick", "tick"]],
] as const) test(`the protected wait's end is recorded at exhaustion, not one tick before, ${name}`, async () => {
  await using fixture = await shellFixture(3);
  const { scene, cover, plan, signal, progress } = fixture;
  scene.position.plan = plan;
  assert.equal(scene.position.canEstablish, true, "before any rejection cover is allowed as before");
  progress.enter(plan.protected.toString());
  for (const step of sequence) step === "tick" ? progress.tick(false) : progress.confirmedTargetDamage();
  await fixture.harness.clock.settle(cover.keepPosition(signal), 90_000);
  assert.ok(scene.position.plan, "one tick short: the refuge is kept");
  assert.deepEqual(coverWaitRecords(fixture), [], "one tick short: nothing is recorded");
  assert.equal(scene.position.canEstablish, true);
  progress.tick(false);
  assert.equal((await cover.keepPosition(signal)).kind, "continue");
  assert.deepEqual(
    coverWaitRecords(fixture).map((entry) => [entry.scope, entry.failure.kind]),
    [["target:2", "target_progress_exhausted"]],
    "the record is the target's, at exhaustion",
  );
  assert.equal(scene.position.canEstablish, false);
});

test("the end of a protected wait is the target's: the next blaze still gets cover, and moving never reopens it", async () => {
  await using fixture = await shellFixture(3);
  const { harness, scene, cover, plan, signal, exhaustWindow } = fixture;
  scene.position.plan = plan;
  exhaustWindow();
  await cover.keepPosition(signal);
  const { bot } = harness;
  const other = harness.entities.spawn({ id: 3, name: "blaze", position: new Vec3(0.5, 64, -8.5) });
  const next = new CombatPosition(bot, fixture.navigation, other, new Set(), fixture.perception, () => fixture.policy.combat,
    fixture.survival.answered);
  assert.equal(next.canEstablish, true, "a second target starts with cover allowed");
  next.adoptExisting();
  assert.ok(next.plan, "a second target adopts the shell");
  bot.entities[2]!.position.x += 1; // the move that lapses a key record (floored position), as the live blaze's
  assert.equal(scene.position.canEstablish, false, "the target moved a block: the end of its wait stands");
  scene.position.adoptExisting();
  assert.equal(scene.position.plan, null);
});

// The record consumes the three permissions of `geometryScope` (dig, place, melee): each one's change reopens it.
for (const [permission, changes, restored] of [
  ["place", { terrain: { place: false } }, { terrain: { place: true } }],
  ["dig", { terrain: { dig: false } }, { terrain: { dig: true } }],
  ["melee", { melee: false }, { melee: true }],
] as const) test(`a policy change of ${permission} reopens cover for the target`, async () => {
  await using fixture = await shellFixture(3);
  const { scene, cover, plan, signal, exhaustWindow, policy } = fixture;
  scene.position.plan = plan;
  exhaustWindow();
  await cover.keepPosition(signal);
  assert.equal(scene.position.canEstablish, false);
  await policy.edit({ operation: "set", expected_revision: policy.snapshot().revision,
    changes: { combat: changes }, lifetime: { kind: "session" }, reason: "test" });
  assert.equal(scene.position.canEstablish, true, "the permissions the record consumed changed: it lapses");
  assert.deepEqual(coverWaitRecords(fixture), []);
  await policy.edit({ operation: "set", expected_revision: policy.snapshot().revision,
    changes: { combat: restored }, lifetime: { kind: "session" }, reason: "test" });
  assert.equal(scene.position.canEstablish, true, "restoring the permission does not bring the lapsed record back");
});

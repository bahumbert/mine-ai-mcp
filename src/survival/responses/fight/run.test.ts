// Whole physical fights share the engagement's quarry clock across attack effects.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, itemOf, listenersAddedSince } from "../../../test-support/fake-bot/index.js";
import { createNavigationRuntime } from "../../../navigation/index.js";
import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import { serverTickPace } from "../../../world/server-tick-pace.js";
import { ProtectedAttackProgress } from "../../control/combat/attack-progress.js";
import { EndermanProgress } from "../../control/combat/enderman-progress.js";
import { QuarryProgress } from "../../control/combat/quarry-progress.js";
import { CombatTactics } from "../../control/combat/tactics.js";
import { CombatPerception } from "../../perception/combat/observations.js";
import { survivalResources } from "../../state/resources.js";
import { SurvivalPolicyState } from "../../state/survival-policy.js";
import { swingReadiness } from "../../weapons/swing-readiness.js";
import { FootingRecovery } from "../footing.js";
import type { FightScene } from "./scene.js";
import { runMobFight } from "./run.js";

for (const rate of [20, 10]) for (const mode of ["bow", "melee", "guard", "footing", "clearance", "footing_abort", "clearance_abort", "footing_hit", "clearance_hit"] as const) {
  test(`${mode} without quarry damage is bounded in server ticks at ${rate} tps`, async t => {
    const harness = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond: rate }, position: new Vec3(0.5, 64, 0.5), groundY: 63,
      carried: mode === "bow" ? { bow: 1, arrow: 64 } : { diamond_sword: 1 },
      entities: { 7: { name: "cow", position: new Vec3(mode === "bow" ? 10.5 : 2.5, 64, 0.5) } } });
    const { bot, clock } = harness;
    using _installed = clock.install();
    await using navigation = createNavigationRuntime(bot);
    using perception = new CombatPerception(bot);
    using footingRecovery = new FootingRecovery(bot, navigation.world);
    // These observers belong to the connection, before any physical fight or listener baseline (a11 T2/T3a).
    using _pace = serverTickPace(bot);
    using _readiness = swingReadiness(bot);
    const survival = survivalResources();
    const baseline = listenersAddedSince(bot);
    const clientBaseline = listenersAddedSince(bot._client);
    let subscriptions = 0;
    const onNavigationEvent = navigation.onEvent.bind(navigation);
    t.mock.method(navigation, "onEvent", listener => {
      subscriptions++;
      const unsubscribe = onNavigationEvent(listener);
      return () => { subscriptions--; unsubscribe(); };
    });
    using protectedProgress = new ProtectedAttackProgress(survival.budgets, 7, 300);
    using endermanProgress = new EndermanProgress(survival.budgets, 300);
    using quarry = new QuarryProgress(survival.budgets, 7, 300, () => bot.time.age);
    const parent = new AbortController();
    let scene: FightScene | undefined, shots = 0, routes = 0;
    let guarding = mode === "guard";
    let obligation = false, recovered = false;
    const safety = mode.startsWith("footing") || mode.startsWith("clearance");
    if (mode.startsWith("footing")) {
      Object.defineProperty(footingRecovery, "needed", { get: () => obligation });
      t.mock.method(footingRecovery, "recover", async (signal) => {
        await waitForPhysicsTicks(bot, 100 * 20 / rate, signal);
        obligation = false; recovered = true;
        return "landed";
      });
    }
    if (mode.startsWith("clearance")) Object.defineProperty(perception.creeperClearance, "pending", { get: () => obligation });
    // The physical safety obligation opens just before the packet that exhausts the budget.
    const requireSafety = () => { if (safety && harness.server.gameTime >= 24_300 && !recovered) obligation = true; };
    bot.on("physicsTick", requireSafety);
    t.mock.method(bot, "attack", () => {});
    // An arrived route without movement is the observed C1 boundary; native hit receipts are deliberately absent.
    t.mock.method(navigation, "navigate", async () => { routes++; return { status: "arrived" }; });
    t.mock.method(CombatTactics.prototype, "observe", (current, weapons) => {
      scene = current;
      if (mode === "bow") Object.assign(weapons, { shoot: async () => { shots++; return "obstructed"; } });
      if (mode === "guard") Object.assign(weapons, {
        projectileDefence: () => guarding ? { projectiles: [], windingUp: [], coversAll: true, aligned: true } : null,
        guardIncoming: () => current.execution.run("guard", async () => {
          await waitForPhysicsTicks(bot, 700 * 20 / rate, parent.signal);
          guarding = false;
          return true;
        }),
      });
      return { kind: guarding ? "guard" : "act" };
    });
    const fight = runMobFight(
      { bot, navigation, perception, footingRecovery, survival, policy: new SurvivalPolicyState(bot), reportDecision: () => {} },
      { target: bot.entities[7]!, movement: "pursue", signal: parent.signal, ownerSignal: parent.signal, minimumHealth: 0 },
      protectedProgress, endermanProgress, { position: () => {}, execution: () => {} }, quarry);
    let outcome: Awaited<typeof fight> | undefined, settlements = 0;
    void fight.then(value => { outcome = value; settlements++; });
    await clock.advance(50);
    if (mode === "guard") {
      // A real execution phase boundary models a volley that owns facing for 700 server ticks.
      await clock.advance(700 * 1000 / rate - 50);
      assert.equal(outcome, undefined, `guard still owns the fight at wall ${clock.now()}, age ${bot.time.age}`);
      assert.equal(quarry.ticks(), 0, `guard does not spend the quarry clock at age ${bot.time.age}`);
      await clock.advance(50);
    }
    const started = harness.server.gameTime;
    await clock.advance(300 * 1000 / rate);
    assert.equal(outcome, undefined, `the bound has not charged a full 300 ticks at wall ${clock.now()}, age ${bot.time.age}`);
    await clock.advance(20 * 1000 / rate);
    if (safety) {
      assert.equal(outcome, undefined, `expiry retains the body for ${mode}, age ${bot.time.age}`);
      assert.equal(scene!.quarryStopPending, true, "the exhausted stop is retained through physical clearance");
      if (mode.endsWith("hit")) {
        // A previously sent attack may land while an exhausted fight still owns safety work.
        bot._client.emit("damage_event", { entityId: 7, sourceCauseId: bot.entity.id + 1 });
        await clock.advance(50);
        assert.equal(scene!.quarryStopPending, false, "confirmed quarry damage withdraws the pending stop");
      }
      if (mode.endsWith("abort")) parent.abort("owner takes the body during the pending quarry stop");
      else if (mode.startsWith("clearance")) { obligation = false; recovered = true; }
      await clock.advance(120 * 1000 / rate);
      if (mode === "footing") assert.equal(recovered, true, "the landing completed before settlement");
      if (mode.endsWith("hit")) {
        assert.equal(outcome, undefined, "the renewed fight continues after safety clears");
        await clock.advance(180 * 1000 / rate);
        assert.equal(outcome, undefined, "renewal grants a full active no-hit interval");
        await clock.advance(20 * 1000 / rate);
      }
    }
    if (!outcome) { parent.abort("fixture reached its 320-server-tick bound"); await fight; }
    const result = await fight;
    assert.equal(result.kind, mode.endsWith("abort") ? "cancelled" : "unreachable", `wall ${clock.now()}, age ${bot.time.age}, active ${harness.server.gameTime - started}`);
    if (result.kind === "unreachable") {
      assert.equal(result.premise, "no_confirmed_damage");
      assert.equal(result.observation, "No confirmed damage to cow#7 during 300 server ticks of fighting or 48 s.");
    }
    if (mode === "bow") assert.ok(shots > 1 && routes > 1, "the obstructed shot / arrived route loop was exercised");
    if (mode !== "bow") assert.ok(scene!.attacks > 0, "melee turns actually sent attacks");
    assert.deepEqual(survival.budgets.snapshot(), []);
    bot.off("physicsTick", requireSafety);
    const assertReleased = () => {
      for (const event of ["physicsTick", "health", "entityDead", "entityGone", "death", "entitySwingArm"])
        assert.equal(baseline(event), 0, `${event} listeners released`);
      for (const event of ["explosion", "damage_event", "entity_status"])
        assert.equal(clientBaseline(event), 0, `${event} packet listeners released`);
      assert.equal(subscriptions, 0, "navigation subscription released");
    };
    assertReleased();
    const stopped = { observed: scene!.observed, explosions: scene!.explosions, attacks: scene!.attacks };
    await clock.advance(48_050);
    bot.emit("entityDead", bot.entities[7]!);
    bot.emit("entityGone", bot.entities[7]!);
    bot._client.emit("damage_event", { entityId: 7, sourceCauseId: bot.entity.id + 1 });
    bot._client.emit("explosion", {});
    assert.equal(settlements, 1, "late events and the former wall deadline cannot settle twice");
    assert.deepEqual({ observed: scene!.observed, explosions: scene!.explosions, attacks: scene!.attacks }, stopped,
      "late events cannot affect the released fight");
    assertReleased();
    // A new engagement, with real shared-fake damage, can use the released body after this stop or cancellation.
    t.mock.restoreAll();
    obligation = false;
    harness.inventory.updateSlot(36, itemOf(bot.registry, "diamond_axe"));
    harness.entities.remove(7);
    const healthKey = bot.registry.entitiesByName.cow!.metadataKeys!.indexOf("health");
    harness.entities.spawn({ id: 8, name: "cow", position: new Vec3(2.5, 64, 0.5), metadata: { [healthKey]: 1 } });
    using nextQuarry = new QuarryProgress(survival.budgets, 8, 300, () => bot.time.age);
    const signal = new AbortController().signal;
    const next = runMobFight(
      { bot, navigation, perception, footingRecovery, survival, policy: new SurvivalPolicyState(bot), reportDecision: () => {} },
      { target: bot.entities[8]!, movement: "pursue", signal, ownerSignal: signal, minimumHealth: 0 },
      protectedProgress, endermanProgress, { position: () => {}, execution: () => {} }, nextQuarry);
    assert.equal((await clock.settle(next, 5_000)).kind, "died", "the next quarry engagement finishes within its bound");
    assertReleased();
  });
}

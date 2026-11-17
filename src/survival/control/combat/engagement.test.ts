import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../test-support/fake-bot/index.js";
import { createNavigationRuntime } from "../../../navigation/index.js";
import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import { serverTickPace } from "../../../world/server-tick-pace.js";
import { CombatPerception } from "../../perception/combat/observations.js";
import { FootingRecovery } from "../../responses/footing.js";
import { survivalResources } from "../../state/resources.js";
import { SurvivalPolicyState } from "../../state/survival-policy.js";
import { swingReadiness } from "../../weapons/swing-readiness.js";
import { DEFAULT_COMBAT_POLICY } from "../../policy/combat/contract.js";
import type { CombatDecisionFacts } from "../../policy/combat/decision.js";
import { combatDecisionFacts } from "../../../test-support/combat.js";
import type { CombatOutcome } from "./contract.js";

import { runEngagement } from "./engagement.js";
import { runMobEngagement } from "./mob.js";
import { Vec3 } from "vec3";

const result = (kind: "cancelled" | "died", attacks: number): CombatOutcome => ({
  kind,
  targetId: 7,
  attacks,
  stylesUsed: ["melee"],
  weaponsUsed: ["iron_sword"],
  shieldRaisedSwings: 0,
  projectileGuards: 0,
  explosions: 0,
});

test("a health stop recovers and continues the same target with accumulated evidence", async () => {
  const { bot, combat: scene } = createFakeBot({ health: 20 });
  const request = new AbortController();
  const transitions: string[] = [];
  const outcome = await runEngagement(request.signal, {
    ...operations(bot),
    fight: async () => {
      transitions.push("fight");
      if (transitions.length === 1) {
        scene.setHealth(11);

        assert.equal(request.signal.aborted, false);
        return {
          ...result("cancelled", 2),
          kind: "response_required",
          observation: "Health boundary selected recovery.",
        };
      }
      return result("died", 3);
    },
    recover: async () => {
      transitions.push("recover");
      bot.health = 18;
      return { kind: "recovered" };
    },
  });
  assert.deepEqual(transitions, ["fight", "recover", "fight"]);
  assert.equal(outcome.kind, "died");
  assert.equal(outcome.attacks, 5);
  assert.equal(bot.listenerCount("health"), 0);
});

test("blocked recovery reports its capability rather than retrying a wounded fight", async () => {
  const bot = createFakeBot({ health: 7 }).bot;
  const outcome = await runEngagement(new AbortController().signal, {
    ...operations(bot),
    fight: async () => {
      throw new Error("A wounded fight must not start.");
    },
    recover: async () => ({ kind: "blocked", observation: "No food remains and hunger cannot regenerate health." }),
  });
  assert.equal(outcome.kind, "capability_blocked");
  if (outcome.kind !== "capability_blocked") throw new Error("Expected recovery limitation.");
  assert.equal(outcome.reason, "recovery");
  assert.match(outcome.observation, /No food/);
});

test("death during recovery remains death rather than a resource limitation", async () => {
  const bot = createFakeBot({ health: 7 }).bot;
  const outcome = await runEngagement(new AbortController().signal, {
    ...operations(bot),
    fight: async () => {
      throw new Error("A dead bot cannot resume fighting.");
    },
    recover: async () => {
      bot.health = 0;
      return { kind: "blocked", observation: "Shelter construction was interrupted." };
    },
  });
  assert.equal(outcome.kind, "bot_died");
});

test("caller cancellation never starts a recovery retry", async () => {
  const bot = createFakeBot({ health: 20 }).bot;
  const request = new AbortController();
  const outcome = await runEngagement(request.signal, {
    ...operations(bot),
    fight: async () => {
      request.abort("user cancelled");
      return result("cancelled", 1);
    },
    recover: async () => {
      throw new Error("Cancellation is terminal.");
    },
  });
  assert.equal(outcome.kind, "cancelled");
});

test("recovery uses the caller's policy health threshold", async () => {
  const bot = createFakeBot({ health: 15 }).bot;
  const transitions: string[] = [];
  const outcome = await runEngagement(new AbortController().signal, {
    ...operations(bot, 19),
    recover: async () => {
      transitions.push("recover");
      bot.health = 19;
      return { kind: "recovered" };
    },
    fight: async () => {
      transitions.push("fight");
      assert.equal(bot.health, 19);
      return result("died", 1);
    },
  });
  assert.deepEqual(transitions, ["recover", "fight"]);
  assert.equal(outcome.kind, "died");
});

for (const cleanupFails of [false, true]) {
  test(`cancelling recovery ${cleanupFails ? "preserves a cleanup failure" : "returns cancelled after release"}`, async () => {
    const bot = createFakeBot({ health: 7 }).bot;
    const request = new AbortController();
    const failure = new Error("Physical cleanup failed.");
    const pending = runEngagement(request.signal, {
      ...operations(bot),
      fight: async () => {
        throw new Error("Recovery must precede fighting.");
      },
      recover: async () => {
        request.abort("Combat policy changed.");
        if (cleanupFails) throw failure;
        request.signal.throwIfAborted();
        return { kind: "recovered" };
      },
    });
    if (cleanupFails) await assert.rejects(pending, failure);
    else assert.equal((await pending).kind, "cancelled");
  });
}

function operations(bot: Bot, minimumHealth = 12) {
  return {
    purpose: { kind: "pursuit", targetId: 7, minimumHealth } as const,
    ticks: () => 0,
    nextTick: async () => {},
    observe: (): CombatDecisionFacts => combatDecisionFacts({
      policy: DEFAULT_COMBAT_POLICY,
      health: bot.health,
      burning: false,
      hideAllowed: true,
      recoveryAvailable: true,
      weapon: true,
      rangedWeapon: false,
      shield: true,
      contacts: [],
      fireball: null,
      answeredFights: new Map(),
      answered: new Set(),
    }),
    record: () => {},
    deflect: async () => {
      throw new Error("No fireball in this fixture.");
    },
  };
}

test("the selected deflection executes before the quarry fight", async () => {
  const { bot } = createFakeBot({ health: 20 });
  const base = operations(bot);
  let fireball = true;
  const effects: string[] = [];
  const outcome = await runEngagement(new AbortController().signal, {
    ...base,
    observe: () => ({
      ...base.observe(),
      fireball: fireball ? { id: 99, name: "fireball", position: { x: 1, y: 65, z: 0 }, distance: 1 } : null,
    }),
    deflect: async (id) => {
      assert.equal(id, 99);
      effects.push("deflect");
      fireball = false;
    },
    fight: async () => {
      effects.push("fight");
      return result("died", 1);
    },
    recover: async () => {
      throw new Error("No recovery selected.");
    },
  });
  assert.equal(outcome.kind, "died");
  assert.deepEqual(effects, ["deflect", "fight"]);
});

for (const response of ["fight", "deflect", "recover"] as const) {
  test(`a ${response} that returns in the same tick lets a timer run before the third response`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { bot } = createFakeBot({ clock });
    const base = operations(bot);
    const request = new AbortController();
    let ticks = 0, responses = 0, timerFired = false, timerBeforeThird = false;
    setTimeout(() => { timerFired = true; }, 0);
    const respond = () => {
      responses++;
      if (responses === 3) timerBeforeThird = timerFired;
      // The old resolved-promise loop must terminate even though it starves the timer (a10 T3a).
      if (responses === 10_000) request.abort("same-tick spin");
    };
    const pending = runEngagement(request.signal, {
      ...base,
      ticks: () => ticks,
      nextTick: async () => { await clock.sleep(50, request.signal); ticks++; },
      observe: () => ({ ...base.observe(), health: response === "recover" && responses < 3 ? 7 : 20,
        fireball: response === "deflect" && responses < 3
          ? { id: 99, name: "fireball", position: { x: 1, y: 65, z: 0 }, distance: 1 } : null }),
      fight: async () => {
        respond();
        return responses >= 3 ? result("died", 1)
          : { ...result("cancelled", 0), kind: "response_required", observation: "Reconsider the response." };
      },
      deflect: async () => { respond(); },
      recover: async () => { respond(); return { kind: "recovered" }; },
    });
    const outcome = await clock.settle(pending, 500);
    assert.equal(timerBeforeThird, true, "the zero-delay timer ran before the third response");
    assert.equal(outcome.kind, "died");
    assert.equal(clock.pendingTimers(), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
  });
}

test("a response that took a tick does not wait", async () => {
  const { bot } = createFakeBot();
  let ticks = 0, fights = 0;
  const outcome = await runEngagement(new AbortController().signal, {
    ...operations(bot),
    ticks: () => ticks,
    nextTick: async () => { assert.fail("A response that already took a tick must not wait again."); },
    fight: async () => {
      ticks++;
      return ++fights === 2 ? result("died", 1)
        : { ...result("cancelled", 0), kind: "response_required", observation: "Reconsider after a tick." };
    },
    recover: async () => { assert.fail("No recovery selected."); },
  });
  assert.equal(outcome.kind, "died");
});

test("an abort during the next tick cancels once and removes the wait even with physics stopped", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const harness = createFakeBot({ clock });
  const { bot } = harness;
  bot.physicsEnabled = false;
  harness.server.stop();
  const age = bot.time.age;
  const added = listenersAddedSince(bot);
  const request = new AbortController();
  let waiting = false, settlements = 0, fights = 0;
  const pending = runEngagement(request.signal, {
    ...operations(bot),
    nextTick: () => { waiting = true; return waitForPhysicsTicks(bot, 1, request.signal); },
    fight: async () => {
      if (++fights === 10_000) request.abort("same-tick spin");
      return { ...result("cancelled", 0), kind: "response_required", observation: "Reconsider now." };
    },
    recover: async () => { assert.fail("No recovery selected."); },
  });
  void pending.then(() => { settlements++; });
  await clock.advance(0);
  assert.equal(waiting, true, "cancellation happens with the next-tick wait armed");
  assert.equal(added("physicsTick"), 1);
  request.abort("a successor took the body");
  assert.equal((await clock.settle(pending, 50)).kind, "cancelled");
  await clock.advance(100);
  assert.equal(bot.time.age, age);
  assert.equal(settlements, 1);
  assert.equal(added("physicsTick"), 0);
  assert.equal(clock.pendingGlobalTimers(), 0);
});

for (const exit of ["normal", "abort", "throw"] as const) {
  test(`a mob engagement removes its tick listener after ${exit}`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { bot } = createFakeBot({ clock, carried: { diamond_sword: 1 },
      entities: { 7: { name: "cow", position: new Vec3(2, 64, 0) } } });
    await using navigation = createNavigationRuntime(bot);
    using perception = new CombatPerception(bot);
    using footingRecovery = new FootingRecovery(bot, navigation.world);
    using _pace = serverTickPace(bot);
    using _readiness = swingReadiness(bot);
    const added = listenersAddedSince(bot);
    const clientAdded = listenersAddedSince(bot._client);
    const request = new AbortController();
    const failure = new Error("fight setup failed");
    let positions = 0, settlements = 0;
    const pending = runMobEngagement({ bot, navigation, perception, footingRecovery,
      policy: new SurvivalPolicyState(bot), survival: survivalResources(), reportDecision: () => {} },
    7, "pursue", request.signal, {
      position: () => {
        positions++;
        assert.ok(added("physicsTick") > 0, "the engagement observes ticks during the fight");
        if (exit === "throw") throw failure;
        if (exit === "abort") request.abort("caller cancelled");
      },
      execution: () => {}, policyUse: () => {},
    });
    void pending.then(() => { settlements++; }, () => { settlements++; });
    if (exit === "normal") bot.entities[7]!.isValid = false;
    if (exit === "throw") await clock.settle(assert.rejects(pending, failure), 1_000);
    else assert.equal((await clock.settle(pending, 1_000)).kind, exit === "abort" ? "cancelled" : "target_lost");
    assert.equal(positions, 1, "the physical fight was entered");
    await clock.advance(100);
    assert.equal(settlements, 1);
    assert.equal(added("physicsTick"), 0);
    assert.equal(clientAdded("explosion"), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
  });
}

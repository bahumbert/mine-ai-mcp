import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { ActionRunner } from "../../session/action-runner.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { ReflexDriver } from "../control/driver.js";
import { SurvivalPolicyState } from "../state/survival-policy.js";
import { attachDragonReflex } from "./dragon.js";

test("idle dragon defense claims one body, leaves active combat alone, and awaits cancellation cleanup", async () => {
  const { bot, clock } = createFakeBot({ username: "DragonReflex", position: new Vec3(0, 64, 0) });
  const runner = new ActionRunner({ clock });
  const driver = new ReflexDriver(bot, runner, { now: clock.now });
  let active: number | null = 42,
    calls = 0,
    released = false;
  const reflex = attachDragonReflex(bot, driver, {
    policy: new SurvivalPolicyState(bot),
    activeEngagement: () => (active === null ? null : { kind: "mob", targetId: active }),
    endDanger: () => true,
    async runEnd(request, signal) {
      calls++;
      assert.equal(request.kind, "evade");
      assert.equal(runner.status().owner, "takeover");
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      released = true;
      return { outcome: "stopped", reason: "cancelled", attacks: 0, healthBefore: null, healthAfter: null };
    },
  });
  await clock.advance(50);
  assert.equal(calls, 0);
  active = null;
  await clock.advance(50);
  await clock.advance(50);
  assert.equal(calls, 1);
  await reflex[Symbol.asyncDispose]();
  await driver[Symbol.asyncDispose]();
  assert.equal(released, true);
  assert.equal(bot.listenerCount("physicsTick"), 0);
  assert.equal(runner.status().owner, "idle");
});

test("prohibited dragon retreat stands down and a permitted policy revision re-arms it", async () => {
  const { bot, clock } = createFakeBot({ username: "DragonPolicy", position: new Vec3(0, 64, 0) });
  const runner = new ActionRunner({ clock });
  const driver = new ReflexDriver(bot, runner, { now: clock.now });
  const policy = new SurvivalPolicyState(bot);
  let calls = 0;
  const reflex = attachDragonReflex(bot, driver, {
    policy,
    activeEngagement: () => null,
    endDanger: () => true,
    async runEnd(_request, signal) {
      calls++;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { outcome: "stopped", reason: "cancelled", attacks: 0, healthBefore: null, healthAfter: null };
    },
  });
  try {
    await policy.edit({
      operation: "set",
      expected_revision: policy.snapshot().revision,
      changes: { combat: { retreat: false } },
      lifetime: { kind: "session" },
      reason: "test",
    });
    await clock.advance(50);
    assert.equal(calls, 0);
    assert.equal(runner.status().owner, "idle");
    assert.deepEqual(driver.snapshot()[0]?.decision, {
      kind: "stand_down",
      candidates: [{ response: "evade", excluded: { kind: "prohibited", field: "retreat" } }],
    });
    await policy.edit({ operation: "reset", expected_revision: policy.snapshot().revision, reason: "test" });
    await clock.advance(50);
    assert.equal(calls, 1);
    assert.equal(runner.status().owner, "takeover");
  } finally {
    await reflex[Symbol.asyncDispose]();
    await driver[Symbol.asyncDispose]();
  }
});

test("the dragon evade with no progress is released after 30 s and stands down 10 s", async () => {
  const { bot, clock } = createFakeBot({ username: "DragonLimit", position: new Vec3(0, 64, 0) });
  const runner = new ActionRunner({ clock, cancelGraceMs: 500 });
  const driver = new ReflexDriver(bot, runner, { now: clock.now });
  let calls = 0;
  const reflex = attachDragonReflex(bot, driver, {
    policy: new SurvivalPolicyState(bot),
    activeEngagement: () => null,
    endDanger: () => true,
    async runEnd(_request, signal) {
      calls++;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { outcome: "stopped", reason: "cancelled", attacks: 0, healthBefore: null, healthAfter: null };
    },
  });
  const pass = (ms: number) => clock.advance(ms);
  await pass(29_000);
  assert.equal(runner.status().activeAction?.action, "dragon_reflex", "29 s: the window is open");
  await pass(2_000);
  assert.equal(runner.status().owner, "idle", "released at 30 s without hurt, travel or a blocked hit");
  const callsAtRelease = calls;
  await pass(9_000);
  assert.equal(calls, callsAtRelease, "no new evade within the 10 s stand-down");
  await pass(2_000);
  assert.equal(calls, callsAtRelease + 1, "after it, the reflex evades again");
  await reflex[Symbol.asyncDispose]();
  await driver[Symbol.asyncDispose]();
});

test("the dragon evade is kept alive by damage taken and by a blocked hit", async () => {
  const { bot, clock, combat } = createFakeBot({ username: "DragonHurt", position: new Vec3(0, 64, 0) });
  const runner = new ActionRunner({ clock, cancelGraceMs: 500 });
  const driver = new ReflexDriver(bot, runner, { now: clock.now });
  const reflex = attachDragonReflex(bot, driver, {
    policy: new SurvivalPolicyState(bot),
    activeEngagement: () => null,
    endDanger: () => true,
    async runEnd(_request, signal) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { outcome: "stopped", reason: "cancelled", attacks: 0, healthBefore: null, healthAfter: null };
    },
  });
  for (let step = 0; step < 90 * 20; step++) {
    if (step % (25 * 20) === 0 && step > 0) combat.hurtBot(1, null);
    if (step % (25 * 20) === 12 * 20) bot._client.emit("entity_status", { entityId: 1, entityStatus: 29 });
    await clock.advance(50);
  }
  assert.equal(runner.status().activeAction?.action, "dragon_reflex", "a mark every 12 s for 90 s: never cut");
  await reflex[Symbol.asyncDispose]();
  await driver[Symbol.asyncDispose]();
});

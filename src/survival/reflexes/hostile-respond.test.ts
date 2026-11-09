// Seated hostile sensing and the bounded boat preparation before a hostile response.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { ActionRunner } from "../../session/action-runner.js";
import { attackedIds, engagingCombat, unexpectedEngage } from "../../test-support/combat.js";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { ReflexDriver } from "../control/driver.js";
import { CombatPerception } from "../perception/combat/observations.js";
import type { HostileScene } from "./hostile-scene.js";
import { attachHostileReflex } from "./hostile.js";
import { HOSTILE_TAKE_BACK_HITS, respondToHostile } from "./hostile-respond.js";

/** The real response and reflex services around one shared fake bot. */
function responseFixture(occluded = false) {
  const harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    position: new Vec3(0.5, 64, 0.5),
    cells: occluded ? { "4,64,0": "stone", "4,65,0": "stone", "4,66,0": "stone" } : undefined,
    entities: {
      7: { name: "oak_boat", position: new Vec3(0.5, 64, 0.5) },
      8: { name: "zombie", position: new Vec3(occluded ? 10.5 : 100.5, 64, 0.5) },
    },
  });
  const { bot, clock } = harness;
  const navigation = { cancel: () => undefined } as unknown as NavigationRuntime;
  const controller = engagingCombat(bot, unexpectedEngage);
  const runner = new ActionRunner({ clock });
  const driver = new ReflexDriver(bot, runner, { now: clock.now });
  const perception = new CombatPerception(bot);
  const reflex = attachHostileReflex(bot, driver, navigation, controller, perception);
  const scene: HostileScene = {
    bot, navigation, controller, driver, perception, policy: controller.policy,
    context: reflex.threats, encounterThreats: new Set(), activeResponse: null,
    transition: (pending) => { void pending; },
  };
  return { ...harness, driver, perception, scene, async [Symbol.asyncDispose]() {
    await reflex[Symbol.asyncDispose]();
    await driver[Symbol.asyncDispose]();
    perception[Symbol.dispose]();
  } };
}

for (const { hit, occluded, name } of [
  { hit: false, occluded: false, name: "the hostile reflex senses a zombie while seated" },
  { hit: true, occluded: false, name: "an attacker id is recorded from a hit while seated" },
  { hit: false, occluded: true, name: "the seated hostile reflex notices a mob moving into view after a cached hidden observation" },
]) {
  test(name, async () => {
    await using fixture = responseFixture(occluded);
    using _clock = fixture.clock.install();
    const { bot, clock, combat, driver, perception } = fixture;
    const sensed: boolean[] = [];
    driver.onTransition((event) => {
      if (event.kind === "danger") sensed.push(bot.vehicle?.id === 7);
    });
    bot.mount(bot.entities[7]!);
    await clock.advance(occluded ? 150 : 50);
    if (occluded) assert.equal(perception.read().find((entity) => entity.id === 8)?.visible, false);
    bot.entities[8]!.position.x = 2.5;
    if (hit) combat.hurtBot(1, 8);
    await clock.advance(100);
    assert.ok(sensed.includes(true), "the seated tick must observe the zombie");
    const danger = driver.snapshot()[0]!.danger as { threats: readonly { id: number; confirmedAttacker: boolean }[] } | null;
    assert.ok(danger?.threats.some((threat) => threat.id === 8 && threat.confirmedAttacker === hit), "a seated observation must refresh a cached hidden threat");
  });
}

test("a cancel during get-off ends it at once", async () => {
  await using fixture = responseFixture();
  using _clock = fixture.clock.install();
  const { bot, clock, server, scene } = fixture;
  // Directly exercise response preparation; the reflex itself must not start another response.
  await fixture.driver[Symbol.asyncDispose]();
  bot.mount(bot.entities[7]!);
  await clock.advance(50);
  server.stop();
  const added = listenersAddedSince(bot);
  const clientListeners = bot._client.listenerCount("set_passengers");
  const abort = new AbortController();
  const pending = respondToHostile(scene, { kind: "fight", targetId: 8, threats: [] }, abort.signal);
  await clock.advance(50);
  abort.abort(new Error("cancel during get-off"));
  let ended = false;
  void pending.then(() => { ended = true; });
  await clock.advance(1);
  assert.equal(ended, true, "cancel must settle without waiting for a server tick or the 15 s wall bound");
  assert.equal((await pending).kind, "cancelled");
  assert.equal(bot.controlState.sneak, false);
  assert.equal(added("dismount") + added("forcedMove") + added("death") + added("respawn") + added("entityGone"), 0);
  assert.equal(bot._client.listenerCount("set_passengers"), clientListeners);
  assert.deepEqual(attackedIds(server), []);
  assert.equal(scene.activeResponse, null);
});

test("near shore the take-back stops at HOSTILE_TAKE_BACK_HITS hits", async () => {
  await using fixture = responseFixture();
  using _clock = fixture.clock.install();
  const { bot, clock, server, scene } = fixture;
  await fixture.driver[Symbol.asyncDispose]();
  bot.entity.position.y = 64 + bot.entities[7]!.height;
  server.onPacket("use_entity", (data) => {
    if ((data as { mouse: number }).mouse === 1) server.stop();
  });
  const pending = respondToHostile(scene, { kind: "fight", targetId: 8, threats: [] }, new AbortController().signal);
  await clock.settle(pending, 30_000);
  assert.equal(attackedIds(server).filter((id) => id === 7).length, HOSTILE_TAKE_BACK_HITS);
  assert.ok(bot.entities[7], "a stalled server leaves the boat for the next movement");
});

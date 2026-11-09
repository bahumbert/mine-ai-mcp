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
import { mountedSea, vehicleMoves, wroteAShift } from "../../actions/navigate/boat-fixtures.test.js";
import type { HostileResponse } from "../policy/combat/response.js";
import { respondToHostileFromBoat } from "./hostile-boat-response.js";
import { observeCombatDecision } from "../control/combat/observation.js";
import { decideCombatResponse } from "../policy/combat/decision.js";
import { senseHostile } from "./hostile-sense.js";

test("a hurt boat rider beside a beach keeps hide available in the sensed decision", async () => {
  for (const moving of [false, true]) {
    const harness = moving ? await mountedSea({ landFromZ: 60,
      entities: { 8: { name: "zombie", position: new Vec3(2.5, 63, 3.5) } } }) : undefined;
    await using fixture = responseFixture(false, harness);
    using _clock = fixture.clock.install();
    await fixture.driver[Symbol.asyncDispose]();
    if (!moving) {
      fixture.bot.mount(fixture.bot.entities[7]!);
      await fixture.clock.advance(100);
      fixture.bot.entities[8]!.position.x = 2.5;
    }
    fixture.bot.health = 6;
    if (moving) {
      assert.equal(senseHostile(fixture.scene)?.danger.facts.hideAllowed, false);
      fixture.bot.entities[7]!.position.z = 58;
      fixture.bot.entity.position.z = 58;
      fixture.bot.entities[8]!.position.z = 56;
    }
    assert.equal(observeCombatDecision(fixture.bot, fixture.scene.context).hideAllowed, true);
    assert.equal(senseHostile(fixture.scene)?.danger.facts.hideAllowed, true, "a moved seat must use the current beach");
  }
});

/** The real response and reflex services around one shared fake bot. */
function responseFixture(occluded = false, harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    position: new Vec3(0.5, 64, 0.5),
    cells: occluded ? { "4,64,0": "stone", "4,65,0": "stone", "4,66,0": "stone" } : undefined,
    entities: {
      7: { name: "oak_boat", position: new Vec3(0.5, 64, 0.5) },
      8: { name: "zombie", position: new Vec3(occluded ? 10.5 : 100.5, 64, 0.5) },
    },
  })) {
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
    const fixture = responseFixture(occluded);
    using _clock = fixture.clock.install();
    const { bot, clock, combat, driver, perception } = fixture;
    try {
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
    } finally {
      await clock.settle(fixture[Symbol.asyncDispose](), 30_000);
    }
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

for (const kind of ["fight", "evade", "hide", "death", "abort"] as const) {
  test(`seated at sea ${kind} responds without taking the boat back`, async () => {
    await using fixture = responseFixture(false, await mountedSea({
      carries: ["iron_sword"], entities: { 8: { name: "zombie", position: new Vec3(2.5, 62.5, 3.5) } },
    }));
    using _clock = fixture.clock.install();
    const { bot, clock, scene, combat, server } = fixture;
    await fixture.driver[Symbol.asyncDispose]();
    const threat = { id: 8, name: "zombie", position: { x: 2.5, y: 62.5, z: 3.5 }, distance: 2 };
    const directive: HostileResponse = kind === "evade"
      ? { kind, threats: [threat], reason: "hurt", safeRange: 36 }
      : kind === "hide" ? { kind, threats: [threat], reason: "hurt" }
      : { kind: "fight", targetId: 8, threats: [threat] };
    const abort = new AbortController();
    if (kind === "death") clock.after(200, () => combat.setHealth(0));
    else if (kind === "abort") clock.after(200, () => abort.abort(new Error("cancel seated equip")));
    else clock.after(1_500, () => combat.kill(8));
    const settlement = await clock.settle(respondToHostile(scene, directive, abort.signal), 30_000);
    assert.equal(settlement.kind, kind === "death" ? "bot_died" : kind === "abort" ? "cancelled" : "completed");
    assert.equal(attackedIds(server).includes(7), false, "the seat is never attacked");
    assert.equal(wroteAShift(fixture), false, "the hostile response never shifts off the seat");
    if (kind === "fight") {
      assert.ok(attackedIds(server).includes(8));
      assert.equal(bot.vehicle?.id, 7);
      assert.ok(settlement.evidence.attacks > 0);
    }
    if (kind === "evade" || kind === "hide") {
      assert.deepEqual(attackedIds(server), [], "evade and hide row only, even with a mob in reach");
      assert.ok(vehicleMoves(fixture).length > 0);
    }
    assert.equal(scene.activeResponse, null);
  });
}

test("near shore the prepare path runs", async () => {
  await using fixture = responseFixture(false, await mountedSea({ landUntilZ: 2 }));
  using _clock = fixture.clock.install();
  await fixture.driver[Symbol.asyncDispose]();
  const settlement = await fixture.clock.settle(respondToHostile(fixture.scene,
    { kind: "fight", targetId: 8, threats: [] }, new AbortController().signal), 30_000);
  assert.equal(fixture.bot.vehicle, null);
  assert.ok(attackedIds(fixture.server).includes(7));
  assert.notEqual(settlement.kind, "cancelled");
});

test("a seated fight attacks only the selected authorized target among avoidance contacts", async () => {
  await using fixture = responseFixture(false, await mountedSea({ carries: ["iron_sword"], entities: {
    8: { name: "piglin", position: new Vec3(1.5, 62.5, 3.5) },
    9: { name: "zombie", position: new Vec3(2.5, 62.5, 3.5) },
  } }));
  using _clock = fixture.clock.install();
  await fixture.driver[Symbol.asyncDispose]();
  const flags = fixture.bot.registry.entitiesByName.piglin!.metadataKeys?.indexOf("mob_flags") ?? -1;
  assert.ok(flags >= 0);
  Reflect.set(fixture.bot.entities[8]!.metadata, flags, 4);
  const directive = decideCombatResponse(observeCombatDecision(fixture.bot, fixture.scene.context), { kind: "automatic", quarry: ["zombie"] });
  assert.equal(directive.kind, "fight");
  if (directive.kind !== "fight") throw new Error("fixture did not select a fight");
  assert.equal(directive.targetId, 9);
  fixture.clock.after(1_000, () => { fixture.combat.kill(8); fixture.combat.kill(9); });
  await fixture.clock.settle(respondToHostileFromBoat(fixture.scene, directive, 20, new AbortController().signal), 30_000);
  assert.deepEqual([...new Set(attackedIds(fixture.server))], [9]);
});

test("a seated deflection reports the observed projectile reversal", async () => {
  await using fixture = responseFixture(false, await mountedSea());
  using _clock = fixture.clock.install();
  await fixture.driver[Symbol.asyncDispose]();
  const ball = fixture.combat.launchFireball(new Vec3(2.5, 64, 3.5), new Vec3(-0.1, 0, 0));
  const incoming = ball.velocity.clone();
  let reversed = false;
  fixture.bot.on("entityMoved", (entity) => { if (entity.id === ball.id && entity.velocity.dot(incoming) < 0) reversed = true; });
  const settlement = await fixture.clock.settle(respondToHostile(fixture.scene, { kind: "deflect", targetId: ball.id,
    threats: [{ id: ball.id, name: "fireball", position: ball.position, distance: 2 }], reason: "incoming_fireball" }, new AbortController().signal), 30_000);
  assert.equal(reversed, true);
  assert.equal(settlement.physical?.result.kind, "reflected");
});

test("seated settlement retains strikes, deaths and explosions across completion, cancel and death", async () => {
  for (const end of ["completed", "cancelled", "bot_died"] as const) {
    await using fixture = responseFixture(false, await mountedSea({ carries: ["iron_sword"], entities: {
      8: { name: "zombie", position: new Vec3(2.5, 62.5, 3.5) },
      9: { name: "zombie", position: new Vec3(3.5, 62.5, 3.5) },
    } }));
    using _clock = fixture.clock.install();
    await fixture.driver[Symbol.asyncDispose]();
    const abort = new AbortController();
    const before = fixture.bot._client.listenerCount("explosion");
    fixture.clock.after(900, () => { fixture.combat.explode(new Vec3(10.5, 62.5, 3.5)); fixture.combat.kill(9); });
    fixture.clock.after(1_100, () => {
      if (end === "completed") fixture.combat.kill(8);
      else if (end === "cancelled") abort.abort(new Error("cancel after strike"));
      else { fixture.combat.setHealth(0); abort.abort(new Error("cancel at death")); }
    });
    const threats = [8, 9].map((id) => ({ id, name: "zombie", position: fixture.bot.entities[id]!.position, distance: 2 }));
    const settlement = await fixture.clock.settle(respondToHostile(fixture.scene, { kind: "fight", targetId: 8, threats }, abort.signal), 30_000);
    assert.equal(settlement.kind, end);
    assert.ok(attackedIds(fixture.server).length > 0);
    assert.equal(settlement.evidence.attacks, attackedIds(fixture.server).length);
    assert.ok(settlement.evidence.killedTargetIds.includes(9));
    assert.equal(settlement.evidence.explosions, 1);
    assert.deepEqual(settlement.evidence.weaponsUsed, ["iron_sword"]);
    assert.equal(fixture.bot._client.listenerCount("explosion"), before);
  }
});

test("near shore a stalled server ends preparation without queueing take-back hits", async () => {
  await using fixture = responseFixture();
  using _clock = fixture.clock.install();
  const { bot, clock, server, scene } = fixture;
  await fixture.driver[Symbol.asyncDispose]();
  bot.entity.position.y = 64 + bot.entities[7]!.height;
  server.onPacket("use_entity", (data) => {
    if ((data as { mouse: number }).mouse === 1) server.stop();
  });
  const pending = respondToHostile(scene, { kind: "fight", targetId: 8, threats: [] }, new AbortController().signal);
  const result = await clock.settle(pending, 30_000);
  assert.equal(result.kind, "failed");
  assert.match(result.reason ?? "", /BOAT_TAKE_BACK_FAILED/);
  assert.ok(attackedIds(server).filter((id) => id === 7).length < HOSTILE_TAKE_BACK_HITS);
  assert.ok(bot.entities[7], "a stalled server leaves the boat for the next movement");
});

// Hostile response settlement, occupied shelters, and bounded boat preparation.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { z } from "zod";
import { actionResultSchema, defineAction } from "../../actions/action.js";
import type { NavigationRuntime } from "../../navigation/index.js";
import { exactBlockGoal } from "../../navigation/goals/index.js";
import { createMovementPolicy } from "../../navigation/movements/policy.js";
import { ActionRunner } from "../../session/action-runner.js";
import { attackedIds, combatTestContext, engagingCombat, unexpectedEngage } from "../../test-support/combat.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { recoverCombatHealth } from "../control/combat/recovery.js";
import { secureCombatHandoff } from "../control/combat/handoff.js";
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
import { ThreatChains } from "../state/threat-chains.js";
import { RequestStalls } from "../state/request-stall.js";
import { describeResponse, responseContinuation } from "../control/combat/settlement.js";
import { serverTickPace } from "../../world/server-tick-pace.js";
import { swingReadiness } from "../weapons/swing-readiness.js";
import { serverPacedWallMs, waitForServerTicks } from "../../world/world-age.js";
import { COMBAT_LIMITS } from "../control/combat/limits.js";

for (const recovery of [true, false]) test(recovery
  ? "recovery's evade that separates in its start cell is no new recovery cell"
  : "the handoff still requires physical safety after an early separation", async () => {
  const { bot, clock } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }),
    groundY: 63, position: new Vec3(0.5, 64, 0.5),
    entities: { 7: { name: "zombie", position: new Vec3(17.5, 64, 0.5) } } });
  using _installed = clock.install();
  bot.health = 6;
  using perception = new CombatPerception(bot);
  const context = { ...combatTestContext(bot), perception, attackerIds: new Set([7]) };
  const policy = { ...context.policy, hide: "never" as const };
  const world = new MemoryWorld();
  for (let y = 63; y <= 65; y++) world.load({ x: 0, y, z: 0 }, { stateId: y === 63 ? 1 : 0 });
  let routes = 0;
  const navigation = { world, navigate: async () => {
    routes++;
    await clock.sleep(2_000);
    return { status: "stopped" as const, reason: "navigation timeout", elapsedMs: 2_000 };
  } } as unknown as NavigationRuntime;
  if (!recovery) Reflect.set(bot.entity.metadata, 0, 1); // entity flags: burning, as entities.js reads them
  const pending = (recovery ? recoverCombatHealth : secureCombatHandoff)(
    bot, navigation, { ...context, policy }, new AbortController().signal, () => {});
  const result = await clock.settle<Awaited<ReturnType<typeof recoverCombatHealth | typeof secureCombatHandoff>>>(pending, 4_000);
  assert.equal(routes, 1, "the evade must actually run before its caller judges the new basis");
  assert.equal(result.kind, recovery ? "blocked" : "unsafe");
  if (recovery) {
    assert.ok(context.survival.answered.snapshot().some((entry) => entry.failure.kind === "escape_failed"));
    assert.match("observation" in result ? result.observation : "", /different recovery cell/);
  } else if (result.kind === "unsafe") {
    assert.ok(result.reason.includes("Withdrawal: separated"));
  }
});

test("a hurt boat rider beside a beach keeps hide available in the sensed decision", async () => {
  for (const moving of [false, true]) {
    const harness = moving ? await mountedSea({ landFromZ: 60,
      entities: { 8: { name: "zombie", position: new Vec3(2.5, 63, 3.5) } } }) : undefined;
    await using fixture = responseFixture(false, harness);
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
  }), navigation = { cancel: () => undefined } as unknown as NavigationRuntime) {
  const { bot, clock } = harness;
  const timers = clock.install();
  const controller = engagingCombat(bot, unexpectedEngage);
  const runner = new ActionRunner({ clock });
  const driver = new ReflexDriver(bot, runner, { now: clock.now });
  const perception = new CombatPerception(bot);
  const reflex = attachHostileReflex(bot, driver, navigation, controller, perception);
  const scene: HostileScene = {
    bot, navigation, controller, driver, perception, policy: controller.policy,
    context: reflex.threats, encounterThreats: new Set(), activeResponse: null, chains: new ThreatChains(), stalls: new RequestStalls(),
    transition: (pending) => { void pending; },
  };
  return { ...harness, driver, perception, scene, async [Symbol.asyncDispose]() {
    await reflex[Symbol.asyncDispose]();
    await driver[Symbol.asyncDispose]();
    perception[Symbol.dispose]();
    timers[Symbol.dispose]();
  } };
}

/** The real occupied-shell refusal and follow-up, borrowing the existing response services. */
function occupiedShelterFixture(ticksPerSecond: number, onRoute: NavigationRuntime["navigate"]) {
  const harness = createFakeBot({ clock: createFakeClock({ mode: "mocked" }),
    server: { ticksPerSecond, startAge: 1_000 }, position: new Vec3(0.5, 64, 0.5),
    health: 2, carried: { cobblestone: 32, diamond_sword: 1 },
    cells: { "0,63,0": "bedrock", "0,66,0": "stone", "1,65,0": "stone",
      "-1,64,0": "stone", "-1,65,0": "stone", "0,64,1": "stone", "0,65,1": "stone",
      "0,64,-1": "stone", "0,65,-1": "stone" },
    entities: { 61: { name: "blaze", kind: "Hostile mobs", position: new Vec3(1.5, 64, 0.5) } } });
  const navigation = { world: new MemoryWorld(), cancel: () => undefined, navigate: onRoute } as unknown as NavigationRuntime;
  const fixture = responseFixture(false, harness, navigation);
  const remember = fixture.driver.answered.remember.bind(fixture.driver.answered);
  fixture.driver.answered.remember = (scope, failure, temporal) => {
    const entry = remember(scope, failure, temporal);
    if (scope.response === "hide") {
      // A clear sensor seam admits the fresh decision, after real construction saw the occluded intruder (T7).
      fixture.bot.world.raycast = () => null;
      fixture.combat.hurt(61, null, 1);
    }
    return entry;
  };
  return fixture;
}

for (const ticksPerSecond of [20, 10]) for (const ending of ["old", "new", "cancel", "death"] as const)
test(`occupied-shelter separation clears only old attack contact after ${ending} (${ticksPerSecond} tps)`, async () => {
  const abort = new AbortController();
  let routes = 0;
  await using fixture = occupiedShelterFixture(ticksPerSecond, async ({ signal }) => {
    if (++routes === 1) {
      if (ending === "new") {
        const age = fixture.bot.time.age;
        assert.equal(await waitForServerTicks(fixture.bot, 20, { signal }), "moved");
        assert.equal(fixture.bot.time.age - age, 20, "the old hurt window has elapsed on the server");
        let observed = false;
        const hurt = () => { observed = true; };
        fixture.bot.once("entityHurt", hurt);
        try { fixture.combat.hurtBot(0.1, 61); assert.ok(observed, "the new attributed hit was actually announced"); }
        finally { fixture.bot.off("entityHurt", hurt); }
      }
      fixture.bot.entities[61]!.position.x = 100;
      if (ending === "cancel") abort.abort(new Error("Cancel nested separation"));
      if (ending === "death") fixture.combat.setHealth(0);
    }
    return { status: "completed", elapsedMs: 0 };
  });
  await fixture.driver[Symbol.asyncDispose]();
  const added = listenersAddedSince(fixture.bot);
  const timers = fixture.clock.pendingTimers();
  const globals = fixture.clock.pendingGlobalTimers();
  fixture.combat.hurtBot(0.1, 61);
  assert.equal(fixture.perception.attackerIds.has(61), true);
  const threat = { id: 61, name: "blaze", position: { x: 1.5, y: 64, z: 0.5 }, distance: 1 };
  const settlement = await fixture.clock.settle(respondToHostile(fixture.scene,
    { kind: "hide", reason: "hurt", threats: [threat] }, abort.signal), 15_000);
  assert.equal(routes, 1, "the occupied shell must actually run its evade");
  assert.equal(settlement.kind, ending === "cancel" ? "cancelled" : ending === "death" ? "bot_died" : "completed");
  if (ending === "old" || ending === "new") {
    assert.equal(settlement.response, "evade");
    assert.equal(settlement.physical?.response, "hide", "keep the original refusal alongside the successful follow-up");
    assert.equal(responseContinuation(settlement).kind, "resume");
  }
  assert.equal(fixture.perception.attackerIds.has(61), ending !== "old", "only successful separation answers old contact");
  await fixture.clock.advance(5 * 1_000 / ticksPerSecond);
  if (ending === "old") assert.equal(senseHostile(fixture.scene), null, "the loaded old attacker must not demand another response");
  if (ending === "new") assert.ok(senseHostile(fixture.scene)?.danger.facts.contacts.some(contact => contact.id === 61));
  for (const event of ["entityHurt", "physicsTick", "time", "entityGone", "death"]) assert.equal(added(event), 0, event);
  fixture.entities.remove(61);
  if (ending === "death") fixture.combat.setHealth(20);
  const input = z.object({});
  const navigate = defineAction({ name: "navigate", description: "Navigate after an occupied shelter",
    inputSchema: input, resultSchema: actionResultSchema({}), parse: value => input.parse(value), formatResult: result => result.status,
    execution: { kind: "resumable_task" }, begin: () => async () => {
      const route = await fixture.scene.navigation.navigate({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 60, y: 64, z: 0 }) });
      return route.status === "completed" ? { status: "succeeded" as const } : { status: "failed" as const, error: `route ${route.status}` };
    } });
  assert.equal((await fixture.clock.settle(fixture.driver.runner.run(navigate, {}), 1_000)).result.status, "succeeded");
  assert.equal(routes, 2);
  await fixture.clock.advance(serverPacedWallMs(COMBAT_LIMITS.ceilingTicks) + 1, 1_000);
  assert.equal(routes, 2, "retired response deadlines cannot restart the old evade");
  assert.equal(fixture.clock.pendingTimers(), timers);
  assert.equal(fixture.clock.pendingGlobalTimers(), globals);
  for (const event of ["entityHurt", "physicsTick", "time", "entityGone", "death"]) assert.equal(added(event), 0, event);
});

test("a second evade on the same zombie carries its chain into the settled text", async () => {
  const harness = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), groundY: 63,
    position: new Vec3(0.5, 64, 0.5), entities: { 8: { name: "zombie", position: new Vec3(4.5, 64, 0.5) } } });
  const navigation = { world: new MemoryWorld(), cancel: () => undefined, navigate: async () => {
    harness.bot.entity.position.x -= 6;
    return { status: "stopped", reason: "no path", elapsedMs: 0 };
  } } as unknown as NavigationRuntime;
  await using fixture = responseFixture(false, harness, navigation);
  await fixture.driver[Symbol.asyncDispose]();
  const evade = () => respondToHostile(fixture.scene, { kind: "evade", reason: "hurt", safeRange: 36,
    threats: [{ id: 8, name: "zombie", position: harness.bot.entities[8]!.position,
      distance: 1 }] }, new AbortController().signal);
  const first = await fixture.clock.settle(evade(), 1_000);
  assert.equal(first.chain, null);
  const second = await fixture.clock.settle(evade(), 1_000);
  assert.equal(second.chain?.responses, 2);
  assert.equal(second.chain?.evades, 2);
  assert.equal(second.chain?.gained, 12, "evades use the entry observation rather than the earlier decision distance");
  assert.equal(second.physical?.response === "evade" ? second.physical.result.kind : null, "exhausted");
  const continuation = responseContinuation(second);
  assert.equal(continuation.kind, "hold");
  assert.match(continuation.kind === "hold" ? continuation.reason : "", /2nd response to zombie#8/);
  assert.deepEqual(JSON.parse(JSON.stringify(describeResponse(second))).chain, second.chain);
});

test("a cancelled response is recorded once", async () => {
  await using fixture = responseFixture(false, createFakeBot({ clock: createFakeClock({ mode: "mocked" }),
    entities: { 8: { name: "zombie", position: new Vec3(4.5, 64, 0.5) } } }));
  await fixture.driver[Symbol.asyncDispose]();
  const directive: HostileResponse = { kind: "fight", targetId: 8,
    threats: [{ id: 8, name: "zombie", position: fixture.bot.entities[8]!.position, distance: 4 }] };
  const signal = AbortSignal.abort(new Error("caller cancelled"));
  const first = await respondToHostile(fixture.scene, directive, signal);
  const second = await respondToHostile(fixture.scene, directive, signal);
  assert.equal(first.kind, "cancelled");
  assert.equal(first.chain, null);
  assert.equal(second.chain?.responses, 2);
  assert.equal(second.chain?.evades, 0);
});

for (const { hit, occluded, name } of [
  { hit: false, occluded: false, name: "the hostile reflex senses a zombie while seated" },
  { hit: true, occluded: false, name: "an attacker id is recorded from a hit while seated" },
  { hit: false, occluded: true, name: "the seated hostile reflex notices a mob moving into view after a cached hidden observation" },
]) {
  test(name, async () => {
    const fixture = responseFixture(occluded);
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
    const { bot, clock, scene, combat, server } = fixture;
    await fixture.driver[Symbol.asyncDispose]();
    using _pace = serverTickPace(bot);
    using _readiness = swingReadiness(bot);
    await clock.advance(4_000);
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
      assert.equal(settlement.physical?.response, "evade");
      if (settlement.physical?.response === "evade") {
        assert.equal(settlement.physical.goalRefreshes, 0);
        assert.ok(settlement.physical.elapsedMs > 0);
        assert.equal(settlement.physical.elapsedTicks, null, "the seated evade still counts real milliseconds");
        assert.equal((describeResponse(settlement) as Record<string, unknown>).elapsedTicks, null, "its receipt says so too");
        assert.ok(Number.isFinite(settlement.physical.startPosition.x));
        assert.equal(settlement.physical.ends[0]?.basis, "dead");
      }
    }
    assert.equal(scene.activeResponse, null);
  });
}

test("near shore the prepare path runs", async () => {
  await using fixture = responseFixture(false, await mountedSea({ landUntilZ: 2 }));
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
  await fixture.driver[Symbol.asyncDispose]();
  using _pace = serverTickPace(fixture.bot);
  using _readiness = swingReadiness(fixture.bot);
  await fixture.clock.advance(4_000);
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
  await fixture.driver[Symbol.asyncDispose]();
  using _pace = serverTickPace(fixture.bot);
  using _readiness = swingReadiness(fixture.bot);
  await fixture.clock.advance(4_000);
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
    await fixture.driver[Symbol.asyncDispose]();
    using _pace = serverTickPace(fixture.bot);
    using _readiness = swingReadiness(fixture.bot);
    await fixture.clock.advance(4_000);
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

test("near shore a progressing slow server stops take-back at the hostile hit cap", async () => {
  await using fixture = responseFixture(false, createFakeBot({
    clock: createFakeClock({ mode: "mocked" }), lagMs: 1_100,
    position: new Vec3(0.5, 64, 0.5),
    entities: { 7: { name: "oak_boat", position: new Vec3(0.5, 64, 0.5) },
      8: { name: "zombie", position: new Vec3(100.5, 64, 0.5) } },
  }));
  await fixture.driver[Symbol.asyncDispose]();
  fixture.bot.entity.position.y = 64 + fixture.bot.entities[7]!.height;
  const result = await fixture.clock.settle(respondToHostile(fixture.scene,
    { kind: "fight", targetId: 8, threats: [] }, new AbortController().signal), 60_000);
  assert.equal(result.kind, "failed");
  assert.equal(attackedIds(fixture.server).filter((id) => id === 7).length, HOSTILE_TAKE_BACK_HITS);
});

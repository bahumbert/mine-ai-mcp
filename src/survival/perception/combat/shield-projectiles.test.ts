import assert from "node:assert/strict";
import test from "node:test";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { type FakeHarness, type FakeWorld, createFakeBot, createFakeClock, itemOf, listenersAddedSince } from "../../../test-support/fake-bot/index.js";
import { projectileReachesBody } from "../../positioning/combat/exposure.js";
import { confirmShieldBlock, observeProjectileDefence, projectileShieldFacing } from "../../weapons/shield-facing.js";
import { CombatPerception } from "./observations.js";
import { arrowFlight, trackArrowFlights } from "./arrow-flight.js";
import { arrowImpact, arrowImpactInTicks, incomingShieldProjectiles, isIncomingArrow, projectileThreatensBody } from "./shield-projectiles.js";
import { createNavigationRuntime, createMovements, exactBlockGoal } from "../../../navigation/index.js";
import { guardRetreatProjectiles } from "../../weapons/projectile-guard.js";
import { DEFAULT_COMBAT_POLICY } from "../../policy/combat/contract.js";
import { serverTickPace } from "../../../world/server-tick-pace.js";

for (const rate of [20, 10]) for (const warmth of ["warm", "cold", "no-age"]) for (const stopped of [false, true])
test(`impact three plus grace two hold: ${rate} tps ${warmth} ${stopped ? "stopped" : "running"}`, async () => {
  const { bot, clock, server } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond: rate, timePacketYet: warmth !== "no-age" },
    groundY: null, position: new Vec3(0, 64, 0), entities: { 8: { name: "arrow", position: new Vec3(0, 65, 3), velocity: new Vec3(0, 0, -1) } } });
  using _timers = clock.install();
  const added = listenersAddedSince(bot), packets = listenersAddedSince(bot._client);
  const pace = serverTickPace(bot);
  if (warmth === "warm") await clock.advance(4_000);
  assert.equal(arrowImpact(bot, bot.entities[8]!)!.ticks, 3);
  const initial = observeProjectileDefence(bot)!;
  assert.equal(initial.holdRemainingTicks, 5);
  bot.entities[8]!.velocity.set(0, 0, 0); // No more forecasts; entity remains valid, no block confirmation.
  if (stopped) server.stop();
  const age = bot.time.age, gameTime = server.gameTime;
  const bound = warmth === "warm" ? 5_000 / rate : warmth === "cold" && !stopped && rate === 20 ? 2_000 : 3_750;
  await clock.advance(bound - 1);
  assert.ok(observeProjectileDefence(bot)!.holdRemainingTicks > 0);
  await clock.advance(1);
  assert.equal(observeProjectileDefence(bot), null);
  if (stopped) { assert.equal(server.gameTime, gameTime); assert.equal(bot.time.age, age); }
  confirmShieldBlock(bot);
  pace[Symbol.dispose]();
  await clock.advance(6_000);
  assert.equal(observeProjectileDefence(bot), null, "cleanup cannot revive a held contact");
  serverTickPace(bot)[Symbol.dispose](); // Dispose the inspection's lazy pace observer too.
  for (const event of ["time", "physicsTick", "entitySpawn", "respawn", "heldItemChanged", "mount", "dismount", "death", "end"]) assert.equal(added(event), 0, event);
  for (const event of ["spawn_entity", "entity_velocity", "rel_entity_move", "entity_move_look", "entity_teleport", "sync_entity_position", "entity_destroy"]) assert.equal(packets(event), 0, event);
});

for (const rate of [20, 10]) for (const earlier of [true, false])
test(`a distinct impact respects the one-tick supersession margin: ${rate} tps ${earlier}`, async () => {
  const { bot, clock, entities } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond: rate },
    groundY: null, position: new Vec3(0, 64, 0), entities: { 8: { name: "arrow", position: new Vec3(0, 65, 3), velocity: new Vec3(0, 0, -1) } } });
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  await clock.advance(4_000);
  assert.equal(observeProjectileDefence(bot)!.heldProjectileId, 8);
  const second = entities.spawn({ id: 9, name: "arrow", position: new Vec3(earlier ? -1 : -2, 65, 0), velocity: new Vec3(1, 0, 0) });
  assert.equal(arrowImpact(bot, second)!.ticks, earlier ? 1 : 2);
  assert.equal(observeProjectileDefence(bot)!.heldProjectileId, earlier ? 9 : 8);
  bot.entities[8]!.velocity.set(0, 0, 0); second.velocity.set(0, 0, 0);
  confirmShieldBlock(bot);
  assert.equal(observeProjectileDefence(bot), null, "a confirmed block clears the held contact");
});

/**
 * A bot in open air with arrow #8 flying at it; `later` arrows exist but the bot has not seen them yet: `arrive(id)`
 * announces one, at its position and velocity.
 */
function fixture(later: Record<number, { position: Vec3; velocity: Vec3 }> = {}) {
  const { bot, world } = createFakeBot({
    position: { x: 0, y: 64, z: 0 },
    groundY: null,
    entities: {
      8: { name: "arrow", position: { x: 0, y: 67.3, z: 8 } },
      ...Object.fromEntries(Object.entries(later).map(([id, { position }]) => [id, { name: "arrow", position }])),
    },
  });
  const arrow = bot.entities[8]!;
  arrow.velocity.set(0, 0, -1);
  const unseen = new Map(Object.entries(later).map(([id, { velocity }]) => {
    const entity = bot.entities[Number(id)]!;
    entity.velocity.set(velocity.x, velocity.y, velocity.z);
    delete bot.entities[Number(id)];
    return [Number(id), entity];
  }));
  const arrive = (id: number) => (bot.entities[id] = unseen.get(id)!);
  return { bot, world, arrow, arrive };
}

/** Stone across x -1..1 at `z`, `ys` high: what the line from the bot to something beyond it now meets. */
function wallAt(world: FakeWorld, z: number, ys: readonly number[], block = "stone"): void {
  for (const x of [-1, 0, 1]) for (const y of ys) world.setCell(new Vec3(x, y, z), block);
}

test("non-arrow contact admission and aim agree through misses, blocked rays and departure", () => {
  const { bot, entities, world } = createFakeBot({ position: new Vec3(0, 64, 0), groundY: null });
  const shot = entities.spawn({ name: "small_fireball", position: new Vec3(0, 65, 8), velocity: new Vec3(0, 0, -0.1) });
  const crossing = entities.spawn({ name: "small_fireball", position: new Vec3(2, 65, -4), velocity: new Vec3(0, 0, 0.5) });
  assert.deepEqual(incomingShieldProjectiles(bot, 2), [crossing, shot]);
  const actual = observeProjectileDefence(bot, 2)!;
  assert.deepEqual(actual.projectiles.map(({ entity }) => entity.id), [shot.id], "an actual hit wins over a movement warning");
  assert.equal(actual.projectiles[0]!.impactInTicks, null, "long current-speed ETA remains unknown");
  assert.ok(actual.facing.z > 0);
  entities.remove(crossing.id);
  const side = entities.spawn({ name: "small_fireball", position: new Vec3(8, 65, 0), velocity: new Vec3(-0.1, 0, 0) });
  const shared = observeProjectileDefence(bot)!;
  assert.equal(shared.coversAll, true);
  assert.ok(shared.facing.x > 0 && shared.facing.z > 0, "two unknown observed bearings share the cone");
  entities.remove(side.id);
  for (const state of ["zero", "outgoing", "passed", "invalid", "blocked"] as const) {
    shot.position.set(0, 65, state === "passed" ? -0.1 : 8);
    shot.velocity.set(0, 0, state === "zero" ? 0 : state === "outgoing" ? 0.1 : -0.1);
    shot.isValid = state !== "invalid";
    if (state === "blocked") wallAt(world, 4, [64, 65, 66]);
    assert.deepEqual(incomingShieldProjectiles(bot), [], state);
    assert.equal(observeProjectileDefence(bot), null, `${state} releases guard`);
  }
  entities.remove(shot.id);
  assert.equal(observeProjectileDefence(bot), null);
});

test("an imminent arrow shares its held cone with an unknown-time observed shot", () => {
  const { bot, entities } = createFakeBot({ position: new Vec3(0, 64, 0), groundY: null });
  entities.spawn({ name: "arrow", position: new Vec3(0, 65, 1.5), velocity: new Vec3(0, 0, -1.5) });
  const shot = entities.spawn({ name: "small_fireball", position: new Vec3(8, 65, 0), velocity: new Vec3(-0.1, 0, 0) });
  const defence = observeProjectileDefence(bot, 0, 1000)!;
  assert.equal(defence.projectiles.length, 2, "unknown timing never drops observed evidence");
  assert.equal(defence.projectiles.find(({ entity }) => entity === shot)!.impactInTicks, null);
  assert.equal(defence.coversAll, true, "the known arrow's commitment keeps the compatible unknown hit protected");
});

for (const ticksPerSecond of [20, 10]) {
  test(`a departed fireball releases guard and the next navigate completes (${ticksPerSecond} tps)`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { bot, entities } = createFakeBot({ clock, simulatePhysics: true, server: { ticksPerSecond },
      position: new Vec3(0.5, 64, 0.5), slots: { 45: { name: "shield" } } });
    using _pace = serverTickPace(bot);
    const added = listenersAddedSince(bot);
    const navigation = createNavigationRuntime(bot);
    const shot = entities.spawn({ name: "small_fireball", position: new Vec3(0.5, 65, 8.5), velocity: new Vec3(0, 0, -0.1) });
    const abort = new AbortController();
    try {
      const raised = new Promise<void>((resolve) => bot.once("entityUpdate", () => resolve()));
      const guarded = guardRetreatProjectiles(bot, navigation, abort.signal, performance.now() + 10_000, DEFAULT_COMBAT_POLICY);
      await clock.settle(raised, 2_000);
      assert.equal(bot.usingHeldItem, true, "the incoming shot raised the guard before departure");
      entities.remove(shot.id);
      assert.equal((await clock.settle(guarded, 5_000)).kind, "finished");
      assert.equal(observeProjectileDefence(bot), null);
      const next = await clock.settle(navigation.navigate({ movements: createMovements(bot),
        goal: exactBlockGoal({ x: 2, y: 64, z: 0 }) }), 10_000);
      assert.equal(next.status, "completed", JSON.stringify(next));
    } finally {
      abort.abort();
      await clock.settle(navigation.close(), 5_000);
    }
    await clock.advance(60_000);
    assert.equal(added("physicsTick"), 0);
    assert.equal(added("time"), 0);
    assert.equal(clock.pendingTimers(), 0);
  });
}

/** Let the shared server start the draw, then draw a full twenty server ticks. */
async function drawOwnBow({ bot, clock }: FakeHarness, ticksPerSecond: number): Promise<void> {
  const started = new Promise<void>((resolve) => bot.once("entityUpdate", () => resolve()));
  bot.activateItem();
  await clock.settle(started, 6_000);
  await clock.advance(19_000 / ticksPerSecond);
}

/** Use the real shared bow seam, awaiting both the draw and its spawned answer. */
async function releaseOwnArrow(harness: FakeHarness, ticksPerSecond: number): Promise<Entity> {
  const { bot, clock } = harness;
  await drawOwnBow(harness, ticksPerSecond);
  const spawned = new Promise<Entity>((resolve) => bot.once("entitySpawn", resolve));
  bot.deactivateItem();
  return clock.settle(spawned, 1_000);
}

for (const ticksPerSecond of [20, 10]) {
  test(`a fresh own bow arrow is excluded from incoming protection (${ticksPerSecond} tps)`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const harness = createFakeBot({ clock, carried: { bow: 1, arrow: 1 }, server: { ticksPerSecond } });
    const { bot, server, entities } = harness;
    using _perception = new CombatPerception(bot);
    await bot.look(-Math.PI / 2, 0, true);
    const arrow = await releaseOwnArrow(harness, ticksPerSecond);
    const census = [0, 2].map((allowance) => ({ allowance, incoming: isIncomingArrow(bot, arrow, allowance),
      admitted: incomingShieldProjectiles(bot, allowance).includes(arrow) }));
    console.log(`own launch: ${ticksPerSecond} tps, clock ${clock.now()}, world age ${bot.time.age}, server tick ${server.gameTime}: ${JSON.stringify(census)}`);
    for (const { allowance, incoming, admitted } of census) {
      assert.equal(incoming, false, `own launch with allowance ${allowance}`);
      assert.equal(admitted, false, `own launch excluded from shield census with allowance ${allowance}`);
    }
    assert.equal(isIncomingArrow(bot, arrow, 0, { ...bot.entity, position: bot.entity.position.offset(3, 0, 0) }), true,
      "an outgoing arrow still threatens a candidate cover body along its flight");
    arrow.position = bot.entity.position.offset(3, 1.5, 0);
    arrow.velocity.set(-1, 0, 0);
    bot._client.emit("sync_entity_position", { entityId: arrow.id });
    assert.equal(isIncomingArrow(bot, arrow), true, "a later returning own arrow must be guarded");
    await clock.advance(50);
    arrow.position = bot.entity.position.offset(0, 1.52, 0);
    arrow.velocity.set(1, 0, 0);
    bot._client.emit("sync_entity_position", { entityId: arrow.id });
    assert.equal(isIncomingArrow(bot, arrow), true, "returning through the launch point cannot regain a fresh-launch exemption");
    entities.remove(arrow.id);
    const hostile = entities.spawn({ id: arrow.id, name: "arrow", position: bot.entity.position.offset(0, 1.52, 0), velocity: new Vec3(1, 0, 0) });
    assert.equal(isIncomingArrow(bot, hostile), true, "entity id reuse cannot inherit launch attribution");
  });
}

test("overlapping hostile arrows cannot borrow a bow draw or a release in the opposite direction", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, entities } = createFakeBot({ clock, carried: { bow: 1, arrow: 1 } });
  using _perception = new CombatPerception(bot);
  await bot.look(-Math.PI / 2, 0, true);
  bot.activateItem();
  const position = bot.entity.position.offset(0, 1.52, 0);
  const duringDraw = entities.spawn({ name: "arrow", position, velocity: new Vec3(1, 0, 0) });
  assert.equal(isIncomingArrow(bot, duringDraw), true, "no release was commanded");
  bot.deactivateItem();
  for (const velocity of [new Vec3(1, 0, 0), new Vec3(0.001, 0, -1)]) {
    const hostile = entities.spawn({ name: "arrow", position, velocity });
    assert.equal(isIncomingArrow(bot, hostile), true, "a no-shot release cannot hide same-direction or nearly perpendicular hostile overlaps");
    assert.ok(incomingShieldProjectiles(bot, 2).includes(hostile));
  }
  const incoming = entities.spawn({ name: "arrow", position, velocity: new Vec3(-1, 0, 0) });
  let contactRays = 0;
  const raycast = bot.world.raycast;
  bot.world.raycast = (from, direction, range, matcher) => {
    assert.ok(range >= 0, "projectile contact can start inside the body at distance zero");
    if (range === 0) contactRays++;
    return raycast(from, direction, range, matcher);
  };
  assert.equal(isIncomingArrow(bot, incoming), true, "opposite launch direction is hostile even at the eye");
  assert.ok(incomingShieldProjectiles(bot, 2).includes(incoming));
  assert.ok(contactRays > 0, "overlapping incoming arrows exercise the zero-range contact contract");
});

for (const ticksPerSecond of [20, 10]) {
  test(`only matching observed launch geometry retains attribution (${ticksPerSecond} tps)`, async () => {
    for (const [offset, lateral, incoming] of [[0.5e-6, 0, false], [2e-6, 0, true], [0, 1 / 8_000, false], [0, 2 / 8_000, true]] as const) {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const harness = createFakeBot({ clock, carried: { bow: 1, arrow: 1 }, server: { ticksPerSecond } });
      const { bot } = harness;
      using _tracker = trackArrowFlights(bot);
      const arrow = await releaseOwnArrow(harness, ticksPerSecond);
      assert.equal(isIncomingArrow(bot, arrow), false);
      arrow.position.x += offset;
      arrow.velocity.x = lateral;
      bot._client.emit(offset ? "sync_entity_position" : "entity_velocity", { entityId: arrow.id });
      assert.equal(isIncomingArrow(bot, arrow), incoming, `position offset ${offset}, lateral velocity ${lateral}`);
    }
  });

  test(`a perpendicular hostile overlap cannot steal a pending own launch (${ticksPerSecond} tps)`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const harness = createFakeBot({ clock, carried: { bow: 1, arrow: 1 }, server: { ticksPerSecond } });
    const { bot, entities } = harness;
    using _tracker = trackArrowFlights(bot);
    await drawOwnBow(harness, ticksPerSecond);
    let injecting = true;
    const spawned = new Promise<Entity>((resolve) => {
      const listen = (entity: Entity) => {
        if (injecting) return;
        bot.off("entitySpawn", listen);
        resolve(entity);
      };
      bot.on("entitySpawn", listen);
    });
    bot.deactivateItem();
    const hostile = entities.spawn({ name: "arrow", position: bot.entity.position.offset(0, 1.52, 0), velocity: new Vec3(1, 0, -0.001) });
    injecting = false;
    assert.equal(isIncomingArrow(bot, hostile), true);
    const own = await clock.settle(spawned, 1_000);
    assert.equal(isIncomingArrow(bot, own), false, "the wrong direction did not consume the real release candidate");
    assert.ok(incomingShieldProjectiles(bot, 2).includes(hostile));
  });

  test(`a genuine delayed own launch expires by server age (${ticksPerSecond} tps)`, async () => {
    for (const lagMs of [0, 4_000]) {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const harness = createFakeBot({ clock, carried: { bow: 1, arrow: 1 }, lagMs, server: { ticksPerSecond } });
      const { bot } = harness;
      using _tracker = trackArrowFlights(bot);
      await drawOwnBow(harness, ticksPerSecond);
      const age = bot.time.age;
      const spawned = new Promise<Entity>((resolve) => bot.once("entitySpawn", resolve));
      bot.deactivateItem();
      const arrow = await clock.settle(spawned, lagMs + 1_000);
      assert.equal(bot.inventory.items().some((item) => item.name === "arrow"), false, "the actual shot spent its ammunition");
      assert.equal(isIncomingArrow(bot, arrow), lagMs > 0, `clock ${clock.now()}, age ${age} -> ${bot.time.age}`);
    }
  });

  test(`a genuine stopped-server launch expires at the wall backstop (${ticksPerSecond} tps)`, async () => {
    for (const waited of [5_950, 5_951]) {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const harness = createFakeBot({ clock, carried: { bow: 1, arrow: 1 }, server: { ticksPerSecond } });
      const { bot, server } = harness;
      using _tracker = trackArrowFlights(bot);
      await drawOwnBow(harness, ticksPerSecond);
      server.stop();
      const age = bot.time.age;
      const releasedAt = clock.now();
      const spawned = new Promise<Entity>((resolve) => bot.once("entitySpawn", resolve));
      bot.deactivateItem();
      await clock.advance(waited);
      assert.equal(bot.time.age, age, "the stopped age cannot expire the pending release");
      server.resume();
      const arrow = await clock.settle(spawned, 1_000);
      assert.equal(clock.now() - releasedAt, waited + 50, "the resumed answer arrives in the next fake clock slice");
      assert.equal(isIncomingArrow(bot, arrow), waited > 5_950, `wall ${clock.now() - releasedAt}, age ${age} -> ${bot.time.age}`);
    }
  });

  test(`a burst of movement and reflection packets cannot revive launch attribution (${ticksPerSecond} tps)`, async () => {
    for (const movement of ["rel_entity_move", "entity_move_look", "sync_entity_position", "entity_velocity"] as const) {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const harness = createFakeBot({ clock, carried: { bow: 1, arrow: 1 }, server: { ticksPerSecond } });
      const { bot } = harness;
      using _tracker = trackArrowFlights(bot);
      const arrow = await releaseOwnArrow(harness, ticksPerSecond);
      assert.equal(isIncomingArrow(bot, arrow), false);
      const origin = arrow.position.clone();
      arrow.position = origin.offset(0, 0, -3);
      bot._client.emit(movement, { entityId: arrow.id, dX: 0, dY: 0, dZ: -12288 });
      arrow.velocity.set(0, 0, 1);
      bot._client.emit("entity_velocity", { entityId: arrow.id });
      assert.equal(arrowFlight(bot, arrow).ownLaunch, null, `${movement}: departure/reflection clears attribution immediately`);
      arrow.position = origin;
      bot._client.emit(movement, { entityId: arrow.id, dX: 0, dY: 0, dZ: 12288 });
      arrow.velocity.set(0, 0, -1);
      bot._client.emit("entity_velocity", { entityId: arrow.id });
      assert.equal(isIncomingArrow(bot, arrow), true, `${movement}: returning in one clock turn must be guarded`);
    }
  });

  test(`launch attribution clears on disposal, respawn and entity destruction (${ticksPerSecond} tps)`, async () => {
    for (const reset of ["dispose", "respawn", "entity_destroy"] as const) {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const harness = createFakeBot({ clock, carried: { bow: 1, arrow: 1 }, server: { ticksPerSecond } });
      const { bot, entities } = harness;
      const addedBot = listenersAddedSince(bot), addedClient = listenersAddedSince(bot._client);
      const write = bot._client.write;
      const tracker = trackArrowFlights(bot);
      const lease = trackArrowFlights(bot);
      const arrow = await releaseOwnArrow(harness, ticksPerSecond);
      assert.equal(isIncomingArrow(bot, arrow), false);
      lease[Symbol.dispose]();
      assert.equal(isIncomingArrow(bot, arrow), false, "the remaining lease owns attribution");
      if (reset === "dispose") tracker[Symbol.dispose]();
      else if (reset === "respawn") bot.emit("respawn");
      else {
        entities.remove(arrow.id);
        bot._client.emit("entity_destroy", { entityIds: [arrow.id] });
        entities.spawn({ id: arrow.id, name: "arrow", position: arrow.position, velocity: arrow.velocity });
      }
      assert.equal(isIncomingArrow(bot, bot.entities[arrow.id]!), true, reset);
      tracker[Symbol.dispose]();
      assert.equal(bot._client.write, write);
      for (const event of ["entitySpawn", "respawn"]) assert.equal(addedBot(event), 0, event);
      for (const event of ["spawn_entity", "entity_velocity", "rel_entity_move", "entity_move_look", "entity_teleport", "sync_entity_position", "entity_destroy"])
        assert.equal(addedClient(event), 0, event);
      await clock.advance(10_000);
      assert.equal(isIncomingArrow(bot, bot.entities[arrow.id]!), true, "disposed attribution cannot return later");
    }
  });
}

test("a no-shot release leaves hostile overlaps incoming on either side of each expiry", async () => {
  for (const ticksPerSecond of [20, 10]) {
    for (const expired of [false, true]) {
      for (const stopped of [false, true]) {
        const clock = createFakeClock({ mode: "mocked" });
        using _timers = clock.install();
        const { bot, server, entities } = createFakeBot({ clock, carried: { bow: 1, arrow: 1 }, server: { ticksPerSecond } });
        using _tracker = trackArrowFlights(bot);
        // No server tick of draw: this commanded release produces no own arrow (bow-draw-and-release contract).
        bot.activateItem();
        bot.deactivateItem();
        if (stopped) server.stop();
        await clock.advance(stopped ? (expired ? 6_001 : 6_000) : (expired ? 40_000 : 20_000) / ticksPerSecond);
        assert.equal(bot.time.age, stopped ? 24_000 : expired ? 24_040 : 24_020);
        const arrow = entities.spawn({ name: "arrow", position: bot.entity.position.offset(0, 1.52, 0), velocity: new Vec3(0, 0, -1) });
        assert.equal(isIncomingArrow(bot, arrow), true, `no-shot release: expired ${expired}, stopped ${stopped}, clock ${clock.now()}, age ${bot.time.age}`);
      }
    }
  }
});

test("a reflected arrow inside the hit margin cannot reacquire guard", () => {
  const { bot, arrow } = fixture();
  arrow.position.set(0, 65, 0.4);
  arrow.velocity.set(0, 0, -1);
  assert.equal(observeProjectileDefence(bot, 0, 1000)!.heldProjectileId, arrow.id);
  arrow.velocity.set(0, 0, 0.1);
  assert.equal(isIncomingArrow(bot, arrow), false);
  confirmShieldBlock(bot);
  assert.equal(observeProjectileDefence(bot, 0, 1001), null, "confirmed contact needs no estimated grace");
});

test("contacts two ticks apart share a protective heading, including a newly observed second shot", () => {
  for (const arrivesLater of [false, true]) {
    const angle = 134 * Math.PI / 180;
    const direction = new Vec3(Math.sin(angle), 0, Math.cos(angle));
    const { bot, arrow, arrive } = fixture({ 9: { position: new Vec3(0, 65, 0).plus(direction.scaled(3)), velocity: direction.scaled(-1) } });
    arrow.position.set(0, 65, 1.4);
    if (arrivesLater) observeProjectileDefence(bot, 0, 1000);
    arrive(9);
    const defence = observeProjectileDefence(bot, 0, 1001)!;
    assert.equal(defence.projectiles[0]!.impactInTicks, 1);
    assert.equal(defence.projectiles[1]!.impactInTicks, 3);
    const heading = defence.facing.minus(bot.entity.position.offset(0, 1.62, 0)).normalize();
    for (const shot of defence.projectiles) {
      const bearing = shot.contact.minus(bot.entity.position); bearing.y = 0;
      assert.ok(heading.dot(bearing.normalize()) >= Math.cos(70 * Math.PI / 180));
    }
  }
});

test("grazing arrow guard uses the collision bearing and retains it through estimated contact", async () => {
  const { bot, clock } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), groundY: null,
    entities: { 8: { name: "arrow", position: new Vec3(0, 65, 8), velocity: new Vec3(0, 0, -1) } } });
  const arrow = bot.entities[8]!;
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  await clock.advance(4_000);
  // Server probe attempt 15: the arrow crossed the bot's front during its
  // last movement segment. Facing its earlier position exposed the contact.
  bot.entity.position.set(2.7194334786, -60, -4.6995768174);
  arrow.position.set(3.1257581415, -58.9264723955, -3.6741039384);
  arrow.velocity.set(-1.361514457, -0.275710276, -0.629843159);
  const impact = arrowImpact(bot, arrow)!;
  assert.equal(impact.ticks, 1);
  assert.ok(impact.position.x < bot.entity.position.x, "collision is on the opposite side from the old arrow position");
  const defence = observeProjectileDefence(bot)!;
  const heading = defence.facing.minus(bot.entity.position.offset(0, 1.62, 0));
  assert.ok(heading.x < 0 && heading.z > 0);
  assert.equal(defence.heldProjectileId, arrow.id);
  arrow.position.set(1, -60, -5); // locally predicted past the body, before confirmation
  await clock.advance(50);
  assert.deepEqual(observeProjectileDefence(bot)!.facing, defence.facing);
  await clock.advance(150);
  assert.equal(observeProjectileDefence(bot), null, "the impact window is bounded");
});

test("a new incoming arrow can replace the grace window of a shot that has passed", () => {
  const { bot, arrow, arrive } = fixture({ 9: { position: new Vec3(0, 65, -2), velocity: new Vec3(0, 0, 1) } });
  arrow.position.set(0, 65, 2);
  const first = observeProjectileDefence(bot, 0, 1000)!;
  assert.equal(first.heldProjectileId, arrow.id);
  arrow.position.set(0, 65, -3);
  arrive(9);
  const defence = observeProjectileDefence(bot, 0, 1050)!;
  assert.equal(defence.heldProjectileId, 9);
  assert.ok(defence.facing.z < bot.entity.position.z);
});

test("retreat and shield facing detect an arrow which falls into the body below its original ray", () => {
  const { bot, arrow } = fixture();
  assert.equal(projectileReachesBody(bot.world, arrow, bot.entity), false);
  assert.equal(isIncomingArrow(bot, arrow), true);
  assert.deepEqual(incomingShieldProjectiles(bot), [arrow]);
  assert.ok(projectileShieldFacing(bot)!.z > 0);
});

for (const ticksPerSecond of [20, 10]) test(`a candidate body uses retained curved flight and directional movement allowance at ${ticksPerSecond} tps`, async () => {
  const { bot, clock, entities } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), groundY: null,
    position: new Vec3(0.5, 64, 0.5), server: { ticksPerSecond },
    entities: { 8: { name: "arrow", position: new Vec3(0.5, 70, 8.5), velocity: new Vec3(0, 0, -0.5) } } });
  using _timers = clock.install();
  using _perception = new CombatPerception(bot);
  await clock.advance(40_000 / ticksPerSecond);
  const arrow = bot.entities[8]!;
  bot._client.emit("sync_entity_position", { entityId: arrow.id });
  const packetPosition = arrow.position.clone();
  await clock.advance(5_000 / ticksPerSecond);
  assert.deepEqual(arrow.position, packetPosition, "the packet position stayed stale");
  assert.ok(arrowFlight(bot, arrow).position.distanceTo(packetPosition) > 1, "the retained flight advanced");
  assert.equal(projectileReachesBody(bot.world, arrow, bot.entity), false);
  assert.equal(projectileThreatensBody(bot, arrow, 0, bot.entity), true);
  assert.equal(projectileThreatensBody(bot, arrow, 0, { ...bot.entity, position: new Vec3(30, 64, 0) }), false);
  const shot = entities.spawn({ name: "small_fireball", position: new Vec3(8.5, 65, 0.5), velocity: new Vec3(-0.5, 0, 0) });
  const candidate = { ...bot.entity, position: new Vec3(0.5, 64, 2) };
  assert.equal(projectileThreatensBody(bot, shot, 0, candidate), false);
  assert.equal(projectileThreatensBody(bot, shot, 2, candidate), true);
  entities.remove(shot.id);
  assert.equal(projectileThreatensBody(bot, shot, 2, candidate), false);
});

test("one defensive assessment orders impacts and covers shots independently of the quarry", () => {
  const { bot, arrow, arrive } = fixture({ 9: { position: new Vec3(8, 65, 0), velocity: new Vec3(-1.5, 0, 0) } });
  bot.entity.yaw = 0;
  arrive(9);
  const defence = observeProjectileDefence(bot)!;
  assert.equal(defence.projectiles[0]!.entity.id, 9);
  assert.equal(defence.coversAll, true);
  assert.equal(defence.aligned, false);
  assert.equal(defence.imminent, true);
  assert.ok(defence.facing.x > 0 && defence.facing.z > 0);
  assert.equal(arrowImpactInTicks(bot, arrow), 8);
  assert.equal(isIncomingArrow(bot, arrow, 0, { ...bot.entity, position: new Vec3(30, 64, 0) }), false,
    "a projectile threatening the current body does not invalidate distant protected cover");
});

test("an aimed bow draw contributes defensive facing before its arrow exists", () => {
  const { bot, world, arrow: shooter } = fixture();
  shooter.name = "skeleton";
  shooter.kind = "Hostile mobs";
  shooter.height = 1.99;
  shooter.position.set(0, 64, 8);
  shooter.pitch = 0;
  Reflect.set(shooter, "headYaw", 0);
  shooter.setEquipment(0, itemOf(bot.registry, "bow"));
  Reflect.set(shooter.metadata, 8, 1);
  bot.entity.yaw = -Math.PI / 2;
  const defence = observeProjectileDefence(bot)!;
  assert.equal(defence.projectiles.length, 0);
  assert.deepEqual(defence.windingUp.map((entity) => entity.id), [8]);
  assert.equal(defence.aligned, false);
  assert.ok(defence.facing.z > bot.entity.position.z);
  wallAt(world, 4, [64, 65, 66]);
  assert.equal(observeProjectileDefence(bot), null, "a draw flag behind cover must not retain guard");
  wallAt(world, 4, [64, 65, 66], "air");
  assert.ok(observeProjectileDefence(bot), "restored sight makes the ongoing draw a threat again");
  Reflect.set(shooter, "headYaw", Math.PI);
  assert.equal(observeProjectileDefence(bot), null, "drawing toward someone else is not our guard cue");
});

test("opposed shots admit the best achievable heading without demanding impossible coverage", () => {
  const { bot, arrive } = fixture({ 9: { position: new Vec3(0, 65, -8), velocity: new Vec3(0, 0, 1) } });
  arrive(9);
  const defence = observeProjectileDefence(bot)!;
  assert.equal(defence.coversAll, false);
  const direction = defence.facing.minus(bot.entity.position);
  bot.entity.yaw = Math.atan2(-direction.x, -direction.z);
  assert.equal(observeProjectileDefence(bot)!.aligned, true);
});

test("arrows that pass, hit terrain, or remain embedded cannot retain the retreat guard", () => {
  const { bot, world, arrow } = fixture();
  arrow.velocity.z = 1;
  assert.equal(isIncomingArrow(bot, arrow), false);
  arrow.velocity.z = -1;
  wallAt(world, 4, [66, 67]);
  assert.equal(isIncomingArrow(bot, arrow), false);
  wallAt(world, 4, [66, 67], "air");
  Reflect.set(arrow.metadata, bot.registry.entitiesByName.arrow!.metadataKeys!.indexOf("in_ground"), true);
  assert.equal(isIncomingArrow(bot, arrow), false, "embedded arrows can retain stale velocity");
});

test("movement allowance warns before crossing an arrow; stationary facing still prioritises an actual hit", () => {
  const { bot, arrive } = fixture({ 9: { position: new Vec3(-2.2, 65, 2), velocity: new Vec3(0, 0, -1) } });
  const miss = arrive(9);
  assert.equal(isIncomingArrow(bot, miss), false);
  assert.equal(isIncomingArrow(bot, miss, 2), true);
  assert.ok(projectileShieldFacing(bot, 2)!.z > 0);
});

test("a piercing arrow cannot be answered by the shield guard", () => {
  const { bot, arrow } = fixture();
  Reflect.set(arrow.metadata, bot.registry.entitiesByName.arrow!.metadataKeys!.indexOf("pierce_level"), 1);
  assert.deepEqual(incomingShieldProjectiles(bot), []);
});

test("a vertical arrow with a zero-speed apex still falls into the body", () => {
  const { bot, arrow } = fixture();
  arrow.position.set(0, 67, 0);
  arrow.velocity.set(0, 0.05 / 0.99, 0);
  const raycast = bot.world.raycast;
  bot.world.raycast = (origin, direction, range) => {
    assert.ok(Number.isFinite(direction.x) && Number.isFinite(direction.y) && Number.isFinite(direction.z));
    return raycast(origin, direction, range);
  };
  assert.equal(isIncomingArrow(bot, arrow), true);
});

test("perception retains native arrow spawn velocity for immediate guarding and releases its listeners", () => {
  const { bot, arrow } = fixture();
  arrow.velocity.set(0, 0, 0);
  const before = bot._client.listenerCount("spawn_entity");
  const perception = new CombatPerception(bot);
  assert.equal(isIncomingArrow(bot, arrow), false);
  bot._client.emit("spawn_entity", {
    entityId: arrow.id,
    type: bot.registry.entitiesByName.arrow!.id,
    objectData: 123,
    velocity: { x: 0, y: 0, z: -8000 },
  });
  assert.equal(arrow.velocity.z, -1);
  assert.equal(isIncomingArrow(bot, arrow), true);
  assert.equal(perception.attackerIds.size, 0, "do not guess an arrow owner from an unverified packet field");
  perception[Symbol.dispose]();
  assert.equal(bot._client.listenerCount("spawn_entity"), before);
});

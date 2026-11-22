import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../test-support/fake-bot/index.js";
import { serverTickPace } from "../../../world/server-tick-pace.js";
import { confirmShieldBlock, observeProjectileDefence } from "../../weapons/shield-facing.js";
import { arrowFlight, trackArrowFlights } from "./arrow-flight.js";

for (const rate of [20, 10]) for (const noAge of [false, true]) test(`cold stopped incoming flight stays uncertain: ${rate} tps ${noAge}`, async () => {
  const { bot, clock, server } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }),
    server: { ticksPerSecond: rate, timePacketYet: !noAge }, groundY: null, position: new Vec3(0, 64, 0),
    entities: { 4: { name: "arrow", position: new Vec3(0, 65, 10), velocity: new Vec3(0, 0, -1.7) } } });
  using _timers = clock.install();
  const added = listenersAddedSince(bot), packets = listenersAddedSince(bot._client);
  const pace = serverTickPace(bot), tracker = trackArrowFlights(bot);
  bot._client.emit("spawn_entity", { entityId: 4 });
  server.stop();
  const age = bot.time.age, gameTime = server.gameTime;
  await clock.advance(50);
  assert.equal(observeProjectileDefence(bot)!.timingUncertain, true);
  await clock.advance(6_000);
  assert.equal(server.gameTime, gameTime); assert.equal(bot.time.age, age);
  assert.equal(arrowFlight(bot, bot.entities[4]!).position.z, 10, "no readiness credit invents flight progress");
  assert.equal(observeProjectileDefence(bot)!.timingUncertain, true);
  bot.entities[4]!.velocity.set(0, 0, 0); confirmShieldBlock(bot);
  tracker[Symbol.dispose](); pace[Symbol.dispose]();
  await clock.advance(6_000);
  assert.equal(observeProjectileDefence(bot), null, "cleanup cannot revive a held contact");
  serverTickPace(bot)[Symbol.dispose](); // Dispose the inspection's lazy pace observer too.
  for (const event of ["time", "physicsTick", "entitySpawn", "respawn", "heldItemChanged", "mount", "dismount", "death", "end"]) assert.equal(added(event), 0, event);
  for (const event of ["spawn_entity", "entity_velocity", "rel_entity_move", "entity_move_look", "entity_teleport", "sync_entity_position", "entity_destroy"]) assert.equal(packets(event), 0, event);
});

for (const rate of [20, 10]) test(`flight steps and partial corrections preserve server-tick remainder at ${rate} tps`, async () => {
  const { bot, clock, server } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond: rate },
    groundY: null, entities: { 4: { name: "arrow", position: new Vec3(0, 65, 10), velocity: new Vec3(0, 0, -1.7) } } });
  using _timers = clock.install();
  const added = listenersAddedSince(bot), packets = listenersAddedSince(bot._client);
  const pace = serverTickPace(bot);
  await clock.advance(4_000);
  const tracker = trackArrowFlights(bot);
  const entity = bot.entities[4]!, age = bot.time.age, gameTime = server.gameTime;
  bot._client.emit("spawn_entity", { entityId: 4 });
  await clock.advance(1_000 / rate - 1);
  bot._client.emit("entity_move_look", { entityId: 4, dX: 0, dY: 0, dZ: 0 });
  assert.equal(arrowFlight(bot, entity).position.z, 10);
  await clock.advance(1);
  assert.equal(arrowFlight(bot, entity).position.z, 8.3);
  assert.equal(server.gameTime - gameTime, 1);
  assert.equal(bot.time.age, age);
  await clock.advance(250 / rate);
  bot._client.emit("entity_velocity", { entityId: 4 });
  await clock.advance(750 / rate - 1);
  assert.equal(arrowFlight(bot, entity).position.z, 8.3);
  await clock.advance(1);
  assert.ok(arrowFlight(bot, entity).position.z < 8.3, "velocity correction retains the partial tick");
  assert.equal(entity.position.z, 10);
  assert.equal(arrowFlight(bot, entity).positionAt, 4_000);
  tracker[Symbol.dispose](); pace[Symbol.dispose]();
  await clock.advance(6_000);
  for (const event of ["time", "physicsTick", "entitySpawn", "respawn", "heldItemChanged", "mount", "dismount", "death", "end"]) assert.equal(added(event), 0, event);
  for (const event of ["spawn_entity", "entity_velocity", "rel_entity_move", "entity_move_look", "entity_teleport", "sync_entity_position", "entity_destroy"]) assert.equal(packets(event), 0, event);
});

test("flight advances across zero-delta packets and reconciles reflection without reusing launch position", async () => {
  const { bot, clock } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), groundY: null, entities: { 4: { name: "arrow", position: { x: 0, y: 65, z: 10 } } } });
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  await clock.advance(4_000);
  const entity = bot.entities[4]!;
  entity.velocity.set(0, 0.15, -1.7);
  const tracker = trackArrowFlights(bot);
  const secondOwner = trackArrowFlights(bot);
  assert.equal(bot._client.listenerCount("spawn_entity"), 1);
  assert.equal(arrowFlight(bot, entity).positionAt, null, "pre-existing entities have unknown observation age");
  bot._client.emit("spawn_entity", { entityId: 4 });
  await clock.advance(50);
  bot._client.emit("entity_move_look", { entityId: 4, dX: 0, dY: 0, dZ: 0 });
  const first = arrowFlight(bot, entity);
  assert.equal(first.positionAt, 4_000, "zero displacement does not refresh position freshness");
  assert.equal(first.position.z, 8.3);
  await clock.advance(250);
  const later = arrowFlight(bot, entity);
  assert.ok(later.position.z < 0.1);
  assert.equal(entity.position.z, 10, "authoritative observation is untouched");
  entity.velocity.set(0, -0.04, 0.16);
  bot._client.emit("entity_velocity", { entityId: 4 });
  assert.equal(arrowFlight(bot, entity).velocityAt, 4_300);
  assert.equal(arrowFlight(bot, entity).positionAt, 4_000);
  assert.equal(arrowFlight(bot, entity).position.z, later.position.z);
  await clock.advance(50);
  assert.equal(arrowFlight(bot, entity).velocity.z, 0.16 * 0.99);
  entity.position.set(0, 65, 1.1);
  bot._client.emit("sync_entity_position", { entityId: 4 });
  assert.equal(arrowFlight(bot, entity).position.z, 1.1);
  entity.velocity.set(0, 0, 0);
  bot._client.emit("entity_velocity", { entityId: 4 });
  await clock.advance(650);
  assert.equal(arrowFlight(bot, entity).position.z, 1.1);
  bot._client.emit("entity_destroy", { entityIds: [4] });
  entity.position.z = 42;
  assert.equal(arrowFlight(bot, entity).position.z, 42);
  tracker[Symbol.dispose]();
  assert.equal(bot._client.listenerCount("spawn_entity"), 1);
  secondOwner[Symbol.dispose]();
  assert.equal(bot._client.listenerCount("spawn_entity"), 0);
});

test("terrain stops extrapolation and respawn discards the previous flight", async () => {
  const { bot, clock, world } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), groundY: null, entities: { 8: { name: "arrow", position: { x: 0, y: 65, z: 10 } } } });
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  await clock.advance(4_000);
  const entity = bot.entities[8]!;
  entity.velocity.set(0, 0, -1);
  using _tracker = trackArrowFlights(bot);
  world.setCell(new Vec3(0, 65, 9), "stone");
  await clock.advance(100);
  assert.equal(arrowFlight(bot, entity).velocity.norm(), 0);
  bot.emit("respawn");
  assert.equal(arrowFlight(bot, entity).velocity.norm(), 1);
});

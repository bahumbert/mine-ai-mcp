// Corrections, server progress and stop settlement during a boat ride.
import assert from "node:assert/strict";
import test from "node:test";
import { BoatRide, crossByBoat } from "./boat-crossing.js";
import { mountedSea, settled, theBoat } from "./boat-fixtures.test.js";

const AHEAD = { x: 0, z: 1 };

test("an open-water correction resynchronises the crossing instead of looking for a bank", async () => {
  const world = await mountedSea({ landFromZ: 35, physics: true });
  using _clock = world.clock.install();
  // The same correction packet as fake-bot-vehicle.ts's measured collision answer; deep water here is deliberate.
  world.clock.after(500, () => world.bot._client.emit("vehicle_move", { x: 0.5, y: 62.52, z: 5, yaw: 0, pitch: 0 }));
  const result = await settled(world, crossByBoat(world.bot, AHEAD));
  assert.equal(result.status, "crossed", result.detail);
  assert.ok(world.bot.entity.position.z > 30, result.detail);
});

test("a stale boat position and backward correction cannot spend the target distance", async () => {
  const world = await mountedSea();
  using _clock = world.clock.install();
  theBoat(world).position.z = 100;
  world.clock.after(500, () => world.bot._client.emit("vehicle_move", { x: 0.5, y: 62.52, z: 4, yaw: 0, pitch: 0 }));
  const result = await settled(world, crossByBoat(world.bot, AHEAD, undefined, 20));
  assert.equal(result.atSea, true, result.detail);
  assert.ok(world.bot.entity.position.z >= 23.5, result.detail);
  assert.equal(result.blocks, 20);
});

test("repeated open-water corrections with no progress have their own bounded failure", async () => {
  const world = await mountedSea();
  using _clock = world.clock.install();
  const start = theBoat(world).position.clone();
  const stopCorrections = world.server.onPacket("vehicle_move", () => world.server.answer(() =>
    world.bot._client.emit("vehicle_move", { ...start, yaw: 0, pitch: 0 })));
  const result = await settled(world, crossByBoat(world.bot, AHEAD, undefined, 20));
  assert.equal(result.status, "failed");
  assert.match(result.detail, /no progress/i);
  assert.doesNotMatch(result.detail, /no bank/i);
  assert.equal(world.bot._client.listenerCount("vehicle_move"), 0);
  stopCorrections();
  const next = await settled(world, crossByBoat(world.bot, AHEAD, undefined, 5));
  assert.equal(next.atSea, true, next.detail);
  assert.equal(next.blocks, 5, "the next order can row from the stopped seat");
});

test("a stop keeps listening for a delayed vehicle correction and returns its position", async () => {
  const world = await mountedSea();
  using _clock = world.clock.install();
  const ride = new BoatRide(world.bot, theBoat(world), AHEAD, world.bot.entity.position, undefined);
  let ended = false;
  const stopping = ride.end().then((position) => { ended = true; return position; });
  await world.clock.advance(250);
  assert.equal(ended, false, "200 ms of writes is not a server answer");
  world.bot._client.emit("vehicle_move", { x: 0.5, y: 62.52, z: 2, yaw: 0, pitch: 0 });
  const stopped = await settled(world, stopping);
  assert.equal(stopped.z, 2);
  assert.equal(world.bot.entity.position.z, 2);
  assert.equal(world.bot._client.listenerCount("vehicle_move"), 0);
});

test("a stop without a server answer fails explicitly and a later ride can resume from its seat", async () => {
  const world = await mountedSea();
  using _clock = world.clock.install();
  world.server.stop();
  const ride = new BoatRide(world.bot, theBoat(world), AHEAD, world.bot.entity.position, undefined);
  await assert.rejects(settled(world, ride.end()), /\[BOAT_STOP_UNCONFIRMED\]/u);
  assert.equal(world.bot._client.listenerCount("vehicle_move"), 0);
  world.server.resume();
  const next = await settled(world, crossByBoat(world.bot, AHEAD, undefined, 5));
  assert.equal(next.atSea, true, next.detail);
  assert.equal(next.blocks, 5);
});

test("cancel or death during stop settlement cannot start a get-off or take-back", async () => {
  for (const cause of ["cancel", "death", "cancel_then_death"] as const) {
    const world = await mountedSea();
    using _clock = world.clock.install();
    const controller = new AbortController();
    if (cause === "cancel_then_death") {
      world.clock.after(100, () => controller.abort(new Error("cancel while rowing")));
      world.clock.after(250, () => world.bot.emit("death"));
    }
    let previous: number | undefined;
    let stopping = false;
    world.server.onPacket("vehicle_move", (raw) => {
      const z = (raw as { z: number }).z;
      if (z === previous && !stopping && cause !== "cancel_then_death") {
        stopping = true;
        world.clock.after(100, () => cause === "cancel" ? controller.abort(new Error("cancel at stop")) : world.bot.emit("death"));
      }
      previous = z;
    });
    const result = await settled(world, crossByBoat(world.bot, AHEAD, controller.signal, 5));
    assert.equal(result.status, "failed");
    assert.match(result.detail, cause === "cancel" ? /still seated/ : /died/);
    assert.equal(world.server.packets.some((packet) => packet.name === "entity_action"), false);
    assert.equal(world.bot._client.listenerCount("vehicle_move"), 0);
  }
});

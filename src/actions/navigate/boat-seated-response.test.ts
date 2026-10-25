import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { attackedIds } from "../../test-support/combat.js";
import type { FakeHarness } from "../../test-support/fake-bot/index.js";
import { SEATED_BOAT_ID, boatsCarried, boatsInView, mountedSea, vehicleMoves, wroteAShift } from "./boat-fixtures.test.js";
import { respondFromBoat, type SeatedThreat } from "./boat-seated-response.js";
import { watchVehicle } from "./vehicle-sync.js";

const THREAT_ID = 20;
const BOAT_ID = SEATED_BOAT_ID;
/** A ceiling for the clock: far past any response of these tests. */
const SETTLE_MS = 60_000;

/** A seated bot (in boat 7 at z 3.5: the server puts her client at the seat) with a hostile at `at`. */
async function seatedWithThreat(at: Vec3, options: Parameters<typeof mountedSea>[0] = {}) {
  const world = await mountedSea({ ...options, entities: { [THREAT_ID]: { name: "zombie", position: at } } });
  const threat: SeatedThreat = { id: THREAT_ID, position: at };
  return { ...world, threat };
}

const moves = (world: FakeHarness) => vehicleMoves(world);
const noShift = (world: FakeHarness) => assert.equal(wroteAShift(world), false, "she stays seated: no shift");
const stopped = (world: FakeHarness) => assert.equal(new Set(moves(world).slice(-4).map((packet) => JSON.stringify(packet))).size, 1, "the last 4 moves are the same stopped place");

test("a threat in reach is struck from the seat, once per cooldown", async () => {
  const world = await seatedWithThreat(new Vec3(2.5, 62.5, 3.5), { carries: ["iron_sword"] });
  using _timers = world.clock.install();
  const equips: string[] = [];
  const equip = world.bot.equip.bind(world.bot);
  world.bot.equip = async (...args: Parameters<typeof equip>) => {
    if (typeof args[0] !== "number") equips.push(args[0].name);
    return equip(...args);
  };
  const result = await world.clock.settle(respondFromBoat(world.bot, () => [world.threat], new AbortController().signal, { wallMs: 1_000 }), SETTLE_MS);
  // An iron sword's 13 ticks: strikes at 0 and 650 ms, none at 1300.
  assert.equal(result.strikes, 2);
  assert.deepEqual(attackedIds(world.server), [THREAT_ID, THREAT_ID]);
  assert.deepEqual(equips, ["iron_sword"], "the sword is equipped once");
  assert.equal(result.outcome, "timed_out");
  noShift(world);
});

test("a threat out of reach is rowed away from, over open water", async () => {
  const world = await seatedWithThreat(new Vec3(0.5, 63, 12.5));
  using _timers = world.clock.install();
  // The threat is out of sight once the boat has rowed a few blocks.
  const result = await world.clock.settle(respondFromBoat(world.bot, () => (moves(world).length > 12 ? [] : [world.threat]), new AbortController().signal), SETTLE_MS);
  assert.equal(result.outcome, "rowed");
  assert.ok(result.rowed > 3);
  const list = moves(world);
  assert.ok(Number(list[list.length - 1]!.z) < Number(list[0]!.z), "the boat went away from the threat at +z");
  stopped(world);
  noShift(world);
});

test("a bank ahead turns the rowing 45 degrees", async () => {
  // Land from z 0 down: straight away from a threat at +z is the bank.
  const world = await seatedWithThreat(new Vec3(0.5, 63, 12.5), { landUntilZ: 0 });
  using _timers = world.clock.install();
  const result = await world.clock.settle(respondFromBoat(world.bot, () => (moves(world).length > 8 ? [] : [world.threat]), new AbortController().signal), SETTLE_MS);
  assert.equal(result.outcome, "rowed");
  const list = moves(world).map((packet) => ({ x: Number(packet.x), z: Number(packet.z) }));
  // Straight away (-z) is the bank two blocks ahead: the first leg is turned 45 degrees, away and sideways at once.
  assert.ok(list[2]!.x > list[0]!.x && list[2]!.z < list[0]!.z, "the first leg turned 45 degrees");
  assert.ok(list.every((at) => at.z > 1), "the boat never ran into the bank at z 0");
  assert.ok(list[list.length - 1]!.x - list[0]!.x > 1, "the boat went on sideways along the bank");
  noShift(world);
});

test("no threat left ends clear and nothing is rowed", async () => {
  const world = await seatedWithThreat(new Vec3(0.5, 63, 12.5));
  using _timers = world.clock.install();
  const result = await world.clock.settle(respondFromBoat(world.bot, () => [], new AbortController().signal), SETTLE_MS);
  assert.deepEqual([result.outcome, result.strikes, result.rowed], ["clear", 0, 0]);
  assert.deepEqual(moves(world), []);
});

test("the wall ceiling ends it with the boat stopped", async () => {
  const world = await seatedWithThreat(new Vec3(0.5, 63, 12.5));
  using _timers = world.clock.install();
  const startedAt = performance.now();
  const result = await world.clock.settle(respondFromBoat(world.bot, () => [world.threat], new AbortController().signal, { wallMs: 600 }), SETTLE_MS);
  assert.equal(result.outcome, "timed_out");
  assert.ok(performance.now() - startedAt < 1_500, "the row itself stops at the ceiling");
  stopped(world);
});

test("a death ends it at once, with no move for a boat she left", async () => {
  const world = await seatedWithThreat(new Vec3(0.5, 63, 12.5));
  using _timers = world.clock.install();
  let atDeath = -1;
  const listenersBefore = world.bot.listenerCount("death");
  world.clock.after(200, () => {
    atDeath = moves(world).length;
    world.bot.emit("death");
  });
  const result = await world.clock.settle(respondFromBoat(world.bot, () => [world.threat], new AbortController().signal), SETTLE_MS);
  assert.equal(result.outcome, "died");
  assert.equal(moves(world).length, atDeath, "no move after the death");
  assert.equal(world.bot.listenerCount("death"), listenersBefore, "no death listener is left");
});

test("an abort ends it at once with the boat stopped", async () => {
  const world = await seatedWithThreat(new Vec3(0.5, 63, 12.5));
  using _timers = world.clock.install();
  const controller = new AbortController();
  world.clock.after(300, () => controller.abort(new Error("cancelled by the brain")));
  await assert.rejects(world.clock.settle(respondFromBoat(world.bot, () => [world.threat], controller.signal), SETTLE_MS), /cancelled by the brain/u);
  stopped(world);
  noShift(world);
  assert.equal(world.bot._client.listenerCount("vehicle_move"), 0);
});

test("a boat broken under her ends it as unseated", async () => {
  const world = await seatedWithThreat(new Vec3(0.5, 63, 12.5));
  using _timers = world.clock.install();
  // The runtime's vehicle watch forgets a boat that is gone: the server tells a rider of a broken boat nothing.
  const stopWatch = watchVehicle(world.bot);
  world.clock.after(200, () => world.entities.remove(BOAT_ID));
  const result = await world.clock.settle(respondFromBoat(world.bot, () => [world.threat], new AbortController().signal), SETTLE_MS);
  assert.equal(result.outcome, "unseated");
  stopWatch();
});

test("after rowing away, the next movement gets off and takes the boat back", async () => {
  const world = await seatedWithThreat(new Vec3(0.5, 63, 12.5));
  using _timers = world.clock.install();
  await world.clock.settle(respondFromBoat(world.bot, () => (moves(world).length > 12 ? [] : [world.threat]), new AbortController().signal), SETTLE_MS);
  const boat = boatsInView(world)[0]!;
  assert.equal(world.bot.vehicle, boat, "still seated somewhere else at sea");
  await world.clock.settle(prepareBotForMovement(world.bot, { cancel: () => undefined } as unknown as NavigationRuntime), SETTLE_MS);
  assert.deepEqual([...new Set(attackedIds(world.server))], [boat.id], "the boat is hit until it breaks");
  assert.equal(world.bot.vehicle, null);
  assert.equal(boatsCarried(world), 2, "the boat she carried and the one taken back");
});

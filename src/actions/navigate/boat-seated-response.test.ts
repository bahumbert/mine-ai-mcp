import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { mountedBot } from "../../test-support/boat-bot.js";
import { respondFromBoat, type SeatedThreat } from "./boat-seated-response.js";

/** A seated bot (boat 7 at z 3.5, she at z 0.5) with a hostile `at` blocks from her. */
async function seatedWithThreat(at: Vec3, options: Parameters<typeof mountedBot>[0] = {}) {
  const world = await mountedBot(options);
  const threat: SeatedThreat = { id: 20, position: at };
  world.entities[20] = { id: 20, name: "zombie", position: at };
  return { ...world, threat };
}

const moves = (world: { written: readonly { name: string; packet: Record<string, unknown> }[] }) =>
  world.written.filter((entry) => entry.name === "vehicle_move").map((entry) => entry.packet);
const noShift = (world: { written: readonly { name: string }[] }) =>
  assert.equal(world.written.some((entry) => entry.name === "player_input" || entry.name === "entity_action"), false, "she stays seated: no shift");
const stopped = (world: Parameters<typeof moves>[0]) =>
  assert.equal(new Set(moves(world).slice(-4).map((packet) => JSON.stringify(packet))).size, 1, "the last 4 moves are the same stopped place");

test("a threat in reach is struck from the seat, once per cooldown", { timeout: 10_000 }, async () => {
  const world = await seatedWithThreat(new Vec3(2.5, 63, 0.5), { carries: ["iron_sword"] });
  const result = await respondFromBoat(world.bot, () => [world.threat], new AbortController().signal, { wallMs: 1_000 });
  // An iron sword's 13 ticks: strikes at 0 and 650 ms, none at 1300.
  assert.equal(result.strikes, 2);
  assert.deepEqual(world.attacks, [20, 20]);
  assert.deepEqual(world.equips, ["iron_sword"], "the sword is equipped once");
  assert.equal(result.outcome, "timed_out");
  noShift(world);
});

test("a threat out of reach is rowed away from, over open water", { timeout: 10_000 }, async () => {
  const world = await seatedWithThreat(new Vec3(0.5, 63, 12.5));
  // The threat is out of sight once the boat has rowed a few blocks.
  const result = await respondFromBoat(world.bot, () => (moves(world).length > 12 ? [] : [world.threat]), new AbortController().signal);
  assert.equal(result.outcome, "rowed");
  assert.ok(result.rowed > 3);
  const list = moves(world);
  assert.ok(Number(list[list.length - 1]!.z) < Number(list[0]!.z), "the boat went away from the threat at +z");
  stopped(world);
  noShift(world);
});

test("a bank ahead turns the rowing 45 degrees", { timeout: 10_000 }, async () => {
  // Land from z 0 down: straight away from a threat at +z is the bank.
  const world = await seatedWithThreat(new Vec3(0.5, 63, 12.5), { landUntilZ: 0 });
  const result = await respondFromBoat(world.bot, () => (moves(world).length > 8 ? [] : [world.threat]), new AbortController().signal);
  assert.equal(result.outcome, "rowed");
  const list = moves(world).map((packet) => ({ x: Number(packet.x), z: Number(packet.z) }));
  // Straight away (-z) is the bank two blocks ahead: the first leg is turned 45 degrees, away and sideways at once.
  assert.ok(list[2]!.x > list[0]!.x && list[2]!.z < list[0]!.z, "the first leg turned 45 degrees");
  assert.ok(list.every((at) => at.z > 1), "the boat never ran into the bank at z 0");
  assert.ok(list[list.length - 1]!.x - list[0]!.x > 1, "the boat went on sideways along the bank");
  noShift(world);
});

test("no threat left ends clear and nothing is rowed", { timeout: 10_000 }, async () => {
  const world = await seatedWithThreat(new Vec3(0.5, 63, 12.5));
  const result = await respondFromBoat(world.bot, () => [], new AbortController().signal);
  assert.deepEqual([result.outcome, result.strikes, result.rowed], ["clear", 0, 0]);
  assert.deepEqual(moves(world), []);
});

test("the wall ceiling ends it with the boat stopped", { timeout: 10_000 }, async () => {
  const world = await seatedWithThreat(new Vec3(0.5, 63, 12.5));
  const startedAt = performance.now();
  const result = await respondFromBoat(world.bot, () => [world.threat], new AbortController().signal, { wallMs: 600 });
  assert.equal(result.outcome, "timed_out");
  assert.ok(performance.now() - startedAt < 1_500, "the row itself stops at the ceiling");
  stopped(world);
});

test("a death ends it at once, with no move for a boat she left", { timeout: 10_000 }, async () => {
  const world = await seatedWithThreat(new Vec3(0.5, 63, 12.5));
  let atDeath = -1;
  setTimeout(() => {
    atDeath = moves(world).length;
    world.raw.emit("death");
  }, 200);
  const result = await respondFromBoat(world.bot, () => [world.threat], new AbortController().signal);
  assert.equal(result.outcome, "died");
  assert.equal(moves(world).length, atDeath, "no move after the death");
  assert.equal(world.raw.listenerCount("death"), 0);
});

test("an abort ends it at once with the boat stopped", { timeout: 10_000 }, async () => {
  const world = await seatedWithThreat(new Vec3(0.5, 63, 12.5));
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("cancelled by the brain")), 300);
  await assert.rejects(respondFromBoat(world.bot, () => [world.threat], controller.signal), /cancelled by the brain/u);
  stopped(world);
  noShift(world);
  assert.equal(world.client.listenerCount("vehicle_move"), 0);
});

test("a boat broken under her ends it as unseated", { timeout: 10_000 }, async () => {
  const world = await seatedWithThreat(new Vec3(0.5, 63, 12.5));
  setTimeout(() => {
    world.raw.vehicle = null;
    (world.raw.entity as { vehicle: unknown }).vehicle = null;
  }, 200);
  const result = await respondFromBoat(world.bot, () => [world.threat], new AbortController().signal);
  assert.equal(result.outcome, "unseated");
});

test("after rowing away, the next movement gets off and takes the boat back", { timeout: 30_000 }, async () => {
  const world = await seatedWithThreat(new Vec3(0.5, 63, 12.5));
  await respondFromBoat(world.bot, () => (moves(world).length > 12 ? [] : [world.threat]), new AbortController().signal);
  assert.equal(world.raw.vehicle, world.entities[7], "still seated somewhere else at sea");
  await prepareBotForMovement(world.bot, { cancel: () => undefined } as unknown as NavigationRuntime);
  assert.deepEqual(world.attacks, [7], "the boat is hit until it breaks");
  assert.equal(world.raw.vehicle, null);
  assert.equal(world.carried.length, 2, "the boat she carried and the one taken back");
});

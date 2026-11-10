import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { attackedIds } from "../../test-support/combat.js";
import type { FakeHarness } from "../../test-support/fake-bot/index.js";
import { SEATED_BOAT_ID, boatsCarried, boatsInView, mountedSea, vehicleMoves, wroteAShift } from "./boat-fixtures.test.js";
import { respondFromBoat, seatedAtSea, type SeatedThreat } from "./boat-seated-response.js";
import { watchVehicle } from "./vehicle-sync.js";
import { DEFAULT_COMBAT_POLICY } from "../../survival/policy/combat/contract.js";
import { crossByBoat } from "./boat-crossing.js";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { SERVER_ANSWER_TICKS } from "../../world/world-age.js";

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

test("only the combat policy's permitted items are used seated", async () => {
  for (const melee of [false, true]) {
    const world = await seatedWithThreat(new Vec3(2.5, 62.5, 3.5), { carries: ["iron_sword", "shield"] });
    using _timers = world.clock.install();
    await world.clock.settle(respondFromBoat(world.bot, () => [world.threat], new AbortController().signal,
      { wallMs: 1_000, policy: { ...DEFAULT_COMBAT_POLICY, melee, shield: false } }), SETTLE_MS);
    assert.equal(attackedIds(world.server).length > 0, melee);
    assert.equal(world.bot.inventory.slots[45], null);
  }
});

test("the first strike waits the equip settle and sends no sneak field that ejects the rider", async () => {
  const world = await seatedWithThreat(new Vec3(2.5, 62.5, 3.5), { carries: ["iron_sword"] });
  using _timers = world.clock.install();
  const began = performance.now();
  const hits: number[] = [];
  world.server.onPacket("use_entity", (data) => {
    if ((data as { mouse: number }).mouse === 1) {
      hits.push(performance.now() - began);
      assert.equal((data as { sneaking: boolean }).sneaking, false);
    }
  });
  // use-entity-sneak-in-boat: sneaking=true in use_entity ejects the rider on 1.21.4.
  world.bot.setControlState("sneak", true);
  const packetsBeforeResponse = world.server.packets.length;
  const result = await world.clock.settle(respondFromBoat(world.bot, () => [world.threat], new AbortController().signal, { wallMs: 1_000 }), SETTLE_MS);
  assert.ok(hits.length > 0 && hits[0]! >= 650, "the new sword must have its full cooldown before the first strike");
  assert.equal(world.bot.vehicle?.id, BOAT_ID);
  assert.deepEqual(attackedIds(world.server), [THREAT_ID]);
  assert.equal(result.strikes, 1);
  assert.equal(result.outcome, "timed_out");
  assert.ok(world.server.packets.slice(packetsBeforeResponse).every((packet) =>
    packet.name !== "player_input" && packet.name !== "entity_action"), "the response sends no shift");
});

test("rowing legs start from the boat entity's position", async () => {
  const world = await seatedWithThreat(new Vec3(0.5, 63, 12.5));
  using _timers = world.clock.install();
  world.bot.entity.position.z = 30;
  await world.clock.settle(respondFromBoat(world.bot, () => moves(world).length > 8 ? [] : [world.threat], new AbortController().signal), SETTLE_MS);
  assert.ok(Number(moves(world)[0]!.z) < 3.5, "row away from +z using the boat, not the stale passenger position");
});

test("after a seated fight the navigate resumes the crossing", async () => {
  // Bare hands: the shared fake deliberately refuses unmeasured weapon damage on a boat at take-back.
  const world = await seatedWithThreat(new Vec3(2.5, 62.5, 3.5), { landFromZ: 30 });
  using _timers = world.clock.install();
  await world.clock.settle(respondFromBoat(world.bot, () => [world.threat], new AbortController().signal, { wallMs: 1_000 }), SETTLE_MS);
  assert.equal(world.bot.vehicle?.id, BOAT_ID);
  const result = await world.clock.settle(crossByBoat(world.bot, { x: 0, z: 1 }), SETTLE_MS);
  assert.equal(result.status, "crossed", result.detail);
  assert.ok(world.bot.entity.position.z >= 27);
  assert.equal(world.bot.vehicle, null);
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
  const startedAt = world.clock.now();
  const initialPosition = world.bot.vehicle!.position.clone();
  const result = await world.clock.settle(respondFromBoat(world.bot, () => [world.threat], new AbortController().signal, { wallMs: 600 }), SETTLE_MS);
  assert.equal(result.outcome, "timed_out");
  const packets = world.server.packets.filter((packet) => packet.name === "vehicle_move");
  const lastMovingIndex = packets.findLastIndex((packet, index) => {
    const previous = index === 0 ? initialPosition : packets[index - 1]!.data as { x: number; y: number; z: number };
    const current = packet.data as { x: number; y: number; z: number };
    return current.x !== previous.x || current.y !== previous.y || current.z !== previous.z;
  });
  assert.ok(lastMovingIndex >= 0, "the response rows before reaching its ceiling");
  const stepMs = 50;
  assert.ok(packets[lastMovingIndex]!.atMs - startedAt <= 600 + stepMs,
    "the last moving write is within the ceiling plus one rowing step");
  const firstStopped = packets[lastMovingIndex + 1];
  assert.ok(firstStopped, "the rowing is followed by stopped writes");
  assert.ok(firstStopped.atMs - startedAt <= 600 + stepMs,
    "the stop starts within the ceiling plus one rowing step");
  assert.ok(world.clock.now() - firstStopped.atMs <= (4 + SERVER_ANSWER_TICKS) * stepMs,
    "four stopped writes settle within forty server ticks on the fake clock");
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

test("a diagonal bank beyond the combat distance keeps the seat at sea", async () => {
  const cells: Record<string, string> = {};
  for (let x = -40; x <= 40; x++) for (let z = -40; z <= 45; z++)
    for (let y = 60; y <= 62; y++) cells[`${x},${y},${z}`] = "water";
  cells["30,62,33"] = "stone";
  const world = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), groundY: 59, cells,
    entities: { 7: { name: "oak_boat", position: new Vec3(0.5, 62.52, 3.5) } } });
  world.bot.mount(world.bot.entities[7]!);
  await world.clock.advance(100);
  assert.equal(seatedAtSea(world.bot, 36), true);
  assert.equal(seatedAtSea(world.bot, 43), false);
});

test("a shallow seat with a beach behind and deep water ahead takes the shore path", async () => {
  const world = await mountedSea({ waterDepth: 2, landUntilZ: -3 });
  for (let x = -6; x <= 6; x++) for (let z = 10; z <= 30; z++)
    world.world.setCell(new Vec3(x, 60, z), "water");
  assert.equal(seatedAtSea(world.bot, 8), false);
});

test("a late shield equip cannot start another equip after cancel, death or ceiling", async () => {
  for (const interruption of ["cancel", "death", "ceiling"] as const) {
    const world = await seatedWithThreat(new Vec3(2.5, 62.5, 3.5), { carries: ["iron_sword", "shield"] });
    using _timers = world.clock.install();
    let release = () => {};
    const reply = new Promise<void>((resolve) => { release = resolve; });
    const equip = world.bot.equip.bind(world.bot);
    world.bot.equip = async (item, destination) => {
      if (destination === "off-hand") await reply;
      return equip(item, destination);
    };
    const abort = new AbortController();
    const pending = respondFromBoat(world.bot, () => [world.threat], abort.signal, { wallMs: 200 });
    const ended = interruption === "cancel" ? assert.rejects(pending, /cancelled equip/u) : pending.then(() => undefined);
    if (interruption === "cancel") abort.abort(new Error("cancelled equip"));
    if (interruption === "death") world.combat.setHealth(0);
    await world.clock.settle(ended, 1_000);
    const held = world.bot.heldItem?.name;
    release();
    await world.clock.advance(100);
    assert.equal(world.bot.heldItem?.name, held, `no new equip after ${interruption}`);
    assert.deepEqual(attackedIds(world.server), []);
  }
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

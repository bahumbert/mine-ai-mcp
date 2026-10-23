/**
 * A boat hit by hand takes 10 damage a hit, loses 1 a server tick and breaks once it holds more than 40 (Mine Labs
 * 1.21.4, 2026-10-23): 8 hits 250 ms apart, 9 or 10 hits 300 ms apart, 17 to 19 hits 400 ms apart (a gap of a tick more or less moves it by that much). It breaks at the hit and
 * drops its item (one `oak_boat`) where it stood, which the bot picks up 10 ticks later when in reach (477 to 489 ms
 * measured). A rider is freed on the server and told nothing: no `position`, no passenger list, her client keeps its
 * `vehicle` and her physics stay off, until the next get-off (a position on the shift, or the wait that forgets the boat).
 * A rider sits at the boat: the server moves her client to it when it seats her, 0.41 below the boat's feet.
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";
import { type ContractSubject, holdsWithin } from "../subject.ts";
import { getOffAndStand, mountBoat } from "./boat-seat.ts";

/** Hits to break a boat when they come this many ms apart: the damage decays a point a tick, so 250 and 400 ms tell the rule (17 is exactly 8 ticks apart). */
const HITS_BY_GAP_MS: Readonly<Record<250 | 400, readonly number[]>> = { 250: [8, 9], 400: [17, 18, 19] };
/** The runtime's take-back hits 300 ms apart (`takeBoatBack`); the hit packets' tick alignment makes it the 9th or the 10th. */
const RIDER_HIT_GAP_MS = 300;
const RIDER_HITS = [9, 10];
const MAX_HITS = 40;
/** The drop is picked up after its 10-tick delay: 477 to 489 ms measured from the spawn the client sees. */
const PICKUP_MS = { min: 350, max: 900 } as const;
/** The drop spawns where the boat broke, then drifts a little (0.6 to 0.7 blocks in 0.5 s measured), so a boat out of her reach is not picked up. */
const DROP_DRIFT = 0.5;
/** Where she sits, below the boat's feet (-60.4125 for a boat on the floor at -60, measured). */
const SEAT_BELOW_BOAT = -0.4125;
const SEAT_TOLERANCE = 0.05;
/** The client hears nothing of a broken boat's rider for this long: past any answer of a server on time. */
const QUIET_MS = 2_000;

/** What the client heard while a rider's boat broke, with when. */
interface Heard {
  readonly gone: number[];
  readonly spawned: { readonly entity: Entity; readonly at: Vec3; readonly atMs: number }[];
  readonly positions: number[];
  readonly lists: number[];
  readonly collected: { readonly itemId: number; readonly atMs: number }[];
  readonly boatSlots: number[];
}

/** Listen to the break's messages until `stop`. */
function listen(subject: ContractSubject): { readonly heard: Heard; stop(): void } {
  const { bot } = subject;
  const heard: Heard = { gone: [], spawned: [], positions: [], lists: [], collected: [], boatSlots: [] };
  const onGone = (entity: Entity) => void heard.gone.push(entity.id);
  const onSpawn = (entity: Entity) => void heard.spawned.push({ entity, at: entity.position.clone(), atMs: subject.now() });
  const onPosition = () => void heard.positions.push(subject.now());
  const onList = () => void heard.lists.push(subject.now());
  const onCollect = (_collector: Entity, item: Entity) => void heard.collected.push({ itemId: item.id, atMs: subject.now() });
  const boatItem = bot.registry.itemsByName.oak_boat!.id;
  const onSlot = (slot: number, _old: unknown, next: { type: number } | null) => {
    if (next?.type === boatItem) heard.boatSlots.push(slot);
  };
  bot.on("entityGone", onGone);
  bot.on("entitySpawn", onSpawn);
  bot._client.on("position", onPosition);
  bot._client.on("set_passengers", onList);
  bot.on("playerCollect", onCollect);
  bot.inventory.on("updateSlot", onSlot);
  return {
    heard,
    stop() {
      bot.off("entityGone", onGone);
      bot.off("entitySpawn", onSpawn);
      bot._client.off("position", onPosition);
      bot._client.off("set_passengers", onList);
      bot.off("playerCollect", onCollect);
      bot.inventory.off("updateSlot", onSlot);
    },
  };
}

/** Hit `boat` every `gapMs` until the client no longer has it; the number of hits. */
async function hitUntilGone(subject: ContractSubject, boat: Entity, gapMs: number): Promise<number> {
  const { bot } = subject;
  let hits = 0;
  while (bot.entities[boat.id] !== undefined && hits < MAX_HITS) {
    bot.attack(boat);
    hits += 1;
    await subject.wait(gapMs);
  }
  return hits;
}

/** The fixture's boat standing at `x` `z`. */
function boatAt(subject: ContractSubject, x: number, z: number): Entity {
  const boat = Object.values(subject.bot.entities).find((entity) => entity.name === "oak_boat" && Math.abs(entity.position.x - x) < 0.2 && Math.abs(entity.position.z - z) < 0.2);
  assert.ok(boat !== undefined, `no oak_boat entity at ${x} ${z}`);
  return boat;
}

/** What the client heard of a rider's boat breaking: the boat gone, its item spawned and picked up, nothing for the rider. */
function assertBreakHeard(subject: ContractSubject, heard: Heard, boat: Entity): void {
  const { bot } = subject;
  assert.deepEqual(heard.gone.slice(0, 1), [boat.id], "the boat was not removed first");
  assert.deepEqual(heard.positions, [], "the rider was sent a position");
  assert.deepEqual(heard.lists, [], "the rider was sent a passenger list");
  const drop = heard.spawned.find(({ entity }) => entity.name === "item");
  assert.ok(drop !== undefined, "no item entity after the boat broke");
  assert.ok(drop.at.distanceTo(boat.position) < DROP_DRIFT, `the drop spawned at ${drop.at}, not where the boat was ${boat.position}`);
  assert.deepEqual(heard.collected.map(({ itemId }) => itemId), [drop.entity.id], "the drop was not picked up");
  const pickedUpAfterMs = heard.collected[0]!.atMs - drop.atMs;
  assert.ok(pickedUpAfterMs >= PICKUP_MS.min && pickedUpAfterMs <= PICKUP_MS.max, `picked up ${pickedUpAfterMs} ms after the spawn, not within ${PICKUP_MS.min} to ${PICKUP_MS.max}`);
  assert.equal(heard.boatSlots.length, 1, "the picked up boat did not reach one slot");
  assert.equal(bot.inventory.count(bot.registry.itemsByName.oak_boat!.id, null), 1, "one boat is carried after the pickup");
}

export const boatBrokenByAttack: ContractCheck = {
  name: "boat-broken-by-attack",
  fixture: {
    cells: {},
    carried: {},
    position: [0.5, -60, 0.5],
    entities: [
      { name: "oak_boat", position: [0.5, -60, 2.5] },
      { name: "oak_boat", position: [0.5, -60, -3.5] },
      { name: "oak_boat", position: [-2.5, -60, 0.5] },
    ],
  },
  // Bare bot: our runtime would take the boat back itself (`takeBoatBack`).
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    const boatsInView = () => Object.values(bot.entities).filter((entity) => entity.name === "oak_boat").length;
    assert.ok(await holdsWithin(subject, () => boatsInView() === 3, 5_000), "the fixture's three boats");
    const quick = boatAt(subject, 0.5, 2.5);
    const slow = boatAt(subject, 0.5, -3.5);
    const ridden = boatAt(subject, -2.5, 0.5);
    const quickHits = await hitUntilGone(subject, quick, 250);
    assert.ok(HITS_BY_GAP_MS[250].includes(quickHits), `${quickHits} hits 250 ms apart broke the boat, not ${HITS_BY_GAP_MS[250].join(" or ")}`);
    const slowHits = await hitUntilGone(subject, slow, 400);
    assert.ok(HITS_BY_GAP_MS[400].includes(slowHits), `${slowHits} hits 400 ms apart broke the boat, not ${HITS_BY_GAP_MS[400].join(" to ")}: the damage decays a point a tick`);
    await mountBoat(subject);
    const seat = bot.entity.position;
    assert.ok(Math.hypot(seat.x - ridden.position.x, seat.z - ridden.position.z) < SEAT_TOLERANCE && Math.abs(seat.y - ridden.position.y - SEAT_BELOW_BOAT) < SEAT_TOLERANCE, `she sits at ${seat}, not at the boat ${ridden.position} (0.41 below its feet)`);
    const listening = listen(subject);
    let physicsTicks = 0;
    const onTick = () => void (physicsTicks += 1);
    bot.on("physicsTick", onTick);
    try {
      const hits = await hitUntilGone(subject, ridden, RIDER_HIT_GAP_MS);
      assert.ok(RIDER_HITS.includes(hits), `${hits} hits 300 ms apart broke the boat, not ${RIDER_HITS.join(" or ")}`);
      await holdsWithin(subject, () => listening.heard.collected.length > 0, QUIET_MS);
      assertBreakHeard(subject, listening.heard, ridden);
    } finally {
      listening.stop();
      bot.off("physicsTick", onTick);
    }
    assert.equal(physicsTicks, 0, "her physics ran after the boat broke: the server told her something");
    assert.equal(await subject.seatedOnServer(ridden), false, "the server still has her seated in the boat that broke");
    assert.equal(bot.vehicle?.id, ridden.id, "her client forgot the boat that broke");
    // Next action from here: the get-off still works with no boat, and she stands.
    await getOffAndStand(subject, ridden);
  },
};

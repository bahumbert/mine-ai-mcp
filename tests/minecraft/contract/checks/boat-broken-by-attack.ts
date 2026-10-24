/**
 * A boat hit by hand takes 10 damage a hit, loses 1 a server tick and breaks once it holds more than 40 (Mine Labs
 * 1.21.4, 2026-10-23): 8 hits 250 ms apart, 9 or 10 hits 300 ms apart, 17 to 19 hits 400 ms apart on a server on time. It breaks at
 * the hit and drops its item (one `oak_boat`) where it stood, which the bot picks up 10 ticks later when in reach (477 to 489 ms
 * measured). A rider is freed on the server and told nothing: no `position`, no passenger list, her client keeps its
 * `vehicle` and her physics stay off, until the next get-off (a position on the shift, or the wait that forgets the boat).
 * A rider sits at the boat: the server moves her client to it when it seats her, 0.41 below the boat's feet.
 *
 * The damage decays by the server's ticks, and the ticks between two hits are not the wall time / 50 on a lane (a stall of another
 * lane's `clone` holds fewer in a gap and the catch-up runs them back to back; facts `live-testing.md`, "Ticks between two acts on
 * lanes"). A hit lands with its full 10 only when the player's last attack was 5 ticks ago (the hand's attack speed of 4: the damage
 * is scaled by `0.2 + 0.8 strength^2`, vanilla `Player.attack`, from the source, not measured here; on a lane, hits that a stall
 * queued into a tick or two did not break a boat). So the bot hits once the server has run 5 ticks since its last hit, whatever the wall
 * time, and what the boat holds after each hit is computed from the server's tick read right before each (strength and decay, with the
 * readings' error taken in the boat's favour both ways): the boat must break at a hit that could have broken it and not long after one
 * that must have. The drop's pickup is judged by the tick read when the client heard it.
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";
import { ANSWER_WALL_MS } from "../server-answer.ts";
import { type ContractSubject, holdsWithin } from "../subject.ts";
import { getOffAndStand, mountBoat } from "./boat-seat.ts";
import { type Mark, READING_TICKS, markNow, restTicksSince, tickOf } from "./server-tick-marks.ts";

/** What a full hit by hand costs a boat, what it loses a server tick, and the damage it breaks above. */
const HIT_DAMAGE = 10;
const DECAY_PER_TICK = 1;
const BREAKS_ABOVE = 40;
/** Ticks after which the player's swing is full again (the hand's attack speed of 4): a hit sooner weighs `0.2 + 0.8 strength^2` of a full one. */
const SWING_RECOVERY_TICKS = 5;
const MAX_HITS = 40;
/** A reading is the act's own tick or up to `READING_TICKS` before it (it is sent right before the act). */
const READING_OFFSETS = Array.from({ length: READING_TICKS + 1 }, (_, offset) => offset);
/** The drop is picked up after its 10-tick delay (477 to 489 ms measured from the spawn the client sees). */
const DROP_PICKUP_DELAY_TICKS = 10;
/** The drop spawns where the boat broke, then drifts a little (0.6 to 0.7 blocks in 0.5 s measured), so a boat out of her reach is not picked up. */
const DROP_DRIFT = 0.5;
/** Where she sits, below the boat's feet (-60.4125 for a boat on the floor at -60, measured). */
const SEAT_BELOW_BOAT = -0.4125;
const SEAT_TOLERANCE = 0.05;
/** The reading of the break is the hit's, which is the break's own tick to within `READING_TICKS`, and the pickup's is never earlier than the pickup: the delay less the error. */
const PICKUP_AFTER_BREAK_MIN_TICKS = DROP_PICKUP_DELAY_TICKS - READING_TICKS;
/** The boat she rides, arena-local. */
const RIDDEN_AT = [-2.5, -60, 0.5] as const;

/** What the client heard while a rider's boat broke, with when. */
interface Heard {
  readonly gone: number[];
  readonly spawned: { readonly entity: Entity; readonly at: Vec3 }[];
  readonly positions: number[];
  readonly lists: number[];
  readonly collected: { readonly itemId: number; readonly heard: Mark }[];
  readonly boatSlots: number[];
}

/** Listen to the break's messages until `stop`. */
function listen(subject: ContractSubject): { readonly heard: Heard; stop(): void } {
  const { bot } = subject;
  const heard: Heard = { gone: [], spawned: [], positions: [], lists: [], collected: [], boatSlots: [] };
  const onGone = (entity: Entity) => void heard.gone.push(entity.id);
  const onSpawn = (entity: Entity) => void heard.spawned.push({ entity, at: entity.position.clone() });
  const onPosition = () => void heard.positions.push(subject.now());
  const onList = () => void heard.lists.push(subject.now());
  const onCollect = (_collector: Entity, item: Entity) => void heard.collected.push({ itemId: item.id, heard: markNow(subject) });
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

/** The hits on a boat: the server's tick read right before each, and when the client sent it. */
interface Hits {
  readonly ticks: readonly number[];
  readonly marks: readonly Mark[];
}

/** Hit `boat`, each once the server has run `SWING_RECOVERY_TICKS` since the last hit (the wall time they take does not matter), until the client no longer has it (at most `MAX_HITS`); the hits. */
async function hitUntilGone(subject: ContractSubject, boat: Entity): Promise<Hits> {
  const { bot } = subject;
  const marks: Mark[] = [];
  while (bot.entities[boat.id] !== undefined && marks.length < MAX_HITS) {
    marks.push(markNow(subject));
    bot.attack(boat);
    await restTicksSince(subject, marks.at(-1)!, SWING_RECOVERY_TICKS, "the boat's hit");
  }
  return { ticks: await Promise.all(marks.map((mark) => tickOf(subject, mark))), marks };
}

/** What a hit costs a boat when the player's last attack was `ticksSince` ticks before it. */
function hitDamage(ticksSince: number): number {
  const strength = Math.min(1, (ticksSince + 0.5) / SWING_RECOVERY_TICKS);
  return HIT_DAMAGE * (0.2 + 0.8 * strength ** 2);
}

/**
 * The least and the most damage the boat can hold right after each hit, from the ticks read right before them: each hit adds its damage
 * to what the ticks since the last left (the decay stops at nothing), and every act ran 0 to `READING_TICKS` after its reading, which
 * moves the gaps between the hits (its strength) as well as the decay. The first hit is a full one.
 */
export function damageBounds(reads: readonly number[]): { readonly low: readonly number[]; readonly high: readonly number[] } {
  let low = READING_OFFSETS.map(() => 0);
  let high = READING_OFFSETS.map(() => 0);
  const lows: number[] = [];
  const highs: number[] = [];
  for (const [index, read] of reads.entries()) {
    const after = (held: number, offset: number, previousOffset: number): number => {
      if (index === 0) return HIT_DAMAGE;
      const gap = Math.max(0, read + offset - reads[index - 1]! - previousOffset);
      return Math.max(0, held - DECAY_PER_TICK * gap) + hitDamage(gap);
    };
    const [nextLow, nextHigh] = [low, high].map((held, side) => READING_OFFSETS.map((offset) => (side === 0 ? Math.min : Math.max)(...READING_OFFSETS.map((previous) => after(held[previous]!, offset, previous)))));
    [low, high] = [nextLow!, nextHigh!];
    lows.push(Math.min(...low));
    highs.push(Math.max(...high));
  }
  return { low: lows, high: highs };
}

/** What both sides saw of the hits, for a failure: the ticks read and when the client hit. */
function describeHits({ ticks, marks }: Hits): string {
  return `server ticks read before the hits ${ticks.join(", ")}; the client hit at ${marks.map(({ atMs }) => `+${Math.round(atMs - marks[0]!.atMs)} ms`).join(", ")}`;
}

/**
 * Assert the boat broke by the last hit, and not long after a hit that must have broken it. The client hears the break a moment after it, so it may hit once more (a stalled server holds its queued hits in the
 * break's own tick); a boat the ticks say was broken for more than that, or could not be broken yet, fails.
 */
function assertBrokeWhenTheTicksSay(hits: Hits): void {
  const { low, high } = damageBounds(hits.ticks);
  const earliest = high.findIndex((held) => held > BREAKS_ABOVE);
  assert.ok(earliest >= 0, `the boat broke by hit ${high.length} though no hit left more than ${Math.max(...high).toFixed(1)} damage, ${BREAKS_ABOVE} breaks it: ${describeHits(hits)}`);
  const mustHaveBroken = low.findIndex((held) => held > BREAKS_ABOVE);
  if (mustHaveBroken >= 0) {
    const ticksLater = hits.ticks.at(-1)! - hits.ticks[mustHaveBroken]!;
    const allowed = SWING_RECOVERY_TICKS + 2 * READING_TICKS;
    assert.ok(ticksLater <= allowed, `hit ${mustHaveBroken + 1} left at least ${low[mustHaveBroken]!.toFixed(1)} damage, more than the ${BREAKS_ABOVE} that breaks a boat, yet the client hit ${high.length - mustHaveBroken - 1} more times, up to ${ticksLater} ticks later, before the boat was gone (at most ${allowed}): ${describeHits(hits)}`);
  }
}

/** The fixture's boat standing at `x` `z`. */
function boatAt(subject: ContractSubject, x: number, z: number): Entity {
  const at = subject.world([x, -60, z]);
  const boat = Object.values(subject.bot.entities).find((entity) => entity.name === "oak_boat" && Math.abs(entity.position.x - at.x) < 0.2 && Math.abs(entity.position.z - at.z) < 0.2);
  assert.ok(boat !== undefined, `no oak_boat entity at ${at.x} ${at.z}`);
  return boat;
}

/** Hit `boat` until it is gone and assert it broke when the server's ticks say; the hits. */
async function breakByHits(subject: ContractSubject, boat: Entity): Promise<Hits> {
  const hits = await hitUntilGone(subject, boat);
  assert.equal(subject.bot.entities[boat.id], undefined, `${MAX_HITS} hits did not break the boat; the ticks left it at most ${Math.max(...damageBounds(hits.ticks).high).toFixed(1)} damage, ${BREAKS_ABOVE} breaks it (a server too slow to hold hits 5 ticks apart, not a fault of the boat): ${describeHits(hits)}`);
  assertBrokeWhenTheTicksSay(hits);
  return hits;
}

/**
 * What the client heard of a rider's boat breaking: the boat gone, its item spawned and picked up, nothing for the rider. The item waits
 * its delay from the break, which was at the last hit or the one before (the client hits once more at most before it hears the removal);
 * the pickup is read when the client heard it, so it is never early, and late only by the lag that the wait's wall bound holds.
 */
async function assertBreakHeard(subject: ContractSubject, heard: Heard, boat: Entity, hits: Hits): Promise<void> {
  const { bot } = subject;
  assert.deepEqual(heard.gone.slice(0, 1), [boat.id], "the boat was not removed first");
  assert.deepEqual(heard.positions, [], "the rider was sent a position");
  assert.deepEqual(heard.lists, [], "the rider was sent a passenger list");
  const drop = heard.spawned.find(({ entity }) => entity.name === "item");
  assert.ok(drop !== undefined, "no item entity after the boat broke");
  assert.ok(drop.at.distanceTo(boat.position) < DROP_DRIFT, `the drop spawned at ${drop.at}, not where the boat was ${boat.position}`);
  assert.deepEqual(heard.collected.map(({ itemId }) => itemId), [drop.entity.id], "the drop was not picked up");
  const brokeAfter = Math.max(0, hits.ticks.length - 2);
  const couldHaveBrokenAtTick = hits.ticks[brokeAfter]!;
  const pickedUpAtTick = await tickOf(subject, heard.collected[0]!.heard);
  const pickedUpAfterTicks = pickedUpAtTick - couldHaveBrokenAtTick;
  assert.ok(
    pickedUpAfterTicks >= PICKUP_AFTER_BREAK_MIN_TICKS,
    `picked up at server tick ${pickedUpAtTick}, ${pickedUpAfterTicks} ticks after the boat could have broken (hit ${brokeAfter + 1}, tick ${couldHaveBrokenAtTick}, ${Math.round(heard.collected[0]!.heard.atMs - hits.marks[brokeAfter]!.atMs)} ms before by the client): the item waits ${DROP_PICKUP_DELAY_TICKS} ticks, not less than ${PICKUP_AFTER_BREAK_MIN_TICKS} (readings +-${READING_TICKS})`,
  );
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
      { name: "oak_boat", position: [...RIDDEN_AT] },
    ],
  },
  // Bare bot: our runtime would take the boat back itself (`takeBoatBack`).
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    const boatsInView = () => Object.values(bot.entities).filter((entity) => entity.name === "oak_boat").length;
    assert.ok(await holdsWithin(subject, () => boatsInView() === 2, 5_000), "the fixture's two boats");
    const quick = boatAt(subject, 0.5, 2.5);
    const ridden = boatAt(subject, RIDDEN_AT[0], RIDDEN_AT[2]);
    await breakByHits(subject, quick);
    await mountBoat(subject, RIDDEN_AT);
    const seat = bot.entity.position;
    assert.ok(Math.hypot(seat.x - ridden.position.x, seat.z - ridden.position.z) < SEAT_TOLERANCE && Math.abs(seat.y - ridden.position.y - SEAT_BELOW_BOAT) < SEAT_TOLERANCE, `she sits at ${seat}, not at the boat ${ridden.position} (0.41 below its feet)`);
    const listening = listen(subject);
    let physicsTicks = 0;
    const onTick = () => void (physicsTicks += 1);
    bot.on("physicsTick", onTick);
    try {
      const hits = await breakByHits(subject, ridden);
      await holdsWithin(subject, () => listening.heard.collected.length > 0, ANSWER_WALL_MS);
      await assertBreakHeard(subject, listening.heard, ridden, hits);
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

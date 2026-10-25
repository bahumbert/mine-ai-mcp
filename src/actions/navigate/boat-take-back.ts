/** The boat back: broken by hand, its item picked up (spec 2026-10-04 deep-water-and-boats); the bound is time, and the report says how it went. */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { swimToDrop } from "../../navigation/mineflayer/swim-to-drop.js";
import { droppedItemName, isItemEntity } from "../../world/item-pickup.js";
import { BOAT_REACH, boatsCarried, isBoatItemName } from "./boat-entities.js";

/** How far a dropped boat is swum after: one that drifted off the bank (live 2026-10-04: 4 blocks out). */
const DROP_REACH = 10;
/** Pause after each hit: 6 ticks on a server on time, a full hit's weight (contract boat-broken-by-attack: 9-10 hits at 300 ms). */
const HIT_EVERY_MS = 300;
/**
 * The longest the hits go on, counted from the first on the wall clock. A boat breaks above 40 damage, loses 1 a server
 * tick, and a full hand hit adds 10; one sooner than 5 ticks after the last adds `0.2 + 0.8 strength^2` of that (contract
 * check boat-broken-by-attack: 8 hits 250 ms apart, 9-10 at 300 ms, 17-19 at 400 ms, server on time; the strength rule
 * read in Player.attack). The hits a stalled server queues land in one tick at a fifth of a hit each, so a count of
 * hits is no measure of damage: the bound is time (run 20; Dirk's take-back failed, its cause unproven).
 */
export const TAKE_BACK_WALL_MS = 10_000;

export interface TakeBackOptions {
  /** Pause after the last hit for the item to be picked up (default 1500 ms). */
  readonly settleMs?: number;
  /** Stop after this many hits, if the wall bound has not (the hostile reflex: a mob attacks meanwhile). */
  readonly maxHits?: number;
}

/** What a take-back did: the boat carried again or not, and the hits sent, their time and the hit after which the boat left her client. */
export interface TakeBackReport {
  /** One more boat is carried than before (counted: another boat may be carried). */
  readonly carried: boolean;
  readonly hits: number;
  /** From the first hit to the end of the hits. */
  readonly elapsedMs: number;
  /** The hit after which the boat entity left her client; null when it was present at every hit (or never hit). */
  readonly goneAfterHit: number | null;
}

/** Waits `ms`, or until `signal` aborts: a cancel does not wait out a pause. Never rejects. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Hits `boat` every {@link HIT_EVERY_MS} while it is in her client, until the wall bound, `maxHits` or an abort. */
async function hitUntilGone(bot: Bot, boat: Entity | null, signal: AbortSignal | undefined, maxHits: number | undefined): Promise<Omit<TakeBackReport, "carried">> {
  const present = () => boat !== null && bot.entities[boat.id] !== undefined;
  let hits = 0;
  let startedAt: number | null = null;
  const elapsed = () => (startedAt === null ? 0 : Math.round(performance.now() - startedAt));
  while (boat !== null && present() && !signal?.aborted && hits < (maxHits ?? Number.POSITIVE_INFINITY) && elapsed() < TAKE_BACK_WALL_MS) {
    startedAt ??= performance.now();
    await bot.lookAt(boat.position.offset(0, 0.3, 0), true);
    bot.attack(boat);
    hits += 1;
    await pause(HIT_EVERY_MS, signal);
  }
  return { hits, elapsedMs: elapsed(), goneAfterHit: hits > 0 && !present() ? hits : null };
}

/**
 * The boat back: broken by hand, it drops and is picked up, swum after when it floats off. The hits go on until the
 * boat is gone or {@link TAKE_BACK_WALL_MS} passes (`maxHits` caps them for a caller that cannot wait). A cancel stops
 * the hits, the pauses and the swim at once.
 */
export async function takeBoatBackReport(bot: Bot, boat: Entity | null, signal?: AbortSignal, options: TakeBackOptions = {}): Promise<TakeBackReport> {
  const before = boatsCarried(bot);
  const hitting = await hitUntilGone(bot, boat, signal, options.maxHits);
  await pause(options.settleMs ?? 1500, signal);
  // Its item floated off before it was picked up: swum after, a few blocks of the water by the bank.
  if (boatsCarried(bot) <= before && !signal?.aborted) {
    await swimToDrop(bot, (item) => isBoatItemName(item.name), DROP_REACH, () => boatsCarried(bot) > before || signal?.aborted === true, 15_000);
  }
  return { carried: boatsCarried(bot) > before, ...hitting };
}

/** {@link takeBoatBackReport}, answering only whether one more boat is carried. */
export async function takeBoatBack(bot: Bot, boat: Entity | null, signal?: AbortSignal, options: TakeBackOptions = {}): Promise<boolean> {
  return (await takeBoatBackReport(bot, boat, signal, options)).carried;
}

/** Why a boat was left: it was not near, it is still under her or floating beside her after the hits, or it broke and its item was not picked up. */
export type BoatLeftCause = "not_found" | "still_there" | "left_nearby" | "item_not_picked_up";

/** A boat the crossing could not take back: the reason in words for the model, and what the take-back measured. */
export interface BoatLeft {
  readonly cause: BoatLeftCause;
  readonly reason: string;
  readonly hits: number;
  readonly elapsedMs: number;
  /** The hit after which the boat left her client; null when it never did. */
  readonly goneAfterHit: number | null;
}

/** A dropped boat item in her view, the nearest first: the boat that broke and was not picked up. */
function nearestDroppedBoat(bot: Bot): Entity | undefined {
  return Object.values(bot.entities)
    .filter((entity) => isItemEntity(entity) && isBoatItemName(droppedItemName(entity)))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
}

/** What the take-back found when it ended: the boat it hit (null: none lay near), whether it lies under her feet, whether a cancel cut the hits short. */
export interface TakeBackSituation {
  readonly boat: Entity | null;
  readonly underFeet: boolean;
  readonly cancelled: boolean;
}

/**
 * Why the take-back that `report` describes did not leave one more boat carried. `boat` is the one that lay within
 * {@link BOAT_REACH} of where the ride stopped when the hits began, `underFeet` whether it lies under her now (the next
 * movement takes only such a boat back).
 */
export function boatLeftAfter(bot: Bot, report: TakeBackReport, { boat, underFeet, cancelled }: TakeBackSituation): BoatLeft {
  const { hits, elapsedMs, goneAfterHit } = report;
  const measured = { hits, elapsedMs, goneAfterHit };
  if (goneAfterHit !== null) {
    const item = nearestDroppedBoat(bot);
    const where = item === undefined ? "no item in view: it drifted off or someone else took it" : `an item ${Math.round(item.position.distanceTo(bot.entity.position))} blocks off`;
    const next = item === undefined ? "" : ": walk there to pick it up";
    return { cause: "item_not_picked_up", reason: `the boat broke after hit ${goneAfterHit} but its item was not picked up (${where})${next}`, ...measured };
  }
  if (boat === null) return { cause: "not_found", reason: `the boat was not found within ${BOAT_REACH} blocks of where the ride stopped; it is lost`, ...measured };
  const after = `after ${hits} hits in ${(elapsedMs / 1000).toFixed(1)} s${cancelled ? " (the take-back was cancelled)" : ""}`;
  if (underFeet) return { cause: "still_there", reason: `the boat is still under you ${after}`, ...measured };
  const apart = Math.round(boat.position.distanceTo(bot.entity.position));
  return { cause: "left_nearby", reason: `the boat is still floating ${apart} blocks away ${after}; it is not under you, so the next movement leaves it`, ...measured };
}

/** The line of a navigate result that says a boat ridden across was not taken back and why; a boat still under her is taken back by the next movement. */
export function describeBoatLeft(left: BoatLeft): string {
  const next = left.cause === "still_there" ? ". The next movement tries to take it back again." : "";
  return `- The boat was not picked back up: ${left.reason}${next}`;
}

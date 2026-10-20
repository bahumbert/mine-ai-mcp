/**
 * A threat while seated in a boat: strike what is in reach, else row away over open water, never get off (owner
 * 2026-10-19). The shift would put her in the water beside the monster, the boat lost; the boat is hers to fight from.
 * Every wait here runs on the wall clock: no physics tick comes while seated.
 */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { equipCombatLoadout, MELEE_RANGE, readCombatItems, selectMeleeLoadout } from "../../survival/weapons/equipment.js";
import { BoatRide, isBoatEntity } from "./boat-crossing.js";
import { currentVehicle } from "./vehicle-sync.js";

/** Longest one response lasts on the wall clock, whatever the threat does. */
export const SEATED_RESPONSE_WALL_MS = 20_000;
/** Blocks one rowing leg goes before the threat is looked at again. */
export const SEATED_ROW_BLOCKS = 24;
/** A server tick: the pace of the looks at the threats and the unit of a weapon's cooldown. */
const TICK_MS = 50;
/** Eye height above her feet, from which a strike's reach is measured. */
const EYE_HEIGHT = 1.62;
/** Turns tried, in degrees from straight away, until the water two blocks ahead is open. */
const ROW_TURNS = [0, 45, -45, 90, -90] as const;

/**
 * How a response ended: `struck` or `rowed` (or `clear`) when the threats are gone, `died`, `timed_out` at the wall
 * ceiling, `unseated` when the boat is no longer under her (broken by someone else).
 */
export type SeatedResponse = "clear" | "struck" | "rowed" | "died" | "timed_out" | "unseated";

export interface SeatedThreat {
  readonly id: number;
  readonly position: Vec3;
}

export interface SeatedOutcome {
  readonly outcome: SeatedResponse;
  readonly strikes: number;
  /** Blocks rowed away from the threats. */
  readonly rowed: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const turned = (way: { readonly x: number; readonly z: number }, degrees: number): { readonly x: number; readonly z: number } => {
  const angle = (degrees * Math.PI) / 180;
  return { x: way.x * Math.cos(angle) - way.z * Math.sin(angle), z: way.x * Math.sin(angle) + way.z * Math.cos(angle) };
};

/**
 * Rows the boat she sits in up to `blocks` away along `away` (a horizontal unit vector), turned 45 or 90 degrees either
 * way where the water two blocks ahead is shore; the boat is stopped at the end. `stoppedBy` is "" at the distance.
 */
export async function rowBoat(bot: Bot, away: { readonly x: number; readonly z: number }, blocks: number, signal: AbortSignal): Promise<{ readonly rowed: number; readonly stoppedBy: string }> {
  const boat = currentVehicle(bot);
  if (boat === null || !isBoatEntity(boat)) return { rowed: 0, stoppedBy: "not seated in a boat" };
  for (const degrees of ROW_TURNS) {
    const ride = new BoatRide(bot, boat, turned(away, degrees), boat.position, signal);
    try {
      if (!ride.waterAheadOpen()) continue;
      const stoppedBy = await ride.row(blocks);
      // A boat she left in her death is nobody's to stop.
      if (!ride.died) await ride.end();
      return { rowed: ride.ridden, stoppedBy };
    } finally {
      ride.close();
    }
  }
  return { rowed: 0, stoppedBy: "no open water away from the threat" };
}

/** The horizontal unit vector from the threats' centre to her; straight on +z when they stand on her. */
function awayFrom(bot: Bot, threats: readonly SeatedThreat[]): { readonly x: number; readonly z: number } {
  const centre = threats.reduce((sum, threat) => ({ x: sum.x + threat.position.x / threats.length, z: sum.z + threat.position.z / threats.length }), { x: 0, z: 0 });
  const [dx, dz] = [bot.entity.position.x - centre.x, bot.entity.position.z - centre.z];
  const length = Math.hypot(dx, dz);
  return length < 1e-6 ? { x: 0, z: 1 } : { x: dx / length, z: dz / length };
}

/** What the strikes so far leave: how many, when the last landed, and the weapon equipped once. */
interface StrikeState {
  strikes: number;
  lastStrikeAt: number;
  loadout: ReturnType<typeof selectMeleeLoadout> | null;
}

/** One strike at `threat` if the weapon's cooldown has passed (wall clock): equipped on the first, looked at, hit. */
async function strikeWhenReady(bot: Bot, state: StrikeState, threat: SeatedThreat, target: Entity): Promise<void> {
  if (state.loadout === null) {
    state.loadout = selectMeleeLoadout(readCombatItems(bot));
    await equipCombatLoadout(bot, state.loadout);
  }
  if (performance.now() - state.lastStrikeAt < state.loadout.cooldownTicks * TICK_MS) return;
  await bot.lookAt(threat.position.offset(0, 1, 0), true);
  bot.attack(target);
  state.strikes += 1;
  state.lastStrikeAt = performance.now();
}

/**
 * Responds to `threats()` from the boat she sits in until none is left (within `hostileRadius`, default: every one the
 * caller lists), she dies, the boat is gone from under her or `wallMs` passes. An abort stops the boat and rejects with
 * its reason. Strikes use the melee loadout, one per its cooldown on the wall clock.
 */
export async function respondFromBoat(
  bot: Bot,
  threats: () => readonly SeatedThreat[],
  signal: AbortSignal,
  options: { readonly wallMs?: number; readonly hostileRadius?: number } = {},
): Promise<SeatedOutcome> {
  const ceiling = AbortSignal.any([signal, AbortSignal.timeout(options.wallMs ?? SEATED_RESPONSE_WALL_MS)]);
  const radius = options.hostileRadius ?? Number.POSITIVE_INFINITY;
  let died = false;
  const onDeath = () => {
    died = true;
  };
  const state: StrikeState = { strikes: 0, lastStrikeAt: Number.NEGATIVE_INFINITY, loadout: null };
  let rowed = 0;
  const result = (outcome: SeatedResponse): SeatedOutcome => ({ outcome, strikes: state.strikes, rowed });
  bot.once("death", onDeath);
  try {
    for (;;) {
      signal.throwIfAborted();
      if (died) return result("died");
      if (!isBoatEntity(currentVehicle(bot))) return result("unseated");
      if (ceiling.aborted) return result("timed_out");
      const near = threats().filter((threat) => threat.position.distanceTo(bot.entity.position) <= radius);
      if (near.length === 0) return result(state.strikes > 0 ? "struck" : rowed > 0 ? "rowed" : "clear");
      const reach = near.filter((threat) => threat.position.distanceTo(bot.entity.position.offset(0, EYE_HEIGHT, 0)) <= MELEE_RANGE);
      const target = reach.length > 0 ? bot.entities[reach[0]!.id] : undefined;
      if (reach.length === 0) {
        rowed += (await rowBoat(bot, awayFrom(bot, near), SEATED_ROW_BLOCKS, ceiling)).rowed;
      } else if (target !== undefined) {
        await strikeWhenReady(bot, state, reach[0]!, target);
      }
      await sleep(TICK_MS);
    }
  } finally {
    bot.off("death", onDeath);
  }
}

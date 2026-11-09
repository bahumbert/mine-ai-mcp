/**
 * A threat while seated in a boat: strike what is in reach, else row away over open water, never get off (owner
 * 2026-10-19). The shift would put her in the water beside the monster, the boat lost; the boat is hers to fight from.
 * Every wait here runs on the wall clock: no physics tick comes while seated.
 */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { equipCombatLoadout, MELEE_RANGE, readCombatItems, permittedMeleeLoadout } from "../../survival/weapons/equipment.js";
import { DEFAULT_COMBAT_POLICY, type CombatPolicy } from "../../survival/policy/combat/contract.js";
import { BoatRide } from "./boat-crossing.js";
import { atSeaFrom } from "./boat-at-sea.js";
import { isBoatEntity } from "./boat-entities.js";
import { currentVehicle } from "./vehicle-sync.js";
import { monotonicNow, raceSignal, sleepMs } from "../../utils/index.js";

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
export type SeatedResponse = "clear" | "struck" | "rowed" | "died" | "timed_out" | "unseated" | "cancelled";

export interface SeatedThreat {
  readonly id: number;
  readonly position: Vec3;
}

export interface SeatedOutcome {
  readonly outcome: SeatedResponse;
  readonly strikes: number;
  /** Blocks rowed away from the threats. */
  readonly rowed: number;
  readonly weaponsUsed: readonly string[];
}

/** Deep water with no observed bank in the combat policy's shore search range keeps the seat. */
export function seatedAtSea(bot: Bot, safeRange: number): boolean {
  const boat = currentVehicle(bot);
  if (!isBoatEntity(boat) || !boat) return false;
  return atSeaFrom(bot, boat.position, safeRange);
}

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
  const origin = currentVehicle(bot)?.position ?? bot.entity.position;
  const [dx, dz] = [origin.x - centre.x, origin.z - centre.z];
  const length = Math.hypot(dx, dz);
  return length < 1e-6 ? { x: 0, z: 1 } : { x: dx / length, z: dz / length };
}

/** What the strikes so far leave: how many, when the last landed, and the weapon equipped once. */
interface StrikeState {
  strikes: number;
  lastStrikeAt: number;
  loadout: ReturnType<typeof permittedMeleeLoadout> | null;
  readonly weaponsUsed: Set<string>;
}

/** One strike at `threat` if the weapon's cooldown has passed (wall clock): equipped on the first, looked at, hit. */
async function strikeWhenReady(bot: Bot, state: StrikeState, target: Entity, policy: Readonly<CombatPolicy>, signal: AbortSignal): Promise<void> {
  if (state.loadout === null) {
    state.loadout = permittedMeleeLoadout(bot, readCombatItems(bot), policy);
    const previous = bot.heldItem?.name ?? null;
    await equipCombatLoadout(bot, state.loadout, signal);
    if (previous !== (bot.heldItem?.name ?? null)) state.lastStrikeAt = monotonicNow();
  }
  if (monotonicNow() - state.lastStrikeAt < state.loadout.cooldownTicks * TICK_MS) return;
  await raceSignal(bot.lookAt(target.position.offset(0, 1, 0), true), signal);
  signal.throwIfAborted();
  if (!target.isValid || !isBoatEntity(currentVehicle(bot))) return;
  // use-entity-sneak-in-boat: this field alone ejects a rider on 1.21.4 (T10a, 2026-11-08).
  bot._client.write("use_entity", { target: target.id, mouse: 1, sneaking: false });
  bot.swingArm("right");
  state.strikes += 1;
  state.weaponsUsed.add(bot.heldItem?.name ?? "hand");
  state.lastStrikeAt = monotonicNow();
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
  options: { readonly wallMs?: number; readonly hostileRadius?: number; readonly policy?: Readonly<CombatPolicy>; readonly rowOnly?: boolean; readonly attackTargetId?: number; readonly settleOnAbort?: boolean } = {},
): Promise<SeatedOutcome> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), options.wallMs ?? SEATED_RESPONSE_WALL_MS);
  const ceiling = AbortSignal.any([signal, stop.signal]);
  const policy = options.policy ?? DEFAULT_COMBAT_POLICY;
  const radius = options.hostileRadius ?? Number.POSITIVE_INFINITY;
  let died = false;
  const onDeath = () => {
    died = true;
    stop.abort();
  };
  const state: StrikeState = { strikes: 0, lastStrikeAt: Number.NEGATIVE_INFINITY, loadout: null, weaponsUsed: new Set() };
  let rowed = 0;
  const result = (outcome: SeatedResponse): SeatedOutcome => ({ outcome, strikes: state.strikes, rowed, weaponsUsed: [...state.weaponsUsed] });
  bot.once("death", onDeath);
  try {
    for (;;) {
      signal.throwIfAborted();
      if (died) return result("died");
      if (!isBoatEntity(currentVehicle(bot))) return result("unseated");
      if (ceiling.aborted) return result("timed_out");
      const origin = currentVehicle(bot)!.position;
      const near = threats().filter((threat) => threat.position.distanceTo(origin) <= radius);
      if (near.length === 0) return result(state.strikes > 0 ? "struck" : rowed > 0 ? "rowed" : "clear");
      const reach = options.rowOnly || !policy.melee ? [] : near.filter((threat) =>
        (options.attackTargetId === undefined || threat.id === options.attackTargetId) &&
        threat.position.distanceTo(origin.offset(0, EYE_HEIGHT, 0)) <= MELEE_RANGE);
      const target = reach.length > 0 ? bot.entities[reach[0]!.id] : undefined;
      if (reach.length === 0 && policy.retreat)
        rowed += (await rowBoat(bot, awayFrom(bot, near), SEATED_ROW_BLOCKS, ceiling)).rowed;
      if (target !== undefined) await strikeWhenReady(bot, state, target, policy, ceiling);
      await sleepMs(TICK_MS, ceiling);
    }
  } catch (cause) {
    if (signal.aborted && options.settleOnAbort) return result(died ? "died" : "cancelled");
    signal.throwIfAborted();
    if (died) return result("died");
    if (ceiling.aborted) return result("timed_out");
    throw cause;
  } finally {
    clearTimeout(timer);
    bot.off("death", onDeath);
  }
}

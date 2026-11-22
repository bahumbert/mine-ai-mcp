// The first-air-packet allowance of a dive from a dry start: how long and how far a leg may go on before the server's first air packet.
import type { Bot } from "mineflayer";
import { type FullAirProof, fullAirProofHolds, readAirSupply } from "../world/air-supply.js";
import { hasQualifiedEyeWaterSample } from "../world/eyes-in-water.js";
import { type ServerPacedSignal, serverPacedSignal } from "../world/server-paced.js";
import { AGE_PACKET_TICKS, STALE_AGE_TICKS, serverPacedWallMs } from "../world/world-age.js";
import { DIVE_RESERVE_TICKS } from "./world/swimming.js";
import type { WorldView } from "./world/world.js";

/** A full meter (`LivingEntity.getMaxAirSupply`). */
const FULL_AIR_TICKS = 300;

/**
 * Whether a dive may go on through the first-air-packet gap: the air it can have lost since its last dry proof, `charge`,
 * leaves more than the way up and the reserve. Strict, like the stop it replaces (`observeDiveTick`: a stop at air <= ascent + reserve).
 */
export function provisionalAirAllows(ascentTicks: number, charge: number): boolean {
  return FULL_AIR_TICKS - charge > ascentTicks + DIVE_RESERVE_TICKS;
}

/**
 * The air a first wet read can have lost before the server's first packet reaches the client. The client's physics can see
 * the head wet one tick before its position reaches the server (`physics.js:79-90`), so the server counts the first breath
 * later and the client hears it with the next packet. Counted in server ticks: the proof's age to the entry's, then two
 * packet intervals (the first qualifying age packet is +40 from the packet the budget started on), one stale-age interval
 * for a cached age, and one tick for the 50 ms look cadence. The real packet timing behind these terms is **(unverified)**:
 * no contract check has measured it yet, so the price is a conservative bound, not a measurement.
 */
function firstAirCharge(proofAge: number, entryAge: number): number {
  return entryAge - proofAge + 2 * AGE_PACKET_TICKS + STALE_AGE_TICKS + 1;
}

/** A private allowance of the active leg: what it may have lost, until which age it holds, and how it is released. */
interface Allowance {
  readonly charge: number;
  readonly budget: ServerPacedSignal;
  lastAge: number;
  readonly release: () => void;
}

/** What `FirstDiveAir` needs of the dive that owns it. */
export interface FirstDiveAirParts {
  readonly bot: Bot;
  readonly world: WorldView;
  /** The signal that ends the active leg (its stop token, the run's lifetime, the process stop); read when an allowance starts. */
  readonly leg: () => AbortSignal;
  /** The leg's own decision (`observeDiveTick`), run again when a packet, a block, a chunk or the deadline changes what it saw. */
  readonly decide: () => void;
}

/**
 * A dry start's first dive air (T31c-air 2026-11-20). While the head is in air and T31a infers full air, it keeps the age of
 * its latest proof. At the first wet read of an owned committed leg with a verified ascent, no own air and a fresh proof of
 * the same body, it lets the leg go on for one window, priced as `firstAirCharge`. The allowance is private to the leg: the
 * air stays unknown to planning, work, the backstop, refill, view status and incident reports. A numeric air, the window's
 * end, a lost escape, a death or a respawn, a stop of the leg and disposal end it.
 */
export class FirstDiveAir implements Disposable {
  #proof: FullAirProof | null = null;
  #allowance: Allowance | null = null;
  constructor(readonly parts: FirstDiveAirParts) {}

  get active(): boolean { return this.#allowance !== null; }

  /** Keep the proof of a loaded, qualified, dry read that shows T31a's inferred full air; any other read leaves it as it was. */
  captureDry(feet: { readonly x: number; readonly y: number; readonly z: number }): void {
    const { bot, world } = this.parts;
    if (!hasQualifiedEyeWaterSample(bot)) return;
    const [x, y, z] = [Math.floor(feet.x), Math.floor(feet.y), Math.floor(feet.z)];
    if (world.blockAt(x, y, z).kind !== "loaded" || world.blockAt(x, y + 1, z).kind !== "loaded") return;
    const reading = readAirSupply(bot);
    if (reading.kind === "inferred-full" && Number.isFinite(reading.proof.age)) this.#proof = reading.proof;
  }

  /**
   * Whether the leg may go on with the head wet and the air unknown, `ascentTicks` from the surface. The first call after a dry
   * proof decides whether the allowance starts and spends the proof either way; later calls hold it while its window stands.
   */
  permits(ascentTicks: number): boolean {
    return this.#allowance ? this.#holds(ascentTicks) : this.#start(ascentTicks);
  }

  #start(ascentTicks: number): boolean {
    const proof = this.#proof;
    this.#proof = null;
    const { bot } = this.parts;
    const age = bot.time?.age;
    if (!proof || typeof age !== "number" || !Number.isFinite(age) || !fullAirProofHolds(bot, proof)) return false;
    if (readAirSupply(bot).kind !== "absent" || age < proof.age || age - proof.age > AGE_PACKET_TICKS) return false;
    const charge = firstAirCharge(proof.age, age);
    const leg = this.parts.leg();
    if (leg.aborted || !provisionalAirAllows(ascentTicks, charge)) return false;
    this.#allowance = this.#open(charge, age, leg);
    return true;
  }

  #open(charge: number, age: number, leg: AbortSignal): Allowance {
    const { bot, world } = this.parts;
    // The window ends at the first age packet 40 ticks past the packet it started on, or at the wall backstop if no age arrives.
    const budget = serverPacedSignal(bot, 1, { wallMs: serverPacedWallMs(AGE_PACKET_TICKS) });
    const decide = () => this.parts.decide();
    const forget = () => { this.#proof = null; this.end(); };
    const expire = () => { this.end(); decide(); };
    const events = ["breath", "chunkColumnLoad", "chunkColumnUnload"] as const;
    const gone = ["death", "respawn", "end"] as const;
    for (const event of events) bot.on(event, decide);
    for (const event of gone) bot.on(event, forget);
    const unsubscribe = world.subscribe(decide);
    budget.signal.addEventListener("abort", expire, { once: true });
    leg.addEventListener("abort", forget, { once: true });
    const release = () => {
      for (const event of events) bot.off(event, decide);
      for (const event of gone) bot.off(event, forget);
      unsubscribe();
      budget.signal.removeEventListener("abort", expire);
      leg.removeEventListener("abort", forget);
      budget[Symbol.dispose]();
    };
    return { charge, budget, lastAge: age, release };
  }

  #holds(ascentTicks: number): boolean {
    const allowance = this.#allowance!;
    const age = this.parts.bot.time?.age;
    // A value that turns up inside the window (invalid or numeric) ends it: only an air still absent is what it stands on.
    const lost = allowance.budget.signal.aborted || readAirSupply(this.parts.bot).kind !== "absent" ||
      typeof age !== "number" || !Number.isFinite(age) || age < allowance.lastAge || !provisionalAirAllows(ascentTicks, allowance.charge);
    if (lost) this.end();
    else allowance.lastAge = age;
    return !lost;
  }

  /** The leg holds no allowance any more; the proof, if still held, stays. */
  end(): void {
    const allowance = this.#allowance;
    this.#allowance = null;
    allowance?.release();
  }

  [Symbol.dispose](): void {
    this.#proof = null;
    this.end();
  }
}

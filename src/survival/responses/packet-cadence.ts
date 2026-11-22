// The pace of the server's own time packets: how many milliseconds one world tick takes, from where the last packets landed.
import { MS_PER_ON_TIME_TICK } from "../../world/world-age.js";

/** The paced intervals kept: three, so a rate change shows within one packet and ages out after three. */
export const PACED_INTERVALS = 3;

/**
 * Packet by packet, an interval between two packets that changed the world age gives the milliseconds a tick took over
 * it. A server cannot run faster than on time (50 ms a tick): an interval below that is owed packets arriving in one
 * burst after a stall, which says nothing about the pace, so it is not kept and never pushes a paced interval out
 * (the server's stall rule: `fake-server.ts`). The first packet after a stall spans the stall, so it reads slow for
 * three intervals: the freshness limit is then wider, never narrower.
 */
export class PacketCadence {
  #last: { readonly age: number; readonly ms: number } | null = null;
  readonly #paced: number[] = [];

  /** A packet that changed the world age to `age` arrived at `atMs` (a monotonic reading). */
  hear(age: number, atMs: number): void {
    const last = this.#last;
    this.#last = { age, ms: atMs };
    // The first packet has no interval; an age that went back (a new world) has none either.
    if (last === null || age <= last.age) return;
    const msPerTick = (atMs - last.ms) / (age - last.age);
    if (msPerTick < MS_PER_ON_TIME_TICK) return;
    this.#paced.push(msPerTick);
    if (this.#paced.length > PACED_INTERVALS) this.#paced.shift();
  }

  /** The slowest of the paced intervals kept; the on-time 50 ms before any (under two packets, or only a burst, heard). */
  msPerTick(): number {
    return Math.max(MS_PER_ON_TIME_TICK, ...this.#paced);
  }
}

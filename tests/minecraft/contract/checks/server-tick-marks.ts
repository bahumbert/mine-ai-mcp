/** The server's tick at a moment of the client, for the checks that judge what the server does by its ticks and not by the wall time between two acts. */
import assert from "node:assert/strict";
import { ANSWER_WALL_MS } from "../server-answer.ts";
import { type ContractSubject, settleWithin, stallWatch } from "../subject.ts";
import { TICK_MS } from "./combat-scene.ts";

/**
 * A reading of `time query gametime` sent right before an act (or right at an event the client heard) is off the act's own tick by at
 * most 1 or 2 (the server runs the two in one batch of packets), so the difference of two readings is off by at most this much each way
 * (reasoned, not measured: the readings of hits 50 ms apart were 1 to 3 apart on lanes, 5 once with the client 76 ms late).
 */
export const READING_TICKS = 2;

/** A moment of the run: when the client acted (wall) and the server's tick then, asked right before so the server runs both in one tick or in neighbouring ones; null if the server answered nothing. */
export interface Mark {
  readonly tick: Promise<number | null>;
  readonly atMs: number;
}

export function markNow(subject: ContractSubject): Mark {
  return { tick: subject.serverGameTime().catch(() => null), atMs: subject.now() };
}

/**
 * The ticks a server on time (one per `TICK_MS`) runs in `wallMs` of the client's clock, the one place a round trip becomes ticks: "up"
 * counts a tick that has begun (the most the server may have run, for a bound that must not refuse a true reading), "down" only the ticks that
 * have ended (the least, for a bound on what a reading's round trip surely let pass). A server below 20 a second runs fewer than either.
 */
export function serverTicksIn(wallMs: number, rounding: "up" | "down"): number {
  const ticks = wallMs / TICK_MS;
  return rounding === "up" ? Math.ceil(ticks) : Math.floor(ticks);
}

/** The longest `restTicksSince` waits between two readings: a server that stopped is seen within this much after `ANSWER_WALL_MS` of its last reading (one `time query` each). */
const REST_POLL_MS = 2_000;

async function tickWithin(subject: ContractSubject, mark: Mark, maxMs: number): Promise<number | null> {
  return (await settleWithin(subject, mark.tick, maxMs))?.value ?? null;
}

/**
 * The server ticks one `time query gametime` takes to come back, the least of `ROUND_TRIP_SAMPLES` measured now (rounded up, less one tick
 * for the wait's poll step of 25 ms, so a server on time gives 0 and the windows stay as measured on it; a probe read 8 at a true
 * lag of 9 ticks, `READING_TICKS` absorbs the one). A reading asked with an act is answered with the act; one asked when the client hears
 * the act's result is answered a round trip after it. So an event heard reads this many ticks later than the act that caused it, and
 * a window between two such reads grows by it (a fake that answers 450 ms late: 9; air that is told after the water that was placed:
 * twice that). The least of three, so one stalled answer does not set every window of the run; a read with a handle of its own
 * measures its lateness with `markTimed` (`late-reading-window.ts`), this is for the windows that have none.
 */
export async function roundTripTicks(subject: ContractSubject): Promise<number> {
  let least = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < ROUND_TRIP_SAMPLES; sample += 1) {
    const asked = markNow(subject);
    await tickOf(subject, asked);
    least = Math.min(least, serverTicksIn(subject.now() - asked.atMs, "up") - 1);
  }
  return Math.max(0, least);
}

const ROUND_TRIP_SAMPLES = 3;

export async function tickOf(subject: ContractSubject, mark: Mark): Promise<number> {
  const tick = await tickWithin(subject, mark, ANSWER_WALL_MS);
  assert.ok(tick !== null, "the server answered no game time (is the bot op? or the server stalled)");
  return tick;
}

/**
 * Let `ticks` server ticks pass after the act marked, whatever the wall time they take. `ANSWER_WALL_MS` is a stall bound: it
 * restarts whenever the tick read has moved, so a server at 8 ticks a second finishes 100 ticks in 12.5 s. One that stops ticking fails
 * once no read has moved for `ANSWER_WALL_MS`: the last tick is seen at a read, up to `REST_POLL_MS` after it, so the failure comes
 * `ANSWER_WALL_MS - REST_POLL_MS` to `ANSWER_WALL_MS` after the last tick (probed 8.1-9.9 s). The waits are counted as well as the
 * clock, which may stop with the server.
 */
export async function restTicksSince(subject: ContractSubject, since: Mark, ticks: number, what: string): Promise<void> {
  const sinceTick = await tickOf(subject, since);
  const stall = stallWatch(subject);
  let lastTick = sinceTick;
  const stalledMessage = () => `${what} rested ${lastTick - sinceTick} of ${ticks} server ticks read, and no read moved for ${Math.round(stall.stalledMs())} ms (the bound is ${ANSWER_WALL_MS}): the server is stalled`;
  while (lastTick - sinceTick < ticks) {
    assert.ok(stall.stalledMs() < ANSWER_WALL_MS, stalledMessage());
    const waitMs = Math.min((ticks - (lastTick - sinceTick)) * TICK_MS, REST_POLL_MS);
    await subject.wait(waitMs);
    stall.waited(waitMs);
    const read = await tickWithin(subject, markNow(subject), ANSWER_WALL_MS - stall.stalledMs());
    assert.ok(read !== null, stalledMessage());
    if (read > lastTick) stall.moved();
    lastTick = Math.max(lastTick, read);
  }
}

/**
 * The window a span of server ticks may read when its end reading is asked when the client heard the end (`item-pickup-after-delay`, `consume-food`).
 *
 * The end reading is the server's tick when it processed the query, so it is the event's own tick or later by the ticks the server ran between
 * the event and the query: at most one per 50 ms of the query's round trip (a server below 20 a second runs fewer), measured per trial from the ask
 * to the answer's arrival, plus a stall's catch-up: the server owes the ticks of a stall (another lane's `clone` freezes it 0.16-0.9 s, facts
 * `live-testing.md`, "Ticks between two acts on lanes") and runs them back to back, in a few milliseconds, so they can sit between the event and
 * the query without any round trip. 0.9 s is 18 ticks, the longest stall measured; the game drops what is owed past 2 s.
 * Not covered: a client event loop blocked between the packet's arrival and the mark (the mark is then late by the block, which the round trip does not
 * show) and a stall longer than 0.9 s.
 */
import { type Mark, READING_TICKS, markNow, serverTicksIn } from "./server-tick-marks.ts";
import type { ContractSubject } from "../subject.ts";

/** Ticks the server may run back to back after a stall of 0.9 s (18 at 20 a second). */
export const CATCH_UP_TICKS = 18;

/** A mark and the wall time its reading took to come back (the clock of the subject, from the ask to the answer's arrival). */
export interface TimedMark extends Mark {
  readonly roundTripMs: Promise<number>;
}

export function markTimed(subject: ContractSubject): TimedMark {
  const mark = markNow(subject);
  return { ...mark, roundTripMs: mark.tick.then(() => subject.now() - mark.atMs) };
}

/** `ticks` of the game (a bite, a pickup delay) as read from a reading sent before the act to one whose answer took `roundTripMs`: the lowest and the highest difference a true span of that many ticks can read. */
export function readingWindow(ticks: number, roundTripMs: number): { readonly min: number; readonly max: number; readonly lateTicks: number } {
  const lateTicks = serverTicksIn(roundTripMs, "up") + CATCH_UP_TICKS;
  return { min: ticks - READING_TICKS, max: ticks + READING_TICKS + lateTicks, lateTicks };
}

/**
 * What a passing check returns of the end reading's lateness (the driver puts it in the trial's completion detail, so a batch's `results.json`
 * and `client.log` give the largest `catchUpUsed` seen against `CATCH_UP_TICKS`): the values the failing text gives, as `name=value` words, and
 * `catchUpUsed`, the ticks `tookTicks` went past what the span, the readings' own error and the round trip explain (`lateTicks` allows
 * `CATCH_UP_TICKS` more than the round trip; a negative value is room left).
 */
export function latenessRecorded(ticks: number, tookTicks: number, roundTripMs: number): string {
  const { lateTicks } = readingWindow(ticks, roundTripMs);
  const catchUpUsed = tookTicks - (ticks + READING_TICKS + lateTicks - CATCH_UP_TICKS);
  return `late-reading: tookTicks=${tookTicks} roundTripMs=${Math.round(roundTripMs)} lateTicks=${lateTicks} catchUpUsed=${catchUpUsed}`;
}

/** What a message says of the end reading's lateness: the round trip and the ticks it allowed. */
export function latenessSaid(what: string, roundTripMs: number, lateTicks: number): string {
  return `the ${what}'s reading came back in ${Math.round(roundTripMs)} ms: ${lateTicks} ticks of lateness, ${CATCH_UP_TICKS} of them a stall's catch-up`;
}

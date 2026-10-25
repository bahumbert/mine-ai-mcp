/** The server's tick at a moment of the client, for the checks that judge what the server does by its ticks and not by the wall time between two acts. */
import assert from "node:assert/strict";
import { ANSWER_WALL_MS } from "../server-answer.ts";
import { type ContractSubject, settleWithin } from "../subject.ts";
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

export async function tickOf(subject: ContractSubject, mark: Mark): Promise<number> {
  const tick = (await settleWithin(subject, mark.tick, ANSWER_WALL_MS))?.value ?? null;
  assert.ok(tick !== null, "the server answered no game time (is the bot op? or the server stalled)");
  return tick;
}

/** Let `ticks` server ticks pass after the act marked, whatever the wall time they take; fails at the wall bound (a server that barely ticks). */
export async function restTicksSince(subject: ContractSubject, since: Mark, ticks: number, what: string): Promise<void> {
  const sinceTick = await tickOf(subject, since);
  const startedAt = subject.now();
  for (let ticksLeft = ticks; ticksLeft > 0; ) {
    assert.ok(subject.now() - startedAt < ANSWER_WALL_MS, `${what} rested ${ticks - ticksLeft} of ${ticks} server ticks in ${ANSWER_WALL_MS} ms: the server is stalled`);
    await subject.wait(ticksLeft * TICK_MS);
    ticksLeft = ticks - ((await tickOf(subject, markNow(subject))) - sinceTick);
  }
}

/**
 * How a check waits for what the server does: for its answer (the value it will send), for server ticks before an
 * absence ("nothing was sent back"), and for the client's own physics ticks. Never a wall gap that stands for ticks: a
 * lane's server stalls 0.16-0.9 s while another lane arranges (`clone`), and the catch-up ticks then run back to back, so
 * the same wall gap holds fewer server ticks on one run than on the next (plan 2026-10-23-shared-scenario-server E4).
 */
import assert from "node:assert/strict";
import { type ContractSubject, holdsWithin } from "./subject.ts";

/**
 * The wall bound of every wait here: 2 s for 40 server ticks on time. It only ends a wait on a server that does not tick, so it holds
 * the stalls of other lanes' `clone`s (0.16-0.9 s each, 3-4 inside one check: 4.7 s with the 2 s of ticks) and still fails a hung server
 * long before the trial's own timeout.
 */
export const ANSWER_WALL_MS = 10_000;
/** The world age comes one packet per 20 ticks, so an age read at the call may be up to 19 ticks old (`ContractSubject.serverTicks`). */
const AGE_STALENESS_TICKS = 19;
/** Server ticks an absence needs: 40 observed prove 21 after the call, the runtime's accepted rule (facts `runtime-pitfalls.md` "The server's answer"). */
export const ABSENCE_TICKS = 21;

/** Let at least `provenTicks` server ticks pass after the call; fails at the wall bound (a server that does not tick proves nothing). */
export async function afterServerTicks(subject: ContractSubject, provenTicks: number, what: string): Promise<void> {
  const observed = provenTicks + AGE_STALENESS_TICKS;
  assert.ok(await subject.serverTicks(observed, ANSWER_WALL_MS), `${what}: the world age did not move ${observed} ticks within ${ANSWER_WALL_MS} ms: the server is stalled`);
}

/** The server had the time to answer what was sent before the call: whatever it would have sent back has arrived. */
export function serverQuiet(subject: ContractSubject, what: string): Promise<void> {
  return afterServerTicks(subject, ABSENCE_TICKS, what);
}

/** Wait for an answer the server will send: `arrived` holds within the wall bound, else the check fails naming `what`. */
export async function answerArrives(subject: ContractSubject, arrived: () => boolean, what: string): Promise<void> {
  assert.ok(await holdsWithin(subject, arrived, ANSWER_WALL_MS), `${what}: no answer within ${ANSWER_WALL_MS} ms`);
}

/**
 * An answer the server will send, and then the server's ticks on top: the packets of one answer arrive together, so a
 * check that asserts the answer is exactly these packets (nothing sent after them) reads after both.
 */
export async function answerSettled(subject: ContractSubject, arrived: () => boolean, what: string): Promise<void> {
  await answerArrives(subject, arrived, what);
  await serverQuiet(subject, `${what}: after it`);
}

/** Let the client's own physics run `ticks` more ticks (it sends its position and look packets from them): a client clock, not the server's. */
export async function afterClientTicks(subject: ContractSubject, ticks: number, what: string): Promise<void> {
  const { bot } = subject;
  let seen = 0;
  const onTick = () => void (seen += 1);
  bot.on("physicsTick", onTick);
  try {
    assert.ok(await holdsWithin(subject, () => seen >= ticks, ANSWER_WALL_MS), `${what}: the client ran ${seen} of ${ticks} physics ticks within ${ANSWER_WALL_MS} ms (is its physics on?)`);
  } finally {
    bot.off("physicsTick", onTick);
  }
}

/**
 * How a check waits for what the server does: for its answer (the value it will send), for server ticks before an
 * absence ("nothing was sent back"), and for the client's own physics ticks. Never a wall gap that stands for ticks: a
 * lane's server stalls 0.16-0.9 s while another lane arranges (`clone`), and the catch-up ticks then run back to back, so
 * the same wall gap holds fewer server ticks on one run than on the next (plan 2026-10-23-shared-scenario-server E4).
 */
import assert from "node:assert/strict";
import { type ContractSubject, holdsWhileMoving, holdsWithin } from "./subject.ts";

/**
 * The wall bound of every wait here: 2 s for 40 server ticks on time. It only ends a wait on a server that does not tick, so it holds
 * the stalls of other lanes' `clone`s (0.16-0.9 s each, 3-4 inside one check: 4.7 s with the 2 s of ticks) and still fails a hung server
 * long before the trial's own timeout. A wait on server ticks or on a ramp that keeps moving (`afterServerTicks`, `restTicksSince`,
 * `answerArrivesWhileMoving`) takes it as a stall bound: it restarts at each tick, so a server at 8 ticks a second finishes 100 ticks
 * in 12.5 s and one that stops ticking fails about `ANSWER_WALL_MS` after its last tick (`restTicksSince` sees that tick at a read up to 2 s late; plan 2026-10-30-contract-batch-timing T2c).
 */
export const ANSWER_WALL_MS = 10_000;
/** The world age comes one packet per 20 ticks, so an age read at the call may be up to 19 ticks old (`ContractSubject.serverTicks`). */
const AGE_STALENESS_TICKS = 19;
/** Server ticks an absence needs: 40 observed prove 21 after the call, the runtime's accepted rule (facts `runtime-pitfalls.md` "The server's answer"). */
export const ABSENCE_TICKS = 21;

/** Let at least `provenTicks` server ticks pass after the call; fails when the world age stands still for the wall bound (a server that does not tick proves nothing). */
export async function afterServerTicks(subject: ContractSubject, provenTicks: number, what: string): Promise<void> {
  const observed = provenTicks + AGE_STALENESS_TICKS;
  assert.ok(await subject.serverTicks(observed, ANSWER_WALL_MS), `${what}: the world age stood still for ${ANSWER_WALL_MS} ms before it moved ${observed} ticks: the server is stalled`);
}

/** The server had the time to answer what was sent before the call: whatever it would have sent back has arrived. */
export function serverQuiet(subject: ContractSubject, what: string): Promise<void> {
  return afterServerTicks(subject, ABSENCE_TICKS, what);
}

/**
 * Wait for an answer the server will send: `arrived` holds within the wall bound, else the check fails naming `what`.
 * `detail` (read only for a failure, when the wait ends) says what the client knew then, so a red that does not repeat names its cause.
 */
export async function answerArrives(subject: ContractSubject, arrived: () => boolean, what: string, detail?: () => string): Promise<void> {
  if (await holdsWithin(subject, arrived, ANSWER_WALL_MS)) return;
  assert.fail(`${what}: no answer within ${ANSWER_WALL_MS} ms${detail ? ` (${detail()})` : ""}`);
}

/**
 * Wait for server work that takes ticks and shows its progress (a weather level that steps each tick, the world age during a sleep):
 * `arrived` holds, else the check fails naming `what` once `movement()` has not changed for `ANSWER_WALL_MS`. Not for a single answer: that is `answerArrives`.
 */
export async function answerArrivesWhileMoving(subject: ContractSubject, arrived: () => boolean, movement: () => unknown, what: string): Promise<void> {
  assert.ok(await holdsWhileMoving(subject, arrived, movement, ANSWER_WALL_MS), `${what}: no change for ${ANSWER_WALL_MS} ms`);
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

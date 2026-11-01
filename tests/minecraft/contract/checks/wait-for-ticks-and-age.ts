/**
 * `waitForTicks` counts the client's own ticks (one each 50 ms, `physics.js`), not the server's: 40 take 2 s of wall clock. The world age moves with
 * the server's ticks, so it is judged against the ticks the server ran in that same wall window (read right before and right after), never against
 * the 40: a lane's server that another lane's `clone` stalled runs its owed ticks back to back inside the wait (S2's batch, s15: the age moved 62
 * in 2009 ms; 76 in the next warm-up), and a server at 8 ticks a second moves it 16 (plan 2026-10-30-contract-batch-timing T7h). Regular packets
 * step the age by 20, so 62 and 76 also hold an extra packet (reasoned: another lane's `/time set` in the wait), which the bound's packet covers.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { settleWithin } from "../subject.ts";
import { markTimed } from "./late-reading-window.ts";
import { READING_TICKS, serverTicksIn, tickOf } from "./server-tick-marks.ts";

const TICKS = 40;
/** 40 client ticks are 2000 ms; Mineflayer's interval and the event loop add at most a tick or two. */
const EXPECTED_MS = TICKS * 50;
const SLACK_MS = 150;
/** The age comes in a packet every 20 server ticks, so what the client holds is up to 20 behind the server at both ends of the wait. */
const TICKS_PER_PACKET = 20;
/** Each end is off by up to 19 (the packet before the reading) and the readings by `READING_TICKS`: a frozen age (40 off) or one counting the client's 40 on a server at 8 a second (24 off) are outside. */
const SLACK_TICKS = TICKS_PER_PACKET + READING_TICKS;
/**
 * The server ticks one reading's round trip lets pass, counted "down" (the ticks that have ended): the sub-tick part of the round trip is covered by
 * `READING_TICKS` in `SLACK_TICKS`, so "up" would only widen the allowance. No catch-up term as in `late-reading-window.ts`: this check judges the age
 * against the ticks the server ran between its two readings, and a stall's owed ticks run inside the query's flight show in `roundTripMs` itself,
 * which the reading's wall time measures.
 */
const lateTicks = (roundTripMs: number) => serverTicksIn(roundTripMs, "down");

export const waitForTicksAndAge: ContractCheck = {
  name: "wait-for-ticks-and-age",
  fixture: { cells: {}, carried: {}, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    // The age is taken as each tick reading is asked: the reading is the server's tick when it processed the query, which a round trip later may be that many ticks further (`markTimed`).
    const startAge = bot.time.age;
    const started = markTimed(subject);
    const settled = await settleWithin(subject, bot.waitForTicks(TICKS), 10_000);
    const endAge = bot.time.age;
    const ended = markTimed(subject);
    assert.ok(settled !== null && settled.error === undefined, `waitForTicks(${TICKS}): ${settled?.error?.message ?? "never ended"}`);
    const tookMs = settled.atMs - started.atMs;
    assert.ok(Math.abs(tookMs - EXPECTED_MS) <= SLACK_MS, `waitForTicks(${TICKS}) took ${Math.round(tookMs)} ms: ${EXPECTED_MS} within ${SLACK_MS}`);
    // The server's age, read from its packets meanwhile, moved as many ticks as the server ran in the wait: one packet of 20 at each end, the readings' own error, and the ticks each reading's round trip let the server run.
    const ticksRun = (await tickOf(subject, ended)) - (await tickOf(subject, started));
    const moved = endAge - startAge;
    const slack = SLACK_TICKS + lateTicks(await started.roundTripMs) + lateTicks(await ended.roundTripMs);
    assert.ok(Math.abs(moved - ticksRun) <= slack, `world age moved ${moved} while the server ran ${ticksRun} ticks (read right before and after the ${TICKS} client ticks, ${Math.round(tookMs)} ms): the same within ${slack}`);
  },
};

/** `waitForTicks` counts the client's own ticks (one each 50 ms, `physics.js`), not the server's: 40 take 2 s of wall clock. */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { settleWithin } from "../subject.ts";

const TICKS = 40;
/** 40 client ticks are 2000 ms; Mineflayer's interval and the event loop add at most a tick or two. */
const EXPECTED_MS = TICKS * 50;
const SLACK_MS = 150;

export const waitForTicksAndAge: ContractCheck = {
  name: "wait-for-ticks-and-age",
  fixture: { cells: {}, carried: {}, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    const startAge = bot.time.age;
    const startedAt = subject.now();
    const settled = await settleWithin(subject, bot.waitForTicks(TICKS), 10_000);
    assert.ok(settled !== null && settled.error === undefined, `waitForTicks(${TICKS}): ${settled?.error?.message ?? "never ended"}`);
    const tookMs = settled.atMs - startedAt;
    assert.ok(Math.abs(tookMs - EXPECTED_MS) <= SLACK_MS, `waitForTicks(${TICKS}) took ${Math.round(tookMs)} ms: ${EXPECTED_MS} within ${SLACK_MS}`);
    // The server's age, read from its packets meanwhile, moved about as much: 40 within one packet of 20.
    const moved = bot.time.age - startAge;
    assert.ok(Math.abs(moved - TICKS) <= 20, `world age moved ${moved} during ${TICKS} client ticks: ${TICKS} within 20`);
  },
};

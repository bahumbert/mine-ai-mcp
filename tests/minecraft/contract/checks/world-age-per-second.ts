/** The world age comes in one time packet a second, 20 ticks each (`facts/runtime-pitfalls.md` "The server's answer"). */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";

const WATCH_MS = 3_000;
/** A packet every 20 server ticks: on a server on time, one a second. */
const TICKS_PER_PACKET = 20;

export const worldAgePerSecond: ContractCheck = {
  name: "world-age-per-second",
  fixture: { cells: {}, carried: {}, position: [0.5, -60, 0.5] },
  async run({ bot, wait }) {
    const ages: number[] = [];
    const onTime = () => void ages.push(bot.time.age);
    bot.on("time", onTime);
    const startAge = bot.time.age;
    try {
      await wait(WATCH_MS);
    } finally {
      bot.off("time", onTime);
    }
    const steps = ages.map((age, index) => age - (index === 0 ? startAge : ages[index - 1]!));
    // Steps of 20 whatever the server's speed (it sends one per 20 of its own ticks); the first may be 0 when the
    // last packet before the watch was not yet read.
    assert.ok(steps.slice(1).every((step) => step === TICKS_PER_PACKET), `age steps ${steps.join(", ")}: each 20`);
    // One packet a second, so 3 s hold 2 to 4 of them depending on where the watch starts in the second.
    assert.ok(ages.length >= 2 && ages.length <= 4, `${ages.length} time packets in ${WATCH_MS} ms: 2 to 4`);
    const moved = bot.time.age - startAge;
    assert.ok(Math.abs(moved - 60) <= TICKS_PER_PACKET, `age moved ${moved} in ${WATCH_MS} ms: 60 within 20`);
  },
};

/**
 * The world age of a server that runs slower than 20 ticks a second (`tick rate 8`): the regular time packets still come
 * one per 20 server ticks (so one per 2.5 s at 8 ticks a second) and step the age by 20, as `world-age-per-second` found
 * at 20. The check watches 10 s and reads the server's own tick counter before and after, so the packets are counted
 * against the ticks the server ran, not against a wall gap. The check is `exclusive` for two reasons: it asserts that every packet
 * steps 20, which another lane's arrangement `/time set` (an extra packet) would break (`world-age-per-second` tells the extras apart
 * instead), and it times ticks against the wall clock, which another lane's `clone` stalls.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { markNow, tickOf } from "./server-tick-marks.ts";
import { type HeardPacket, describePackets } from "./world-age-per-second.ts";

const TICK_RATE = 8;
const WATCH_MS = 10_000;
/** A packet every 20 server ticks, whatever the server's speed. */
const TICKS_PER_PACKET = 20;
/** The server runs 80 ticks in the watch if the setting took; the slack is a quarter of that, which a server at another rate (20 would run 200) is far outside. */
const EXPECTED_TICKS = (TICK_RATE * WATCH_MS) / 1000;
const TICKS_SLACK = EXPECTED_TICKS / 4;

export const worldAgeAtSlowTick: ContractCheck = {
  name: "world-age-at-slow-tick",
  fixture: { cells: {}, carried: {}, position: [0.5, -60, 0.5], tickRate: TICK_RATE },
  exclusive: "it asserts that every time packet steps 20, which another lane's arrangement `/time set` would break, and it times server ticks against the wall clock, which another lane's clone stalls",
  async run(subject) {
    const { bot } = subject;
    const heard: HeardPacket[] = [];
    const onTime = () => void heard.push({ age: bot.time.age, atMs: subject.now() });
    bot.on("time", onTime);
    const startedAtMs = subject.now();
    const first = markNow(subject);
    let last;
    try {
      await subject.wait(WATCH_MS);
      last = markNow(subject);
    } finally {
      bot.off("time", onTime);
    }
    const ran = (await tickOf(subject, last)) - (await tickOf(subject, first));
    const seen = `server ticks run in the watch: ${ran}; packets heard (age@ms into the watch): ${describePackets(heard, startedAtMs)}`;
    assert.ok(Math.abs(ran - EXPECTED_TICKS) <= TICKS_SLACK, `the server ran ${ran} ticks in ${WATCH_MS} ms: ${EXPECTED_TICKS} within ${TICKS_SLACK} at tick rate ${TICK_RATE}; ${seen}`);
    assert.ok(heard.length > 0, `no time packet in ${WATCH_MS} ms; ${seen}`);
    assert.ok(heard.slice(1).every(({ age }, index) => age - heard[index]!.age === TICKS_PER_PACKET), `the time packets' ages step by ${TICKS_PER_PACKET} at tick rate ${TICK_RATE}; ${seen}`);
    // One packet per 20 ticks of the 80 run: 4, and 3 or 5 where the watch starts mid-interval.
    const expectedPackets = Math.floor(ran / TICKS_PER_PACKET);
    assert.ok(Math.abs(heard.length - expectedPackets) <= 1, `${heard.length} time packets for ${ran} server ticks: one per ${TICKS_PER_PACKET} ticks, ${expectedPackets} within 1; ${seen}`);
  },
};

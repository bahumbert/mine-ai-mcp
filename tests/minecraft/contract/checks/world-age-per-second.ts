/**
 * The world age comes in time packets: a regular one every 20 server ticks, and an extra one at each `/time set`
 * (any player's, another lane's arrangement too: `facts/runtime-pitfalls.md` "The server's answer"). The check sets the
 * day time to the value it holds, inside its watch, so an extra is always there to tell apart from the regular ones: the
 * regular ones carry ages that step by 20 on one cadence (same age mod 20), an extra carries the world's age at that
 * moment (off the cadence), or the age of the regular packet of its own tick (a duplicate age).
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { READING_TICKS, markNow, restTicksSince, tickOf } from "./server-tick-marks.ts";

/** A packet every 20 server ticks: on a server on time, one a second. */
const TICKS_PER_PACKET = 20;
/** The watch is 3 s on a server on time, counted in the server's ticks so a server at 8 a second is judged on the same 3 packets (plan 2026-10-30-contract-batch-timing T2c). */
const WATCH_TICKS = 3 * TICKS_PER_PACKET;
/** The `/time set` goes out this many ticks into the watch, so regular packets fall on both sides of it. */
const RESEND_AFTER_TICKS = TICKS_PER_PACKET;

/** A time packet the client heard: the age it held and when (the subject's clock). */
export interface HeardPacket {
  readonly age: number;
  readonly atMs: number;
}

/** The most frequent age residue mod 20 among the packets heard, the one before the watch settling a tie: the regular packets' cadence. */
function cadenceOf(heard: readonly HeardPacket[], ageBefore: number): number {
  const counts = new Map<number, number>();
  for (const { age } of [...new Map(heard.map((packet) => [packet.age, packet])).values()]) counts.set(age % TICKS_PER_PACKET, (counts.get(age % TICKS_PER_PACKET) ?? 0) + 1);
  const best = Math.max(...counts.values());
  const tied = [...counts].filter(([, count]) => count === best).map(([residue]) => residue);
  return tied.includes(ageBefore % TICKS_PER_PACKET) ? ageBefore % TICKS_PER_PACKET : tied[0]!;
}

/** The packets heard that are extra: off the cadence, or repeating the age of the packet before them (a `/time set` in the tick of a regular one). */
function extraPackets(heard: readonly HeardPacket[], cadence: number): HeardPacket[] {
  return heard.filter(({ age }, index) => age % TICKS_PER_PACKET !== cadence || (index > 0 && heard[index - 1]!.age === age));
}

export const describePackets = (heard: readonly HeardPacket[], startedAtMs: number) => heard.map(({ age, atMs }) => `${age}@${Math.round(atMs - startedAtMs)}ms`).join(", ");

export const worldAgePerSecond: ContractCheck = {
  name: "world-age-per-second",
  fixture: { cells: {}, carried: {}, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    const heard: HeardPacket[] = [];
    const onTime = () => void heard.push({ age: bot.time.age, atMs: subject.now() });
    bot.on("time", onTime);
    const ageBefore = bot.time.age;
    const startedAtMs = subject.now();
    const started = markNow(subject);
    let ended = started;
    let heardBeforeResend = 0;
    try {
      await restTicksSince(subject, started, RESEND_AFTER_TICKS, "the watch before the time set");
      heardBeforeResend = heard.length;
      await subject.resendTime();
      await restTicksSince(subject, started, WATCH_TICKS, "the watch");
      ended = markNow(subject);
    } finally {
      bot.off("time", onTime);
    }
    const ticksRun = (await tickOf(subject, ended)) - (await tickOf(subject, started));
    const seen = `packets heard (age@ms into the watch): ${describePackets(heard, startedAtMs)}; time set sent after ${heardBeforeResend}; ${ticksRun} server ticks run`;
    assert.ok(heard.length > 0, `no time packet in ${ticksRun} server ticks; ${seen}`);
    const cadence = cadenceOf(heard, ageBefore);
    const extras = extraPackets(heard, cadence);
    const regularAges = [...new Set(heard.filter((packet) => !extras.includes(packet)).map(({ age }) => age))];
    // The regular packets step 20 whatever the server's speed (one per 20 of its own ticks); the first may repeat the packet read just before the watch.
    assert.ok(regularAges.slice(1).every((age, index) => age - regularAges[index]! === TICKS_PER_PACKET), `the regular packets' ages step by ${TICKS_PER_PACKET}; ${seen}`);
    // One packet per 20 ticks, so the ticks run hold their count (floor or ceiling, by where the watch starts in the 20), the two readings' error added.
    const [fewest, most] = [Math.floor((ticksRun - READING_TICKS) / TICKS_PER_PACKET), Math.ceil((ticksRun + READING_TICKS) / TICKS_PER_PACKET)];
    assert.ok(regularAges.length >= fewest && regularAges.length <= most, `${regularAges.length} regular time packets in ${ticksRun} server ticks: ${fewest} to ${most}; ${seen}`);
    assert.ok(extras.some((packet) => heard.indexOf(packet) >= heardBeforeResend), `the /time set was not answered with an extra time packet; ${seen}`);
    const moved = bot.time.age - ageBefore;
    assert.ok(Math.abs(moved - ticksRun) <= TICKS_PER_PACKET, `age moved ${moved} in ${ticksRun} server ticks: the same within ${TICKS_PER_PACKET}; ${seen}`);
  },
};

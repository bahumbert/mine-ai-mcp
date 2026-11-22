// The pace of the server's time packets, from explicit ages and monotonic times: no bot, no clock.
import assert from "node:assert/strict";
import test from "node:test";
import { PACED_INTERVALS, PacketCadence } from "./packet-cadence.js";

/** Hear a packet every `everyMs` that moves the age by 20, `count` times from (`age`, `atMs`); returns the next (age, atMs). */
function hearRegular(cadence: PacketCadence, from: { age: number; atMs: number }, everyMs: number, count: number) {
  let { age, atMs } = from;
  for (let packet = 0; packet < count; packet++) {
    cadence.hear(age, atMs);
    age += 20;
    atMs += everyMs;
  }
  return { age, atMs };
}

test("before two packets, or with only a burst, a tick takes the on-time 50 ms", () => {
  const cadence = new PacketCadence();
  assert.equal(cadence.msPerTick(), 50);
  cadence.hear(20, 1_000);
  assert.equal(cadence.msPerTick(), 50);
  for (let i = 1; i <= 5; i++) cadence.hear(20 + 20 * i, 1_000);
  assert.equal(cadence.msPerTick(), 50, "five packets at one instant are no pace");
});

for (const [rate, everyMs, msPerTick] of [["20 tps", 1_000, 50], ["10 tps", 2_000, 100], ["5 tps", 4_000, 200]] as const) {
  test(`a packet every ${everyMs} ms moving the age by 20 is ${msPerTick} ms a tick (${rate})`, () => {
    const cadence = new PacketCadence();
    hearRegular(cadence, { age: 0, atMs: 990 }, everyMs, 3);
    assert.equal(cadence.msPerTick(), msPerTick);
  });
}

test("the slowest of the last three paced intervals counts, and it is gone after exactly three faster ones", () => {
  const cadence = new PacketCadence();
  for (const [age, atMs] of [[0, 0], [20, 1_000], [40, 2_000]] as const) cadence.hear(age, atMs); // 50, 50
  cadence.hear(60, 4_000); // 100: one slow interval
  assert.equal(cadence.msPerTick(), 100);
  // Back on time: the slow one stays among the last three for two more intervals, and is gone at the third.
  let next = { age: 80, atMs: 5_000 };
  for (let faster = 1; faster <= PACED_INTERVALS; faster++) {
    next = hearRegular(cadence, next, 1_000, 1);
    assert.equal(cadence.msPerTick(), faster < PACED_INTERVALS ? 100 : 50, `${faster} faster interval(s) after it`);
  }
});

test("a burst of owed packets after a stall neither lowers the pace nor pushes a paced interval out", () => {
  const cadence = new PacketCadence();
  hearRegular(cadence, { age: 0, atMs: 0 }, 2_000, 3); // 100 ms a tick
  cadence.hear(100, 12_000); // the packet after the stall spans it: (12 000 - 4 000) / 60 = 133
  const spanned = cadence.msPerTick();
  assert.ok(spanned > 100);
  for (let owed = 1; owed <= 10; owed++) cadence.hear(100 + 20 * owed, 12_000);
  assert.equal(cadence.msPerTick(), spanned, "ten owed packets at one instant change nothing");
  // Only later paced intervals age it out.
  let next = { age: 320, atMs: 13_000 };
  for (let paced = 1; paced <= PACED_INTERVALS; paced++) {
    next = hearRegular(cadence, next, 1_000, 1);
    assert.equal(cadence.msPerTick(), paced < PACED_INTERVALS ? spanned : 50, `${paced} paced interval(s) after the burst`);
  }
});

test("an age that goes back (a new world) starts no interval and keeps the pace", () => {
  const cadence = new PacketCadence();
  hearRegular(cadence, { age: 100, atMs: 0 }, 2_000, 3);
  assert.equal(cadence.msPerTick(), 100);
  cadence.hear(5, 7_000);
  assert.equal(cadence.msPerTick(), 100, "no negative or zero interval");
  cadence.hear(25, 9_000); // 100 ms a tick again, measured from the new world
  assert.equal(cadence.msPerTick(), 100);
  cadence.hear(45, 10_000);
  cadence.hear(65, 11_000);
  cadence.hear(85, 12_000);
  assert.equal(cadence.msPerTick(), 50, "three on-time intervals of the new world replaced it");
});

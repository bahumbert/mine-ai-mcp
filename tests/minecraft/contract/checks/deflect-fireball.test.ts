import assert from "node:assert/strict";
import test from "node:test";
import { ageOfSpeed, assertMoveWithDeflection, assertToldEveryTenTicks, assertUpdatesToldOnTime, blocksFlown, deflectFireball } from "./deflect-fireball.ts";
import type { ContractSubject } from "../subject.ts";
import { assertTicksApart } from "./ticks-apart.ts";
import { runOnFake } from "./run-on-fake.ts";

/** The fake's fireball counts server ticks (`fake-bot-fireballs.ts` through `onServerTick`), so a slow server stretches every gap of its updates in wall time. */
const SLOW_SERVERS = [14, 8];

test("deflect-fireball judges the update gaps and the first update in server ticks: a server at 14 and at 8 ticks a second passes", async () => {
  for (const ticksPerSecond of SLOW_SERVERS) await runOnFake(deflectFireball, { ticksPerSecond });
});

test("deflect-fireball holds when the server stalls for under 2 s and catches up, in the flight and after the hit", async () => {
  for (const atMs of [500, 1_200, 2_600, 3_000]) await runOnFake(deflectFireball, {}, undefined, [{ atMs, ms: 700 }]);
});

/**
 * A stall on the launch of a ball: the catch-up flies the ball into reach before the swing (launched 8 blocks off, 4.4 off after a 700 ms stall) or onto the bot (launched 4 off), so the check
 * throws that ball away and launches another. A 700 ms stall relaunches when it starts at 100-200 ms (the out-of-reach ball) or 1600-2300 ms (the in-reach ball, launched after the first ball's 1.3 s flight): swept by 50 ms from 0 to 4000, every start passed.
 * `launches` counts the balls: 2 is no relaunch, so a stall that fell elsewhere would not pass the test.
 */
const STALLS_ON_A_LAUNCH = [
  { what: "the ball out of reach", atMs: 100, ms: 700 },
  { what: "the ball out of reach", atMs: 200, ms: 700 },
  { what: "the ball out of reach, so long that it meets the bot", atMs: 100, ms: 1_700 },
  { what: "the ball in reach", atMs: 1_600, ms: 700 },
  { what: "the ball in reach", atMs: 2_300, ms: 700 },
];

for (const { what, atMs, ms } of STALLS_ON_A_LAUNCH) {
  test(`deflect-fireball holds when a ${ms} ms stall at ${atMs} ms falls on the launch of ${what}: a new ball is launched`, async () => {
    let launches = 0;
    const counted = (subject: ContractSubject): ContractSubject => ({ ...subject, launchFireball: (position, motion) => (launches += 1, subject.launchFireball(position, motion)) });
    const note = await runOnFake(deflectFireball, {}, counted, [{ atMs, ms }]);
    assert.ok(launches > 2, `${launches} balls launched: the stall did not fall on a launch`);
    assert.match(String(note), new RegExp(`^balls: launched=${launches} thrownAway=${launches - 2} \\| (out of reach|in reach): launched [\\d.]+ blocks off .* \\(the swing was read \\d+ server ticks after the launch\\)`, "u"), "the note counts the balls launched and says why each was thrown away");
  });
}

test("deflect-fireball returns how many balls it threw away, for the trial's completion detail: none on a server on time", async () => {
  assert.equal(await runOnFake(deflectFireball), "balls: launched=2 thrownAway=0");
});

test("blocksFlown is the sum of the ball's speeds a tick (0.209 the first, 0.38 - 0.18 * 0.95^n): 14 ticks of a 700 ms stall's catch-up carried a ball from 8.5 to 4.93 on the fake", () => {
  assert.equal(blocksFlown(0), 0);
  assert.ok(Math.abs(blocksFlown(14) - (8.5 - 4.93)) < 0.01, `${blocksFlown(14)} blocks in 14 ticks`);
  assert.ok(Math.abs(blocksFlown(1) - 0.209) < 1e-9);
});

test("the updates of a ball set flying come within 10 ticks of the hit and every 10 after; one at the 15th tick after the one before, or the first at the 14th, is refused naming the tick", () => {
  assert.doesNotThrow(() => assertToldEveryTenTicks([4, 14, 24, 34]));
  assert.doesNotThrow(() => assertToldEveryTenTicks([10, 20]));
  assert.doesNotThrow(() => assertToldEveryTenTicks([1, 9, 19]), "a hit on the ball's 1st tick: its 2nd tick tells, its 10th tells 8 after");
  assert.throws(() => assertToldEveryTenTicks([4, 19]), /after the hit, update 2: its speed is the flight's at tick 19\.0 after the hit, 15\.0 after the update before \(tick 4\.0\), not 10 \(or 8 after a 2nd tick\)/u);
  assert.throws(() => assertToldEveryTenTicks([14]), /after the hit, update 1: its speed is the flight's at tick 14\.0 after the hit, not within the first 10/u);
});

/** The updates of a ball launched at tick 100 (the read before the launch), each read `late` ticks after the tick it was sent at (the ball's age in the speed it tells). */
const readAt = (ages: readonly number[], late: readonly number[]) => ages.map((age, index) => ({ tick: 100 + age + late[index]!, speed: 0.38 - 0.18 * 0.95 ** age }));

test("the speed of an update says the tick of the ball's flight it was sent at", () => {
  for (const age of [2, 10, 20, 30, 40]) assert.ok(Math.abs(ageOfSpeed(0.38 - 0.18 * 0.95 ** age, 0.2, 0.02) - age) < 1e-9, `age ${age}`);
});

test("updates told at the ball's 2nd tick, its 10th and every 10th, read a round trip late, are judged whatever the ticks between the reads", () => {
  assert.equal(assertUpdatesToldOnTime(readAt([2, 10, 20, 30], [8, 8, 8, 8]), 100, 8), undefined, "a steady round trip of 8 ticks");
  assert.equal(assertUpdatesToldOnTime(readAt([2, 10, 20], [10, -2, 10]), 100, 8), undefined, "reads 2 ticks either way of it: two updates 10 ticks apart read 12 and 8 ticks apart are no cadence");
});

test("an update read after the round trip and the readings' error is a stall's catch-up: the reason is returned, naming the ticks, so the ball is thrown away", () => {
  assert.match(assertUpdatesToldOnTime(readAt([2, 10, 20], [8, 15, 8]), 100, 8) ?? "", /had its update 2 read 15 server ticks after it was sent \(out of reach: the ball's tick 10, from tick 100\), more than 10: the round trip/u);
  assert.match(assertUpdatesToldOnTime(readAt([2, 10, 20], [8, 8, 11]), 100, 8) ?? "", /update 3 read 11/u, "the last update");
});

test("an update read before it was sent is refused naming the ticks", () => {
  assert.throws(() => assertUpdatesToldOnTime(readAt([2, 10, 20], [8, -3, 8]), 100, 8), /update 2: read at tick 107, 3 server ticks before it was sent/u);
});

test("an update told at the ball's 15th tick is refused naming the tick its speed says", () => {
  assert.throws(() => assertUpdatesToldOnTime(readAt([2, 15, 20], [8, 8, 8]), 100, 8), /update 2: its speed [\d.]+ is the flight's at tick 15\.0, not the tick 10 the server tells it at/u);
});

/** The packets a real server sent with a deflection (a run of 2026-10-30: `entity_move_look -856 0` at the velocity's ms, then `4281 0` a tick on). */
const move = (name: string, dX: number, dZ: number) => ({ atMs: 53, name, packet: { dX, dZ } });

test("the position packet that comes with the new velocity is the ball's move since the last position told: zero, or the old flight's catch-up backwards", () => {
  assert.doesNotThrow(() => assertMoveWithDeflection(move("rel_entity_move", 0, 0)));
  assert.doesNotThrow(() => assertMoveWithDeflection(move("entity_move_look", -856, 0)));
});

test("a position packet with the new velocity that already moves the ball along her look, or sideways, or none at all, is refused naming the packet", () => {
  assert.throws(() => assertMoveWithDeflection(move("entity_move_look", 4281, 0)), /a position packet comes with the new velocity: entity_move_look moved it 1\.04\d+ blocks along x/u);
  assert.throws(() => assertMoveWithDeflection(move("entity_move_look", -856, 40)), /off the old flight's line \(dY 0, dZ 40\)/u);
  assert.throws(() => assertMoveWithDeflection({ ...move("entity_move_look", 0, 0), packet: { dX: 0, dY: 400, dZ: 0 } }), /off the old flight's line \(dY 400, dZ 0\)/u);
  assert.throws(() => assertMoveWithDeflection(move("entity_move_look", -40_000, 0)), /moved it -9\.7\d* blocks back along x, more than the old flight's 3\.8/u);
  assert.throws(() => assertMoveWithDeflection(undefined), /a position packet comes with the new velocity: none heard/u);
});

test("the one-tick gaps are judged in ticks, not 50 ms: a move of zero 3 ticks after its velocity is the next tick read twice, 4 is not", () => {
  const nextTick = { min: 0, max: 3 };
  assert.doesNotThrow(() => assertTicksApart("the move of zero", 500, 503, nextTick));
  assert.throws(() => assertTicksApart("the move of zero", 500, 504, nextTick), /the move of zero: 4 server ticks \(read at ticks 500 and 504\), not 0 to 3/u);
});

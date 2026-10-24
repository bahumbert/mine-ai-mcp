import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeClock } from "./fake-clock.js";
import { createFakeServer } from "./fake-server.js";

function serverAt(options: Parameters<typeof createFakeServer>[1] = {}) {
  const clock = createFakeClock({ mode: "manual" });
  return { clock, server: createFakeServer(clock, options) };
}

test("the world age moves 20 at each whole second of clock and not between", async () => {
  const { clock, server } = serverAt();
  await clock.advance(999);
  assert.equal(server.age, 24_000);
  await clock.advance(1);
  assert.equal(server.age, 24_020);
  await clock.advance(1_500);
  assert.equal(server.age, 24_040);
});

test("with phaseMs 999 the first time packet comes at 999 ms (a request sent 1 ms before it)", async () => {
  const { clock, server } = serverAt({ phaseMs: 999 });
  await clock.advance(998, 1);
  assert.equal(server.age, 24_000);
  await clock.advance(1, 1);
  assert.equal(server.age, 24_020);
  await clock.advance(1_000, 1);
  assert.equal(server.age, 24_040);
});

test("a server 30 % behind its schedule needs 3 time packets for 40 ticks", async () => {
  const { clock, server } = serverAt({ ticksPerSecond: 14 });
  let packets = 0;
  server.onTimePacket(() => (packets += 1));
  while (server.age < 24_040) await clock.advance(1_000);
  assert.equal(packets, 3);
  assert.equal(server.age, 24_042);
});

test("the time of day moves with the age and wraps at a day", async () => {
  const { clock, server } = serverAt({ timeOfDay: 23_990 });
  await clock.advance(1_000);
  assert.equal(server.timeOfDay, 10);
});

test("a stopped server keeps its age while the clock moves, and goes on after resume", async () => {
  const { clock, server } = serverAt();
  server.stop();
  await clock.advance(3_000);
  assert.equal(clock.now(), 3_000);
  assert.equal(server.age, 24_000);
  server.resume();
  await clock.advance(1_000);
  assert.equal(server.age, 24_020);
});

test("lagMs 300 delays an answer by 300 ms of clock", async () => {
  const { clock, server } = serverAt({ lagMs: 300 });
  let answered = false;
  server.answer(() => (answered = true));
  await clock.advance(250);
  assert.equal(answered, false);
  await clock.advance(50);
  assert.equal(answered, true);
});

test("an answer comes on the next slice, never inside the call that asked", async () => {
  const { clock, server } = serverAt();
  let answered = false;
  server.answer(() => (answered = true));
  assert.equal(answered, false);
  await clock.advance(50);
  assert.equal(answered, true);
});

test("a stopped server answers nothing until it resumes", async () => {
  const { clock, server } = serverAt();
  let answered = false;
  server.stop();
  server.answer(() => (answered = true));
  await clock.advance(2_000);
  assert.equal(answered, false);
  server.resume();
  await clock.advance(50);
  assert.equal(answered, true);
});

test("the server keeps its own rider record and the packets the client wrote", () => {
  const { server } = serverAt();
  assert.equal(server.riderOf(7), null);
  server.seatRider(7, 1);
  assert.equal(server.riderOf(7), 1);
  server.freeRider(7);
  assert.equal(server.riderOf(7), null);
  server.receive("entity_action", { actionId: 0 });
  assert.deepEqual(server.packets, [{ name: "entity_action", data: { actionId: 0 }, atMs: 0 }]);
});

test("sendPosition reaches every client listening for a position and is recorded as sent", () => {
  const { server } = serverAt();
  const seen: Vec3[] = [];
  server.onPosition((position) => seen.push(position));
  server.sendPosition(new Vec3(1, 64, 2));
  assert.deepEqual(seen, [new Vec3(1, 64, 2)]);
  assert.deepEqual(server.sentPositions, [new Vec3(1, 64, 2)]);
});

test("a received packet reaches the server's handlers for its name only", () => {
  const { server } = serverAt();
  const seen: unknown[] = [];
  server.onPacket("entity_action", (data) => seen.push(data));
  server.receive("player_input", { inputs: { jump: true } });
  server.receive("entity_action", { actionId: 0 });
  assert.deepEqual(seen, [{ actionId: 0 }]);
});

test("the server keeps where it has an entity, apart from what the client believes", () => {
  const { server } = serverAt();
  assert.equal(server.serverPositionOf(1), null);
  server.setServerPosition(1, new Vec3(0.5, 62.5, 0.5));
  assert.deepEqual(server.serverPositionOf(1), new Vec3(0.5, 62.5, 0.5));
});

test("resendTime sends a time packet carrying the age of now: the last packet's plus the ticks since, off the cadence", async () => {
  const { clock, server } = serverAt();
  await clock.advance(1_000);
  const ages: number[] = [];
  server.onTimePacket(() => ages.push(server.age));
  await clock.advance(500);
  server.resendTime();
  assert.deepEqual(ages, [24_030], "500 ms are 10 ticks into the second");
  await clock.advance(500);
  assert.deepEqual(ages, [24_030, 24_040], "the regular packet goes on from its own cadence, not from the extra's age");
});

test("resendTime in the tick of a regular packet carries that packet's age (a duplicate age)", async () => {
  const { clock, server } = serverAt();
  await clock.advance(2_000);
  const ages: number[] = [];
  server.onTimePacket(() => ages.push(server.age));
  server.resendTime();
  assert.deepEqual(ages, [24_040]);
});

test("resendTime on a server behind its schedule counts ticks at its own rate and never reaches the next packet's age", async () => {
  const { clock, server } = serverAt({ ticksPerSecond: 10 });
  await clock.advance(1_000);
  await clock.advance(999);
  server.resendTime();
  assert.equal(server.age, 24_019, "10 ticks a packet: 999 ms after the first packet (age 24010) are 9 ticks in");
});

test("resendTime leaves the day time as it is", async () => {
  const { clock, server } = serverAt({ timeOfDay: 6_000 });
  await clock.advance(1_500);
  server.resendTime();
  assert.equal(server.timeOfDay, 6_020);
});

test("the game time moves a tick every 50 ms of clock while the age the client hears moves 20 at the whole second", async () => {
  const { clock, server } = serverAt();
  await clock.advance(600);
  assert.equal(server.age, 24_000);
  assert.equal(server.gameTime, 24_012);
  await clock.advance(400);
  assert.equal(server.age, 24_020);
  assert.equal(server.gameTime, 24_020);
});

test("the game time runs 20 ticks a second at any phase of the time packets, never behind the age the client heard", async () => {
  const { clock, server } = serverAt({ phaseMs: 500 });
  await clock.advance(550);
  const first = server.gameTime;
  assert.ok(first >= server.age, `game time ${first}, age ${server.age}`);
  await clock.advance(400);
  assert.equal(server.gameTime - first, 8);
});

test("a server 30 % behind its schedule runs 14 ticks of game time in a second", async () => {
  const { clock, server } = serverAt({ ticksPerSecond: 14 });
  await clock.advance(500);
  assert.equal(server.gameTime, 24_007);
  await clock.advance(500);
  assert.equal(server.gameTime, 24_014);
});

test("a stopped server's game time stands still and goes on from there after resume", async () => {
  const { clock, server } = serverAt();
  await clock.advance(400);
  server.stop();
  await clock.advance(3_050);
  assert.equal(server.gameTime, 24_008);
  server.resume();
  await clock.advance(100);
  assert.equal(server.gameTime, 24_010);
});

/** Every tick the server runs, with the game time it ran at. */
function recordTicks(server: ReturnType<typeof createFakeServer>): number[] {
  const seen: number[] = [];
  server.onTick(() => seen.push(server.gameTime));
  return seen;
}

function assertAgeNotAhead(server: ReturnType<typeof createFakeServer>) {
  assert.ok(server.age <= server.gameTime, `age ${server.age} is ahead of game time ${server.gameTime}`);
}

test("onTick is the one tick stream: 20 ticks a second on time, 14 behind the schedule, none while stopped", async () => {
  const { clock, server } = serverAt();
  const onTime = recordTicks(server);
  await clock.advance(1_000);
  assert.equal(onTime.length, 20);
  assert.deepEqual(onTime.slice(0, 2), [24_001, 24_002], "each listener reads the game time of its own tick");
  const behind = serverAt({ ticksPerSecond: 14 });
  const slow = recordTicks(behind.server);
  await behind.clock.advance(1_000);
  assert.equal(slow.length, 14);
  assert.equal(behind.server.gameTime, 24_014);
  server.stop();
  await clock.advance(500);
  assert.equal(onTime.length, 20);
});

test("a listener added during a tick hears the next tick, one that removed itself hears no more", async () => {
  const { clock, server } = serverAt();
  const heard: string[] = [];
  const removeLate = server.onTick(() => heard.push("late"));
  removeLate();
  let added = false;
  server.onTick(() => {
    if (added) return;
    added = true;
    server.onTick(() => heard.push("added"));
    heard.push("adder");
  });
  await clock.advance(100);
  assert.deepEqual(heard, ["adder", "added"]);
  assertAgeNotAhead(server);
});

test("a stop of 800 ms at 20 ticks a second is caught up at once on resume: 16 ticks and the packet that fell in it", async () => {
  const { clock, server } = serverAt();
  await clock.advance(400);
  const packetAges: number[] = [];
  server.onTimePacket(() => packetAges.push(server.age));
  const ticks = recordTicks(server);
  server.stop();
  await clock.advance(800);
  assert.equal(server.gameTime, 24_008);
  assert.equal(ticks.length, 0);
  server.resume();
  assert.equal(ticks.length, 16, "the owed ticks run inside resume");
  assert.equal(server.gameTime, 24_024);
  assert.deepEqual(packetAges, [24_020], "the packet of the first second goes out at the resume");
  assertAgeNotAhead(server);
  await clock.advance(50);
  assert.equal(server.gameTime, 24_025, "the clock goes on from there, one tick a slice");
});

test("a stop of exactly 2000 ms is still caught up", async () => {
  const { clock, server } = serverAt();
  server.stop();
  await clock.advance(2_000);
  server.resume();
  assert.equal(server.gameTime, 24_040);
  assertAgeNotAhead(server);
});

test("a stop of 2500 ms drops the owed ticks and its time packets, and the server goes on from where it stopped", async () => {
  const { clock, server } = serverAt();
  await clock.advance(400);
  const packetAges: number[] = [];
  server.onTimePacket(() => packetAges.push(server.age));
  server.stop();
  await clock.advance(2_500);
  server.resume();
  assert.equal(server.gameTime, 24_008);
  assert.deepEqual(packetAges, []);
  assertAgeNotAhead(server);
  await clock.advance(600);
  assert.equal(server.gameTime, 24_020, "the first packet after the drop falls a second of running time after the start");
  assert.deepEqual(packetAges, [24_020]);
  assertAgeNotAhead(server);
});

test("a second stop of 2500 ms inside 15 s of a drop is caught up in full, one 15 s after it is dropped again", async () => {
  const { clock, server } = serverAt();
  server.stop();
  await clock.advance(2_500);
  server.resume();
  assert.equal(server.gameTime, 24_000, "the first long stall is dropped");
  await clock.advance(2_500);
  const before = server.gameTime;
  server.stop();
  await clock.advance(2_500);
  server.resume();
  assert.equal(server.gameTime - before, 50, "5 s after the drop: caught up");
  assertAgeNotAhead(server);
  await clock.advance(12_000);
  const later = server.gameTime;
  server.stop();
  await clock.advance(2_500);
  server.resume();
  assert.equal(server.gameTime, later, "15 s after the drop the owed ticks are dropped again");
  assertAgeNotAhead(server);
});

test("a stop at 14 ticks a second catches nothing up: the server already runs as fast as it can", async () => {
  const { clock, server } = serverAt({ ticksPerSecond: 14 });
  await clock.advance(500);
  const ticks = recordTicks(server);
  server.stop();
  await clock.advance(800);
  server.resume();
  assert.equal(ticks.length, 0);
  assert.equal(server.gameTime, 24_007);
  await clock.advance(500);
  assert.equal(server.gameTime, 24_014);
  assertAgeNotAhead(server);
});

test("answers queued during a stop run after the first caught-up tick, before the second", async () => {
  const { clock, server } = serverAt();
  server.stop();
  const order: string[] = [];
  server.onTick(() => order.push(`tick ${server.gameTime - 24_000}`));
  server.answer(() => order.push("answer"));
  await clock.advance(400);
  server.resume();
  assert.deepEqual(order.slice(0, 3), ["tick 1", "answer", "tick 2"]);
  assert.equal(order.length, 9, "8 caught-up ticks and the answer");
  assertAgeNotAhead(server);
});

test("a stop that catches up answers only what is due on a server with lag", async () => {
  const { clock, server } = serverAt({ lagMs: 1_000 });
  let answered = false;
  server.stop();
  server.answer(() => (answered = true));
  await clock.advance(400);
  server.resume();
  assert.equal(answered, false, "queued 400 ms ago, due in 600 ms more");
  await clock.advance(600);
  assert.equal(answered, true);
  assertAgeNotAhead(server);
});

test("the caught-up packet and age hold at phaseMs 0 and 999", async () => {
  for (const phaseMs of [0, 999]) {
    const { clock, server } = serverAt({ phaseMs });
    await clock.advance(200);
    const ages: number[] = [];
    server.onTimePacket(() => ages.push(server.age));
    server.stop();
    await clock.advance(1_500);
    server.resume();
    assert.equal(ages.length, 1, `phase ${phaseMs}: the packet inside the stop goes out at the resume`);
    assert.equal(ages[0], server.age);
    assertAgeNotAhead(server);
    await clock.advance(1_000);
    assert.equal(ages.length, 2, `phase ${phaseMs}: one more a second on`);
    assertAgeNotAhead(server);
  }
});

test("resendTime during a catch-up carries the game time of the tick it is sent in, and after it the world's age", async () => {
  const { clock, server } = serverAt();
  server.stop();
  await clock.advance(300);
  const ages: number[] = [];
  let tick = 0;
  server.onTick(() => {
    tick += 1;
    if (tick === 3) server.resendTime();
  });
  server.onTimePacket(() => ages.push(server.age));
  server.resume();
  assert.deepEqual(ages, [24_003]);
  assertAgeNotAhead(server);
  server.resendTime();
  assert.equal(server.age, 24_006, "6 ticks were caught up");
});

test("resendTime while stopped carries the game time it stopped at", async () => {
  const { clock, server } = serverAt();
  await clock.advance(1_300);
  server.stop();
  await clock.advance(700);
  server.resendTime();
  assert.equal(server.age, 24_026);
});

test("a stop inside a tick of a long slice leaves that slice's other ticks undone, not owed to a later slice", async () => {
  const { clock, server } = serverAt();
  let tick = 0;
  server.onTick(() => {
    tick += 1;
    if (tick === 2) server.stop();
  });
  await clock.advance(200, 200);
  assert.equal(tick, 2, "the stop ends the slice's ticks");
  await clock.advance(2_500);
  server.resume();
  const before = tick;
  await clock.advance(50);
  assert.equal(tick - before, 1, "one tick for one slice, not the two the stopped slice left");
});

test("a ticksPerSecond that is not a whole number above 0 is refused: the time packets come every that many ticks", () => {
  for (const ticksPerSecond of [0, 14.5, -1]) assert.throws(() => serverAt({ ticksPerSecond }), /ticksPerSecond/);
});

test("a stop and resume inside a tick owe nothing and the slice's other ticks run", async () => {
  const { clock, server } = serverAt();
  let tick = 0;
  server.onTick(() => {
    tick += 1;
    if (tick !== 3) return;
    server.stop();
    server.resume();
  });
  await clock.advance(200);
  assert.equal(server.gameTime, 24_004);
  assert.equal(tick, 4);
});

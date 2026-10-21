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

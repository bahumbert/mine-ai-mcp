/**
 * The fake bot's boat moves (contract check `boat-follows-vehicle-move`, Mine Labs 1.21.4, 2026-10-23): the rider's
 * `vehicle_move` moves the server's boat and the client sees it follow; a move into a block is answered by the server's
 * own `vehicle_move` with the last position it accepted; a bot the server does not have seated moves nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { writeShiftKey } from "../../navigation/mineflayer/sneak.js";
import { type FakeBotOptions, type FakeHarness, createFakeBot } from "./fake-bot.js";
import { createFakeClock } from "./fake-clock.js";

const POOL = Object.fromEntries([2, 3, 4].flatMap((x) => [-1, 0, 1].map((z) => [`${x},-61,${z}`, "water"])));
const BOAT_ID = 7;
const BOAT_Y = -60.477;
/** The boat is 1.375 wide: its edge at x 4.2986 + 0.6875 = 4.986 is inside the pool (the bank block starts at x 5). */
const LAST_FREE_X = 4.3;
const STEP_MS = 50;

function seatedBoat(options: FakeBotOptions = {}): FakeHarness {
  return createFakeBot({
    position: new Vec3(0.5, -60, 0.5),
    cells: POOL,
    entities: { [BOAT_ID]: { name: "oak_boat", position: new Vec3(3.5, BOAT_Y, 0.5) } },
    ...options,
  });
}

async function seat({ bot, clock }: FakeHarness): Promise<void> {
  bot.mount(bot.entities[BOAT_ID]!);
  await clock.advance(100);
}

function moveTo({ bot }: FakeHarness, x: number, y = BOAT_Y): void {
  bot._client.write("vehicle_move", { x, y, z: 0.5, yaw: -90, pitch: 0, onGround: false });
}

test("a vehicle_move moves the server's boat and the client sees it follow; a move into a block is put back with the server's own vehicle_move", async () => {
  const harness = seatedBoat();
  const { bot, clock, server } = harness;
  await seat(harness);
  const moved: number[] = [];
  bot.on("entityMoved", (entity) => void moved.push(entity.position.x));
  for (const x of [3.7, 3.9, 4.1, LAST_FREE_X]) {
    moveTo(harness, x);
    await clock.advance(STEP_MS);
  }
  await clock.advance(STEP_MS);
  assert.equal(bot.entities[BOAT_ID]!.position.x, LAST_FREE_X);
  assert.deepEqual(moved, [3.7, 3.9, 4.1, LAST_FREE_X]);
  assert.equal(server.serverPositionOf(BOAT_ID)!.x, LAST_FREE_X);
  assert.equal(bot.entity.position.x, 3.5, "put at the seat when seated (contract check boat-broken-by-attack); the boat's later moves do not move her again (unmeasured)");
  // A move into the bank block (the boat is 1.375 wide: edge 5.19 against the block at x 5) is put back.
  const corrections: unknown[] = [];
  bot._client.on("vehicle_move", (packet: unknown) => void corrections.push(packet));
  moveTo(harness, 4.5);
  await clock.advance(STEP_MS * 2);
  assert.deepEqual(corrections, [{ x: LAST_FREE_X, y: BOAT_Y, z: 0.5, yaw: -90, pitch: 0 }]);
  await clock.advance(1_000);
  assert.equal(bot.entities[BOAT_ID]!.position.x, LAST_FREE_X);
  moveTo(harness, 4.0);
  await clock.advance(STEP_MS * 2);
  assert.equal(bot.entities[BOAT_ID]!.position.x, 4.0, "a move back out of the block is taken");
});

test("a vehicle_move from a bot the server does not have seated moves nothing and is not answered", async () => {
  const harness = seatedBoat();
  const { bot, clock } = harness;
  const heard: unknown[] = [];
  bot._client.on("vehicle_move", (packet: unknown) => void heard.push(packet));
  moveTo(harness, 3.8);
  await clock.advance(1_000);
  assert.equal(bot.entities[BOAT_ID]!.position.x, 3.5, "never seated");
  await seat(harness);
  writeShiftKey(bot, true);
  await clock.advance(2_000);
  moveTo(harness, 4.0);
  await clock.advance(1_000);
  assert.equal(bot.entities[BOAT_ID]!.position.x, 3.5, "let off by the shift: the server has no rider (vanilla rule; the contract check measured the never-seated case only)");
  assert.deepEqual(heard, []);
});

test("the boat follows only once the server answers: not while it is stopped, a lag later when it lags", async () => {
  const stopped = seatedBoat();
  await seat(stopped);
  stopped.server.stop();
  moveTo(stopped, 3.8);
  await stopped.clock.advance(1_000);
  assert.equal(stopped.bot.entities[BOAT_ID]!.position.x, 3.5);
  stopped.server.resume();
  await stopped.clock.advance(STEP_MS);
  assert.equal(stopped.bot.entities[BOAT_ID]!.position.x, 3.8);
  const lagging = seatedBoat({ lagMs: 200 });
  await seat(lagging);
  moveTo(lagging, 3.8);
  await lagging.clock.advance(150);
  assert.equal(lagging.bot.entities[BOAT_ID]!.position.x, 3.5);
  await lagging.clock.advance(100);
  assert.equal(lagging.bot.entities[BOAT_ID]!.position.x, 3.8);
});

test("two harnesses on one clock move their own boats", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const first = seatedBoat({ clock });
  const second = seatedBoat({ clock });
  await seat(first);
  await seat(second);
  moveTo(first, 3.9);
  await clock.advance(STEP_MS * 2);
  assert.equal(first.bot.entities[BOAT_ID]!.position.x, 3.9);
  assert.equal(second.bot.entities[BOAT_ID]!.position.x, 3.5);
});

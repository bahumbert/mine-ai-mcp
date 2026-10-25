import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeBotOptions, createFakeBot } from "./fake-bot.js";

/** The feet in a 2-deep pool: the eye (1.62 up) is in the upper cell. */
const POOL: FakeBotOptions["cells"] = { "0,64,0": "water", "0,65,0": "water" };
const POOL_FEET = new Vec3(0.5, 64, 0.5);
/** A server answer reaches the client one slice after the tick that made it (`FakeServer.answer`). */
const DELIVERY_MS = 50;

/** The player's `air_supply` metadata index in the version's registry (`entities.js:478-479` reads it by key). */
function airIndex(bot: ReturnType<typeof createFakeBot>["bot"]): number {
  return bot.registry.entitiesByName.player!.metadataKeys!.indexOf("air_supply");
}

test("a held air is told to the client as a server answer, as the metadata, oxygenLevel and a breath event, and stays while the eye is in air", async () => {
  const { bot, clock, breath } = createFakeBot();
  const levels: number[] = [];
  bot.on("breath", () => {
    levels.push(bot.oxygenLevel);
  });
  breath.hold(120);
  await clock.advance(DELIVERY_MS);
  assert.equal(bot.entity.metadata[airIndex(bot)], 120);
  assert.equal(bot.oxygenLevel, 8);
  assert.deepEqual(levels, [8]);
  await clock.advance(2_000);
  assert.equal(breath.airSupply, 120, "out of the water the air would refill 4 a tick; held, it does not");
  assert.equal(bot.entity.metadata[airIndex(bot)], 120);
  assert.deepEqual(levels, [8], "no further packet while held");
  assert.equal(breath.held, true);
});

test("a held air does not fall with the eye in water", async () => {
  const { bot, clock, breath } = createFakeBot({ position: POOL_FEET, cells: POOL });
  breath.hold(120);
  await clock.advance(2_000);
  assert.equal(breath.airSupply, 120);
  assert.equal(bot.entity.metadata[airIndex(bot)], 120);
});

test("a release out of the water resumes the refill at 4 a tick up to the full 300", async () => {
  const { bot, clock, breath } = createFakeBot();
  breath.hold(120);
  await clock.advance(1_000);
  breath.release();
  assert.equal(breath.held, false);
  await clock.advance(500 + DELIVERY_MS);
  assert.equal(bot.entity.metadata[airIndex(bot)], 120 + 4 * 10);
  await clock.advance(2_000);
  assert.equal(bot.entity.metadata[airIndex(bot)], 300);
});

test("a release under water resumes the fall at 1 a tick", async () => {
  const { bot, clock, breath } = createFakeBot({ position: POOL_FEET, cells: POOL });
  breath.hold(120);
  await clock.advance(1_000);
  breath.release();
  await clock.advance(1_000 + DELIVERY_MS);
  assert.equal(bot.entity.metadata[airIndex(bot)], 120 - 20);
});

test("a second hold replaces the held air, and a release with nothing held changes nothing", async () => {
  const { bot, clock, breath } = createFakeBot();
  breath.release();
  await clock.advance(1_000);
  assert.equal(bot.entity.metadata[airIndex(bot)], undefined, "full air, nothing was sent");
  breath.hold(120);
  breath.hold(45);
  await clock.advance(1_000);
  assert.equal(breath.airSupply, 45);
  assert.equal(bot.entity.metadata[airIndex(bot)], 45);
  assert.equal(bot.oxygenLevel, 3);
});

test("a stopped server tells no held air; the resumed one tells it", async () => {
  const { bot, clock, server, breath } = createFakeBot();
  server.stop();
  breath.hold(120);
  await clock.advance(1_000);
  assert.equal(bot.entity.metadata[airIndex(bot)], undefined);
  server.resume();
  await clock.advance(1_000);
  assert.equal(bot.entity.metadata[airIndex(bot)], 120);
});

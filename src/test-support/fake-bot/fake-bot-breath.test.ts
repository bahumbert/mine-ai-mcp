import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeBotOptions, createFakeBot } from "./fake-bot.js";

/** The feet in a 2-deep pool: the eye (1.62 up) is in the upper cell. */
const POOL: FakeBotOptions["cells"] = { "0,64,0": "water", "0,65,0": "water" };
const POOL_FEET = new Vec3(0.5, 64, 0.5);
/** The upper pool cell gone: the feet still in water, the eye in air. */
const SHALLOW: FakeBotOptions["cells"] = { "0,64,0": "water" };
/** The player's `air_supply` metadata index in the version's registry (`entities.js:478-479` reads it by key). */
function airIndex(bot: ReturnType<typeof createFakeBot>["bot"]): number {
  return bot.registry.entitiesByName.player!.metadataKeys!.indexOf("air_supply");
}

test("with the eye in water the server's air falls a tick each 50 ms: the player's air_supply metadata, read as oxygenLevel with a breath event (entities.js:515-518)", async () => {
  const { bot, clock } = createFakeBot({ position: POOL_FEET, cells: POOL });
  const levels: number[] = [];
  bot.on("breath", () => {
    levels.push(bot.oxygenLevel);
  });
  await clock.advance(1_000);
  assert.equal(bot.entity.metadata[airIndex(bot)], 300 - 20);
  assert.equal(levels.length, 20, "one metadata packet a server tick");
  assert.equal(bot.oxygenLevel, Math.round(280 / 15));
  assert.equal(levels[0], Math.round(299 / 15));
});

test("with the eye in air and the feet in water the air does not fall", async () => {
  const { bot, clock } = createFakeBot({ position: POOL_FEET, cells: SHALLOW });
  const packets: number[] = [];
  bot.on("breath", () => {
    packets.push(1);
  });
  await clock.advance(2_000);
  assert.deepEqual(packets, [], "full air is not resent");
  assert.equal(bot.entity.metadata[airIndex(bot)], undefined, "nothing was sent: the client knows no air yet");
});

test("out of the water the air refills 4 a tick up to the full 300, and stops sending there", async () => {
  const { bot, clock, world, breath } = createFakeBot({ position: POOL_FEET, cells: POOL });
  await clock.advance(3_000);
  assert.equal(bot.entity.metadata[airIndex(bot)], 300 - 60);
  world.setCell(new Vec3(0, 65, 0), "air");
  await clock.advance(500);
  // 10 ticks of 4 from the 240 the dive left.
  assert.equal(bot.entity.metadata[airIndex(bot)], 240 + 4 * 10);
  await clock.advance(500);
  assert.equal(bot.entity.metadata[airIndex(bot)], 300);
  let sent = 0;
  bot.on("breath", () => {
    sent += 1;
  });
  await clock.advance(1_000);
  assert.equal(sent, 0);
  assert.equal(breath.airSupply, 300);
});

test("the air does not go below 0: the drowning damage is the server's and not modelled", async () => {
  const { bot, clock, breath } = createFakeBot({ position: POOL_FEET, cells: POOL });
  breath.setAirSupply(3);
  await clock.advance(1_000);
  assert.equal(bot.entity.metadata[airIndex(bot)], 0);
  assert.equal(bot.oxygenLevel, 0);
});

test("a stopped server sends no air; one stopped under 2 s runs the air ticks it owes at the resume (the game catches the stall up)", async () => {
  const { bot, clock, server } = createFakeBot({ position: POOL_FEET, cells: POOL });
  await clock.advance(500);
  assert.equal(bot.entity.metadata[airIndex(bot)], 290);
  server.stop();
  await clock.advance(1_000);
  assert.equal(bot.entity.metadata[airIndex(bot)], 290);
  server.resume();
  await clock.advance(500);
  // 10 ticks before the stop, the 20 owed ones run at the resume, 10 more after it.
  assert.equal(bot.entity.metadata[airIndex(bot)], 300 - 10 - 20 - 10);
});

test("a stall over 2 s is dropped by the game: the air goes on from where it was, the owed ticks never run", async () => {
  const { bot, clock, server } = createFakeBot({ position: POOL_FEET, cells: POOL });
  await clock.advance(500);
  server.stop();
  await clock.advance(2_500);
  assert.equal(bot.entity.metadata[airIndex(bot)], 290);
  server.resume();
  await clock.advance(500);
  assert.equal(bot.entity.metadata[airIndex(bot)], 300 - 10 - 10);
});

test("a server at 14 ticks a second drops 14 air a second and catches nothing up after a stop", async () => {
  const { bot, clock, server } = createFakeBot({ position: POOL_FEET, cells: POOL, server: { ticksPerSecond: 14 } });
  await clock.advance(1_000);
  assert.equal(bot.entity.metadata[airIndex(bot)], 300 - 14);
  server.stop();
  await clock.advance(1_000);
  server.resume();
  await clock.advance(1_000);
  assert.equal(bot.entity.metadata[airIndex(bot)], 300 - 28);
});

test("a server that answers lagMs late sends the air of a tick in that tick: the lag is in its answers to the client's acts, not in packets it sends on its own", async () => {
  // The game sends the metadata of the tick that changed it (`ServerEntity.sendChanges` after `LivingEntity.baseTick`); contract check `air-supply-under-water`, 3 runs of 2026-10-23: a packet a tick, 60 +-0 over 3 s, spans within 3 ms. The time packets and a fireball's updates are not lagged either.
  const { bot, clock } = createFakeBot({ position: POOL_FEET, cells: POOL, lagMs: 300 });
  await clock.advance(100);
  assert.equal(bot.entity.metadata[airIndex(bot)], 300 - 2, "two ticks heard in 100 ms, 300 ms lag or not");
});

test("a test that replaces bot.entity gets the air on the new entity", async () => {
  const { bot, clock } = createFakeBot({ position: POOL_FEET, cells: POOL });
  const replacement = Object.assign(Object.create(Object.getPrototypeOf(bot.entity)), bot.entity, { metadata: [] });
  Object.assign(bot, { entity: replacement });
  await clock.advance(500);
  assert.equal(replacement.metadata[airIndex(bot)], 290);
});

test("the eye in a flowing cell whose water ends below the eye is in air", async () => {
  // `Entity.updateFluidOnEyes`: the eye, less 1/9, against the cell's own fluid height ((8 - level) / 9 for a flowing cell).
  const { bot, clock } = createFakeBot({ position: POOL_FEET, cells: { "0,64,0": "water", "0,65,0": { name: "water", properties: { level: 7 } } } });
  await clock.advance(500);
  assert.equal(bot.entity.metadata[airIndex(bot)], undefined);
});

test("oxygenLevel stays a plain property as Mineflayer leaves it: a test writing it sends no air", () => {
  const { bot, breath } = createFakeBot();
  bot.oxygenLevel = 7;
  assert.equal(bot.oxygenLevel, 7);
  assert.equal(bot.entity.metadata[airIndex(bot)], undefined);
  assert.equal(breath.airSupply, 300);
});

test("setAirSupply is the server's own air: the next tick in water goes on from it", async () => {
  const { bot, clock, breath } = createFakeBot({ position: POOL_FEET, cells: POOL });
  breath.setAirSupply(100);
  assert.equal(bot.entity.metadata[airIndex(bot)], 100, "sent at once");
  await clock.advance(100);
  assert.equal(bot.entity.metadata[airIndex(bot)], 98);
});

test("the eye in a plant or a waterlogged block is in water, and under water above the cell the whole cell counts", async () => {
  // `Entity.updateFluidOnEyes`: kelp and seagrass hold water; a flowing cell with water above is full, as in a column.
  for (const head of ["kelp_plant", "seagrass", { name: "oak_stairs", properties: { waterlogged: true } }, "water"] as const) {
    const { bot, clock } = createFakeBot({ position: POOL_FEET, cells: { "0,64,0": "water", "0,65,0": head } });
    await clock.advance(500);
    assert.equal(bot.entity.metadata[airIndex(bot)], 290, `eye in ${typeof head === "string" ? head : head.name}`);
  }
  const column = createFakeBot({
    position: POOL_FEET,
    cells: { "0,64,0": "water", "0,65,0": { name: "water", properties: { level: 7 } }, "0,66,0": "water" },
  });
  await column.clock.advance(500);
  assert.equal(column.bot.entity.metadata[airIndex(column.bot)], 290, "water above makes the flowing cell full");
});

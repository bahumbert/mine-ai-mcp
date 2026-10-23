/**
 * The server's air for a bot in a 2-deep pool: nothing is sent while the eye is in air with a full meter, then the
 * `air_supply` metadata falls a tick at a time with the eye under water, then refills out of it and stops at full.
 * Mineflayer files it at the player's `air_supply` key and reads `oxygenLevel` from it (`entities.js:515-518`).
 */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";
import { holdsWithin } from "../subject.ts";

/** The top pool cell, empty at the start (the eye in air), then water, then air again. */
const HEAD_CELL = new Vec3(0, -59, 0);
/** The pool: the bot's feet cell is water, held by glass on its four sides and by the top glass of the floor below. */
const GLASS_CELLS = [
  [-1, -60, 0], [1, -60, 0], [0, -60, -1], [0, -60, 1],
  [-1, -59, 0], [1, -59, 0], [0, -59, -1], [0, -59, 1],
];
/** Quiet before the dive: no air packet from a full meter. */
const FULL_AIR_QUIET_MS = 1_000;
/** The dive that is measured. */
const DIVE_MS = 3_000;
/** The first packet, a server tick after the eye went under (a server behind its schedule, a round trip more). */
const FIRST_PACKET_WALL_MS = 2_000;
/** The full meter (`LivingEntity.getMaxAirSupply`), and what one server tick takes from it under water and gives back out of it. */
const FULL_AIR = 300;
const AIR_LOST_PER_TICK = 1;
const AIR_GAINED_PER_TICK = 4;
const TICK_MS = 50;
/**
 * Ticks a window may differ from its length: a server on time gave 60 +-0 over 3 s and 16 +-0 over 800 ms in 3 runs
 * (2026-10-23, a packet per tick, spans within 3 ms); 6 ticks (0.3 s) is a server a little behind.
 */
const LAG_SLACK_TICKS = 6;

/** One air packet as the client filed it. */
interface Reading {
  readonly air: number;
  readonly atMs: number;
}

/** The change from each reading to the next. */
function stepsOf(readings: readonly Reading[]): number[] {
  return readings.slice(1).map((reading, index) => reading.air - readings[index]!.air);
}

/** The readings from the one before the first rise: the refill, whatever tick still counted under water landed first. */
function refillOf(readings: readonly Reading[]): readonly Reading[] {
  const risen = readings.findIndex((reading, index) => index > 0 && reading.air > readings[index - 1]!.air);
  assert.ok(risen > 0, "the air never rose");
  return readings.slice(risen - 1);
}

export const airSupplyUnderWater: ContractCheck = {
  name: "air-supply-under-water",
  // Our runtime swims for air once the eyes are under water (the idle-water control) and would move the bot.
  withoutRuntime: true,
  fixture: {
    cells: {
      ...Object.fromEntries(GLASS_CELLS.map((cell) => [cell.join(","), "glass"])),
      "0,-60,0": "water",
    },
    carried: {},
    position: [0.5, -60, 0.5],
  },
  async run(subject) {
    const { bot, wait } = subject;
    const index = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("air_supply");
    const airHeard = (): number | undefined => {
      const value: unknown = Reflect.get(bot.entity.metadata, index);
      return typeof value === "number" ? value : undefined;
    };
    const readings: Reading[] = [];
    const onBreath = () => void readings.push({ air: airHeard()!, atMs: subject.now() });
    bot.on("breath", onBreath);
    try {
      await wait(FULL_AIR_QUIET_MS);
      assert.equal(airHeard(), undefined, "the client knows no air from a full meter");
      assert.equal(readings.length, 0, "no air packet for a full meter with the eye in air");

      await subject.setBlock(HEAD_CELL, "water");
      assert.ok(await holdsWithin(subject, () => readings.length > 0, FIRST_PACKET_WALL_MS), "no air packet within the wall bound with the eye under water");
      const diveFrom = readings.length - 1;
      assert.equal(readings[diveFrom]!.air, FULL_AIR - AIR_LOST_PER_TICK, "the first tick under water takes 1 from the full meter");
      await wait(DIVE_MS);
      const dive = readings.slice(diveFrom);
      assert.ok(stepsOf(dive).every((step) => step === -AIR_LOST_PER_TICK), `dive steps ${stepsOf(dive).join(", ")}: each -${AIR_LOST_PER_TICK}, one packet a server tick`);
      const lost = dive[0]!.air - dive.at(-1)!.air;
      assert.ok(Math.abs(lost - DIVE_MS / TICK_MS) <= LAG_SLACK_TICKS, `${lost} air lost in ${DIVE_MS} ms: ${DIVE_MS / TICK_MS} within ${LAG_SLACK_TICKS}`);

      await subject.setBlock(HEAD_CELL, "air");
      assert.ok(await holdsWithin(subject, () => airHeard() === FULL_AIR, DIVE_MS), `the air is ${String(airHeard())}, not refilled`);
      const refill = refillOf(readings);
      const steps = stepsOf(refill);
      assert.ok(steps.every((step) => step > 0 && step <= AIR_GAINED_PER_TICK), `refill steps ${steps.join(", ")}: each 1 to ${AIR_GAINED_PER_TICK}`);
      assert.ok(steps.slice(0, -1).every((step) => step === AIR_GAINED_PER_TICK), `refill steps ${steps.join(", ")}: all ${AIR_GAINED_PER_TICK} but the last, which stops at full`);
      const refillMs = refill.at(-1)!.atMs - refill[0]!.atMs;
      const expectedMs = Math.ceil((FULL_AIR - refill[0]!.air) / AIR_GAINED_PER_TICK) * TICK_MS;
      assert.ok(Math.abs(refillMs - expectedMs) <= LAG_SLACK_TICKS * TICK_MS, `refilled in ${Math.round(refillMs)} ms: ${expectedMs} within ${LAG_SLACK_TICKS * TICK_MS}`);
      const refilled = readings.length;
      await wait(FULL_AIR_QUIET_MS);
      assert.equal(readings.length, refilled, "a full meter sends no more air");
    } finally {
      bot.off("breath", onBreath);
    }
  },
};

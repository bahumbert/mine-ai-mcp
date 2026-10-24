/**
 * The server's air for a bot in a 2-deep pool: nothing is sent while the eye is in air with a full meter, then the
 * `air_supply` metadata falls a tick at a time with the eye under water, then refills out of it and stops at full.
 * Mineflayer files it at the player's `air_supply` key and reads `oxygenLevel` from it (`entities.js:515-518`).
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { serverQuiet } from "../server-answer.ts";
import { holdsWithin } from "../subject.ts";
import { markNow, restTicksSince, tickOf } from "./server-tick-marks.ts";

/** The top pool cell, empty at the start (the eye in air), then water, then air again. */
const HEAD_CELL = [0, -59, 0] as const;
/** The pool: the bot's feet cell is water, held by glass on its four sides and by the top glass of the floor below. */
const GLASS_CELLS = [
  [-1, -60, 0], [1, -60, 0], [0, -60, -1], [0, -60, 1],
  [-1, -59, 0], [1, -59, 0], [0, -59, -1], [0, -59, 1],
];
/** The dive that is measured, in server ticks (3 s on a server on time). */
const DIVE_TICKS = 60;
/** The wall bound of the refill: 15 ticks of 4 air for a dive of 60, with a server at 10 ticks a second and the client's lag. */
const REFILL_WALL_MS = 5_000;
/** The first packet, a server tick after the eye went under (a server behind its schedule, a round trip more). */
const FIRST_PACKET_WALL_MS = 2_000;
/** The full meter (`LivingEntity.getMaxAirSupply`), and what one server tick takes from it under water and gives back out of it. */
const FULL_AIR = 300;
const AIR_LOST_PER_TICK = 1;
const AIR_GAINED_PER_TICK = 4;
/**
 * Ticks the air packets of a window may differ from the server's ticks read around it: a server on time gave 60 +-0 over 3 s and 16 +-0 over 800 ms in 3 runs
 * (2026-10-23, a packet per tick, spans within 3 ms); 6 ticks are the readings' error (2 each way), the tick or two before the first packet and the packets still on their way.
 */
const LAG_SLACK_TICKS = 6;

/** One air packet as the client filed it, with the world age the client held when it came. */
interface Reading {
  readonly air: number;
  readonly atMs: number;
  readonly age: number;
}

/** The readings as a failure message shows them: air, wall time into the check, world age (a time packet comes every 20 ticks, so the age is up to 19 ticks stale). */
function describeReadings(readings: readonly Reading[], startedAtMs: number): string {
  return readings.map(({ air, atMs, age }) => `${air}@${Math.round(atMs - startedAtMs)}ms/age ${age}`).join(", ");
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
    const { bot } = subject;
    const index = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("air_supply");
    const airHeard = (): number | undefined => {
      const value: unknown = Reflect.get(bot.entity.metadata, index);
      return typeof value === "number" ? value : undefined;
    };
    const readings: Reading[] = [];
    const startedAtMs = subject.now();
    let wateredAt = "no water placed yet";
    const onBreath = () => void readings.push({ air: airHeard()!, atMs: subject.now(), age: bot.time.age });
    bot.on("breath", onBreath);
    try {
      await serverQuiet(subject, "a full meter with the eye in air");
      assert.equal(airHeard(), undefined, "the client knows no air from a full meter");
      assert.equal(readings.length, 0, "no air packet for a full meter with the eye in air");

      const waterPlaced = markNow(subject);
      await subject.setBlock(subject.world(HEAD_CELL), "water");
      wateredAt = `water seen at ${Math.round(subject.now() - startedAtMs)}ms/age ${bot.time.age}`;
      assert.ok(await holdsWithin(subject, () => readings.length > 0, FIRST_PACKET_WALL_MS), "no air packet within the wall bound with the eye under water");
      // The dive is every reading from the first: the check looks every 25 ms, and a client busy for longer files several packets before it looks (6c-warm: 297, 2 ticks in; a 6b lane: 298).
      assert.equal(readings[0]!.air, FULL_AIR - AIR_LOST_PER_TICK, "the first tick under water takes 1 from the full meter");
      await restTicksSince(subject, waterPlaced, DIVE_TICKS, "the dive");
      const diveEnded = markNow(subject);
      const dive = readings.slice();
      assert.ok(stepsOf(dive).every((step) => step === -AIR_LOST_PER_TICK), `dive steps ${stepsOf(dive).join(", ")}: each -${AIR_LOST_PER_TICK}, one packet a server tick`);
      const lost = dive[0]!.air - dive.at(-1)!.air;
      const diveTicks = (await tickOf(subject, diveEnded)) - (await tickOf(subject, waterPlaced));
      assert.ok(Math.abs(lost - diveTicks) <= LAG_SLACK_TICKS, `${lost} air lost in ${diveTicks} server ticks, read right before the water and after the dive: one air a tick, within ${LAG_SLACK_TICKS}`);

      const airPlaced = markNow(subject);
      await subject.setBlock(subject.world(HEAD_CELL), "air");
      assert.ok(await holdsWithin(subject, () => airHeard() === FULL_AIR, REFILL_WALL_MS), `the air is ${String(airHeard())}, not refilled`);
      const refillHeard = markNow(subject);
      const refill = refillOf(readings);
      const steps = stepsOf(refill);
      assert.ok(steps.every((step) => step > 0 && step <= AIR_GAINED_PER_TICK), `refill steps ${steps.join(", ")}: each 1 to ${AIR_GAINED_PER_TICK}`);
      assert.ok(steps.slice(0, -1).every((step) => step === AIR_GAINED_PER_TICK), `refill steps ${steps.join(", ")}: all ${AIR_GAINED_PER_TICK} but the last, which stops at full`);
      const refillTicks = (await tickOf(subject, refillHeard)) - (await tickOf(subject, airPlaced));
      assert.ok(Math.abs(steps.length - refillTicks) <= LAG_SLACK_TICKS, `refilled in ${steps.length} air packets in ${refillTicks} server ticks, read right before the air and when the refill was heard: one packet a tick, within ${LAG_SLACK_TICKS}`);
      const refilled = readings.length;
      await serverQuiet(subject, "a full meter after the refill");
      assert.equal(readings.length, refilled, "a full meter sends no more air");
    } catch (error) {
      // Every air reading with its wall time and the world age: a reading that skips ticks is told from a client that missed one (plan T7d1 step 4).
      throw new Error(`${(error as Error).message}; ${wateredAt}; air readings (air@ms/age): ${describeReadings(readings, startedAtMs)}`, { cause: error });
    } finally {
      bot.off("breath", onBreath);
    }
  },
};

/**
 * A dig ends after the block's own dig time from Mineflayer's inputs (`digging.js:232-259`), the cell turns to air and
 * the server keeps it so: once on dry ground, once with the eye in water (5x or more; review #1 was a dig under water).
 */
import assert from "node:assert/strict";
import type { ContractSubject, LocalPoint } from "../subject.ts";
import type { ContractCheck } from "../checks.ts";
import { afterClientTicks, afterServerTicks, serverQuiet } from "../server-answer.ts";
import { settleWithin } from "../subject.ts";

/** The dry target beside the feet, the wet one above it at eye level, and the head cell the water goes into. */
const DRY_TARGET = [1, -60, 0] as const;
const WET_TARGET = [1, -59, 0] as const;
const HEAD_CELL = [0, -59, 0] as const;
/**
 * The look is forced (no turn: a non-forced one turns at 3 rad/s first, `physics.js:169`, ~1 s for half a turn on
 * the server run of 2026-10-21), so only the dig is timed; its end is read within a tick or two.
 * The timed span is a client duration, so it stays on the wall clock (plan T7d6b, 2026-10-24): Mineflayer ends the dig with its own `setTimeout(finishDigging, digTime)`
 * and turns the cell to air itself (`digging.js:137,161`), so no server answer sets it; a server behind its schedule or a stall changes nothing in it.
 * What the server says of the dig (it puts the dirt back if it disagrees) is read after, over server ticks (`serverQuiet`).
 */
const DIG_SLACK_MS = 150;
/** Server ticks the water takes to flow from the head cell down to the feet and the pocket (vanilla: 5 ticks a step, two steps; unmeasured here). */
const WATER_FLOW_TICKS = 10;
/** The client's physics ticks the body needs to settle in the water (or float against the roof) before the dig reads its inputs: a second of the client's 20 a second. */
const BODY_SETTLE_CLIENT_TICKS = 20;
/** A dig under water by hand is slow (dirt 3.75 s; airborne too, 18.75 s): the bound covers both. */
const DIG_WALL_MS = 25_000;
/** Mineflayer's (and the game's) factor for the eye in water without Aqua Affinity. */
const EYE_IN_WATER_FACTOR = 5;

/** The bot stands in a glass shaft; each dug cell is a glass pocket, so the water put at its head stays there. */
const GLASS_CELLS = [
  [-1, -60, 0], [-1, -59, 0], [0, -60, 1], [0, -59, 1], [0, -60, -1], [0, -59, -1], [0, -58, 0],
  [2, -60, 0], [1, -60, 1], [1, -60, -1], [2, -59, 0], [1, -59, 1], [1, -59, -1], [1, -58, 0],
];

/** Dig `target`; returns the dig time Mineflayer expected, after checking the dig took it and the server kept the cell open. */
async function digAndCheck(subject: ContractSubject, local: LocalPoint, label: string): Promise<number> {
  const { bot } = subject;
  const target = subject.world(local);
  const block = bot.blockAt(target)!;
  assert.equal(block.name, "dirt", `${label} target ${target}: ${block.name}`);
  const expectedMs = bot.digTime(block);
  const startedAt = subject.now();
  const settled = await settleWithin(subject, bot.dig(block, true), DIG_WALL_MS);
  assert.ok(settled !== null && settled.error === undefined, `${label} dig: ${settled?.error?.message ?? "never ended"}`);
  const tookMs = settled.atMs - startedAt;
  assert.ok(tookMs >= expectedMs && tookMs <= expectedMs + DIG_SLACK_MS, `${label} dig took ${Math.round(tookMs)} ms: digTime ${expectedMs} + 0..${DIG_SLACK_MS}`);
  // The dig itself is the measured wait (above). A server that disagreed with the dig time sends the block back within its ticks.
  await serverQuiet(subject, `${label}: after the dig`);
  assert.notEqual(bot.blockAt(target)?.name, "dirt", `${label}: the server put the dirt back (it disagreed with the dig time)`);
  return expectedMs;
}

export const digTimeAndUpdate: ContractCheck = {
  name: "dig-time-and-update",
  // Our runtime's idle-water control takes the body once the eyes are under water and aborts the dig (2026-10-21).
  withoutRuntime: true,
  fixture: {
    cells: {
      ...Object.fromEntries(GLASS_CELLS.map((cell) => [cell.join(","), "glass"])),
      [DRY_TARGET.join(",")]: "dirt",
      [WET_TARGET.join(",")]: "dirt",
    },
    carried: {},
    position: [0.5, -60, 0.5],
  },
  async run(subject) {
    const dryMs = await digAndCheck(subject, DRY_TARGET, "dry");
    await subject.setBlock(subject.world(HEAD_CELL), "water");
    // The water flows from the head cell to the feet and into the glass pocket over server ticks (5 a step), then the body settles in it (or floats against the roof) by the client's physics: both are over before the dig reads its inputs.
    await afterServerTicks(subject, WATER_FLOW_TICKS, "the water flowing to the feet");
    await afterClientTicks(subject, BODY_SETTLE_CLIENT_TICKS, "the body in the water");
    const wetMs = await digAndCheck(subject, WET_TARGET, "eye in water");
    assert.ok(wetMs >= EYE_IN_WATER_FACTOR * dryMs, `eye-in-water dig time ${wetMs} ms, under ${EYE_IN_WATER_FACTOR}x the dry ${dryMs} ms`);
  },
};

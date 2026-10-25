/**
 * Flowing lava with an open cell under it pours down and does not spread sideways (Mine Labs 1.21.4, 2026-10-24; the
 * route planner reads `lavaSpreadsFrom` by it). A lava source on a floor fills the cell beside it with a flowing level 2;
 * that cell, when a floor lies under it, fills its own open neighbour with a flowing level 4; when air lies under it, it
 * pours into the air (a falling column, level 8) and the open neighbour beside it stays empty. Each step takes 30 ticks: the
 * level 2 cell was heard 1.45 to 1.50 s before the level 4 one in the control row (3 runs on the shared server, 2026-10-24).
 * Two rows of the arena run side by side from one source each: a control row with a floor under the level 2 cell, and the
 * row with the hole under it. Both are read once, after four lava steps counted in server ticks.
 */
import assert from "node:assert/strict";
import type { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";
import { afterServerTicks } from "../server-answer.ts";
import type { ContractSubject } from "../subject.ts";

/** The z of the two rows; each takes the cells z-1 to z+1. */
const CONTROL_Z = -3;
const HOLE_Z = 3;
/** The lava row, over the floor row `FLOOR_Y` (the arena floor `-61` is under the hole). */
const LAVA_Y = -59;
const FLOOR_Y = -60;
/** Along x: the source, the cell it fills (level 2), the open cell beside that one, and the wall behind each end. */
const SOURCE_X = 3;
const FLOWING_X = 4;
const OPEN_X = 5;

/** The lava row's flowing cell reaches level 2 beside a source and 4 beside that, in the overworld. */
const FLOWING_LEVEL = 2;
const FILLED_LEVEL = 4;
const FALLING_LEVEL = 8;
/** Ticks of one lava step in the overworld. */
const LAVA_STEP_TICKS = 30;
/**
 * Lava steps the rows are read after: in the hole row the level 2 cell appears at 30 ticks and pours into the hole at 60; the
 * two steps after that are the ones in which it would have filled its open neighbour (the scene of obsidian-lava-approach). The
 * control row fills its open cell at 60.
 */
const LAVA_STEPS = 4;

type Cell = readonly [number, number, number];

/** The stone around a row: floors under the source and the open cell, walls on every side but the open cell's, and under the flowing cell either a floor (the control) or air (the hole). */
function rowCells(z: number, floorUnderFlowing: boolean): Record<string, "stone"> {
  const stone: Cell[] = [
    [SOURCE_X, FLOOR_Y, z],
    [OPEN_X, FLOOR_Y, z],
    [FLOWING_X, FLOOR_Y, z - 1],
    [FLOWING_X, FLOOR_Y, z + 1],
    [SOURCE_X - 1, LAVA_Y, z],
    [OPEN_X + 1, LAVA_Y, z],
    ...[SOURCE_X, FLOWING_X, OPEN_X].flatMap((x): Cell[] => [[x, LAVA_Y, z - 1], [x, LAVA_Y, z + 1]]),
    ...(floorUnderFlowing ? ([[FLOWING_X, FLOOR_Y, z]] as Cell[]) : []),
  ];
  return Object.fromEntries(stone.map((cell) => [cell.join(","), "stone" as const]));
}

const lavaLevelAt = (subject: ContractSubject, cell: Vec3): number | null => {
  const block = subject.bot.blockAt(cell);
  return block?.name === "lava" ? Number(block.getProperties().level) : null;
};

/** The cells of the row at `z`. */
function rowAt(subject: ContractSubject, z: number) {
  const world = (x: number, y: number) => subject.world([x, y, z]);
  return { source: world(SOURCE_X, LAVA_Y), flowing: world(FLOWING_X, LAVA_Y), open: world(OPEN_X, LAVA_Y), hole: world(FLOWING_X, FLOOR_Y) };
}

export const lavaOverHole: ContractCheck = {
  name: "lava-over-hole",
  fixture: { cells: { ...rowCells(CONTROL_Z, true), ...rowCells(HOLE_Z, false) }, carried: {}, position: [0.5, -60, 0.5] },
  async run(subject) {
    const control = rowAt(subject, CONTROL_Z);
    const hole = rowAt(subject, HOLE_Z);
    // Every block name the hole row's open cell takes, from the lava going in to the read: it must stay empty the whole time.
    const openNames: string[] = [];
    const onOpen = (_before: unknown, after: { readonly name: string } | null) => void openNames.push(after?.name ?? "null");
    const openEvent = `blockUpdate:${hole.open}` as "blockUpdate:(x, y, z)";
    subject.bot.on(openEvent, onOpen);
    try {
      await subject.setBlock(control.source, "lava");
      await subject.setBlock(hole.source, "lava");
      // Two waits, each with its own wall bound: 4 steps in one wait (139 observed ticks) leave a server at 13 ticks a second 3 s of stalls.
      for (const half of ["first", "last"]) await afterServerTicks(subject, (LAVA_STEPS / 2) * LAVA_STEP_TICKS, `${half} two lava steps`);
      assert.equal(lavaLevelAt(subject, control.flowing), FLOWING_LEVEL, "control: the cell beside the source is a flowing level 2");
      assert.equal(lavaLevelAt(subject, control.open), FILLED_LEVEL, "control: the open cell beside it, over a floor, is a flowing level 4");
      assert.equal(lavaLevelAt(subject, hole.flowing), FLOWING_LEVEL, "hole: the cell beside the source is a flowing level 2");
      assert.equal(lavaLevelAt(subject, hole.hole), FALLING_LEVEL, "hole: the lava under it is a falling column");
      assert.deepEqual(openNames, [], "hole: the open cell beside the level 2 took no block while the lava poured down");
      assert.equal(subject.bot.blockAt(hole.open)?.name, "air", "hole: the open cell beside the level 2 over the hole is still air");
    } finally {
      subject.bot.off(openEvent, onOpen);
    }
  },
};

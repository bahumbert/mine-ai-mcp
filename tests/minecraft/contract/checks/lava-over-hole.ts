/**
 * Flowing lava with an open cell under it pours down and does not spread sideways (Mine Labs 1.21.4, 2026-10-24; the
 * route planner reads `lavaSpreadsFrom` by it). A lava source on a floor fills the cell beside it with a flowing level 2;
 * that cell, when a floor lies under it, fills its own open neighbour with a flowing level 4; when air lies under it, it
 * pours into the air (a falling column, level 8) and the open neighbour beside it stays empty. Each step takes 30 ticks: the
 * level 2 cell was heard 1.45 to 1.50 s before the level 4 one in the control row (3 runs on the shared server, 2026-10-24).
 * Two rows of the arena run side by side from one source each: a control row with a floor under the level 2 cell, and the
 * row with the hole under it.
 */
import assert from "node:assert/strict";
import type { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";
import { type ContractSubject, holdsWithin } from "../subject.ts";

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
/** Longest the source takes to fill the cell beside it, and that cell its neighbour: two lava ticks of 30 on a server on time, with room for one behind. */
const FLOW_WALL_MS = 10_000;
/** The step of the wait that gives the hole row twice the time the control row took. */
const SETTLE_STEP_MS = 100;
/** A row watched for this long even when the control filled at once. */
const MIN_ABSENCE_MS = 1_000;

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

/** What the client heard of the cells of one row. */
interface RowHeard {
  /** When (`subject.now()`) the flowing cell first read lava; null while it has not. */
  flowingAtMs: number | null;
  /** When the cell under the flowing one first read lava; null while it has not. */
  holeAtMs: number | null;
  /** When the open cell first read lava; null while it has not. */
  openAtMs: number | null;
  /** Every block name the open cell took. */
  readonly openNames: string[];
}

interface Row {
  readonly source: Vec3;
  readonly flowing: Vec3;
  readonly open: Vec3;
  readonly hole: Vec3;
  readonly heard: RowHeard;
}

const lavaLevelAt = (subject: ContractSubject, cell: Vec3): number | null => {
  const block = subject.bot.blockAt(cell);
  return block?.name === "lava" ? Number(block.getProperties().level) : null;
};

/** Listen to the flowing and open cells of `row` until the returned function is called. */
function watchRow(subject: ContractSubject, z: number): { row: Row; stop: () => void } {
  const world = (x: number, y: number) => subject.world([x, y, z]);
  const row: Row = {
    source: world(SOURCE_X, LAVA_Y),
    flowing: world(FLOWING_X, LAVA_Y),
    open: world(OPEN_X, LAVA_Y),
    hole: world(FLOWING_X, FLOOR_Y),
    heard: { flowingAtMs: null, holeAtMs: null, openAtMs: null, openNames: [] },
  };
  const onFlowing = (_before: unknown, after: { readonly name: string } | null) => {
    if (after?.name === "lava" && row.heard.flowingAtMs === null) row.heard.flowingAtMs = subject.now();
  };
  const onHole = (_before: unknown, after: { readonly name: string } | null) => {
    if (after?.name === "lava" && row.heard.holeAtMs === null) row.heard.holeAtMs = subject.now();
  };
  const onOpen = (_before: unknown, after: { readonly name: string } | null) => {
    row.heard.openNames.push(after?.name ?? "null");
    if (after?.name === "lava" && row.heard.openAtMs === null) row.heard.openAtMs = subject.now();
  };
  const flowingEvent = `blockUpdate:${row.flowing}` as "blockUpdate:(x, y, z)";
  const holeEvent = `blockUpdate:${row.hole}` as "blockUpdate:(x, y, z)";
  const openEvent = `blockUpdate:${row.open}` as "blockUpdate:(x, y, z)";
  subject.bot.on(flowingEvent, onFlowing);
  subject.bot.on(holeEvent, onHole);
  subject.bot.on(openEvent, onOpen);
  return {
    row,
    stop: () => {
      subject.bot.off(flowingEvent, onFlowing);
      subject.bot.off(holeEvent, onHole);
      subject.bot.off(openEvent, onOpen);
    },
  };
}

export const lavaOverHole: ContractCheck = {
  name: "lava-over-hole",
  fixture: { cells: { ...rowCells(CONTROL_Z, true), ...rowCells(HOLE_Z, false) }, carried: {}, position: [0.5, -60, 0.5] },
  async run(subject) {
    const control = watchRow(subject, CONTROL_Z);
    const hole = watchRow(subject, HOLE_Z);
    try {
      await subject.setBlock(control.row.source, "lava");
      await subject.setBlock(hole.row.source, "lava");
      const filled = await holdsWithin(subject, () => control.row.heard.openAtMs !== null && hole.row.heard.flowingAtMs !== null, FLOW_WALL_MS);
      assert.ok(filled, `the control row filled its open cell (${control.row.heard.openAtMs}) and the hole row its flowing cell (${hole.row.heard.flowingAtMs}) within ${FLOW_WALL_MS} ms`);
      assert.equal(lavaLevelAt(subject, control.row.flowing), FLOWING_LEVEL, "control: the cell beside the source is a flowing level 2");
      assert.equal(lavaLevelAt(subject, control.row.open), FILLED_LEVEL, "control: the open cell beside it, over a floor, is a flowing level 4");
      // The control showed how long the lava takes from one cell to the next. The hole row is read once twice that has passed since lava stood
      // under its level 2 cell: the level 2 over the falling column then had its next flow step too, the scene of obsidian-lava-approach.
      const poured = await holdsWithin(subject, () => hole.row.heard.holeAtMs !== null, FLOW_WALL_MS);
      assert.ok(poured, "hole: the lava poured into the air under the level 2 cell");
      const flowMs = control.row.heard.openAtMs! - control.row.heard.flowingAtMs!;
      const watchedUntilMs = hole.row.heard.holeAtMs! + Math.max(2 * flowMs, MIN_ABSENCE_MS);
      while (subject.now() < watchedUntilMs) await subject.wait(SETTLE_STEP_MS);
      assert.equal(lavaLevelAt(subject, hole.row.flowing), FLOWING_LEVEL, "hole: the cell beside the source is a flowing level 2");
      assert.equal(lavaLevelAt(subject, hole.row.hole), FALLING_LEVEL, "hole: the lava under it is a falling column");
      assert.deepEqual(hole.row.heard.openNames, [], "hole: the open cell beside the level 2 took no block while the lava poured down");
      assert.equal(subject.bot.blockAt(hole.row.open)?.name, "air", "hole: the open cell beside the level 2 over the hole is still air");
    } finally {
      control.stop();
      hole.stop();
    }
  },
};

/**
 * What lava at head height beside the body does when an open cell lies under that lava (plan 2026-11-07-p4-06b-fire-lava T3a;
 * the route planner's head-row exemption in `lavaSpreadsIntoBody` reads it). The body's column is a floor cell with an open feet
 * cell and an open head cell over it; beside the head cell stands lava of level 0, 2, 4 or 6, with an air cell under that lava (the
 * cell beside the feet) and stone under that. One row of the arena per level; a level above 0 is a stream along x on stone floors
 * from a source, so its last cell, the one beside the head, is fed and keeps its level.
 *
 * Measured on the shared server (Mine Labs 1.21.4, Overworld, 2026-11-08, one polling run: first tick each cell changed, from the
 * sources being set at ticks 6 to 9; lava steps are 30 ticks): the lava beside the head always pours down, and the falling column
 * (level 8) fills the open feet cell with a flowing level 2 one step later (level 2: beside head at 36, beside feet 66, feet 96;
 * level 4: 67, 97, 127; level 6: 98, 128, 158), so lava reaches the body's feet cell whatever the level. The head cell stays air
 * for a flowing level (2, 4, 6) over the whole window; only a **source** also spreads sideways into the head cell (level 0: column
 * at 34, head level 2 and feet level 2 at 64, the head's own column makes the feet cell level 8 at 94).
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { afterServerTicks, answerArrives } from "../server-answer.ts";
import type { ContractSubject } from "../subject.ts";

/** Rows run along x at these z, each takes the cells z-1 to z+1. */
const ROW_ZS = [-5, -2, 1, 4] as const;
/** Lava levels, one per row: the source (0) and the streams that end beside the head cell at level 2, 4 and 6. */
const LEVELS = [0, 2, 4, 6] as const;
const FLOOR_Y = -60;
const FEET_Y = -59;
const HEAD_Y = -58;
/** The body column's x; the cell beside it (x + 1) is where the lava stands at head height with air under it. */
const BODY_X = -2;
const BESIDE_X = BODY_X + 1;
/** Ticks of one lava step in the overworld (`lava-over-hole.ts`). */
const LAVA_STEP_TICKS = 30;
/** Lava steps the rows are read after, counted from the last row's lava standing beside its head cell: the slowest row (level 6) has its feet cell filled 60 ticks after that, the source row its head and feet cells within 90 ticks of being set. */
const LAVA_STEPS = 4;

type Cell = readonly [number, number, number];

/** The x of the lava source of the row that ends in `level` beside the head: each cell further along is two levels lower. */
const sourceX = (level: number) => BESIDE_X + level / 2;

/** The stone around one row: floors under the body and the cell beside it, floors under the stream, walls round the open cells. */
function rowStone(z: number, level: number): Cell[] {
  const lastX = sourceX(level) + 1;
  const xs = Array.from({ length: lastX - BODY_X + 2 }, (_, index) => BODY_X - 1 + index);
  return [
    [BODY_X, FLOOR_Y, z],
    [BESIDE_X, FLOOR_Y, z],
    [BODY_X - 1, FEET_Y, z],
    [BODY_X - 1, HEAD_Y, z],
    [lastX, FEET_Y, z],
    [lastX, HEAD_Y, z],
    ...xs.filter((x) => x > BESIDE_X).map((x): Cell => [x, FEET_Y, z]),
    ...xs.flatMap((x): Cell[] => [FEET_Y, HEAD_Y].flatMap((y): Cell[] => [[x, y, z - 1], [x, y, z + 1]])),
  ];
}

const FIXTURE_CELLS = Object.fromEntries(ROW_ZS.flatMap((z, index) => rowStone(z, LEVELS[index]!).map((cell) => [cell.join(","), "stone" as const])));

/** The cells of one row, read as `name` or `name[level]`. */
function readRow(subject: ContractSubject, z: number) {
  const read = (x: number, y: number) => {
    const block = subject.bot.blockAt(subject.world([x, y, z]));
    if (block === null) return "unloaded";
    const level = block.getProperties().level;
    return level === undefined ? block.name : `${block.name}[${String(level)}]`;
  };
  return { head: read(BODY_X, HEAD_Y), feet: read(BODY_X, FEET_Y), besideHead: read(BESIDE_X, HEAD_Y), besideFeet: read(BESIDE_X, FEET_Y) };
}

/** What each row holds once the lava has flowed, by level: the head cell takes lava only from a source. */
const EXPECTED_AFTER_STEPS = (level: number) =>
  level === 0
    ? { head: "lava[2]", feet: "lava[8]", besideHead: "lava[0]", besideFeet: "lava[8]" }
    : { head: "air", feet: "lava[2]", besideHead: `lava[${level}]`, besideFeet: "lava[8]" };

export const lavaBesideHead: ContractCheck = {
  name: "lava-beside-head",
  fixture: { cells: FIXTURE_CELLS, carried: {}, position: [5.5, FLOOR_Y, 5.5] },
  async run(subject) {
    // Every block name each row's head cell takes from the lava going in to the last read: a flowing level must leave it air the whole time.
    const headNames = ROW_ZS.map((): string[] => []);
    const listeners = ROW_ZS.map((z, index) => {
      const onHead = (_before: unknown, after: { readonly name: string } | null) => void headNames[index]!.push(after?.name ?? "null");
      const event = `blockUpdate:${subject.world([BODY_X, HEAD_Y, z])}` as "blockUpdate:(x, y, z)";
      subject.bot.on(event, onHead);
      return { event, onHead };
    });
    try {
      for (const [index, z] of ROW_ZS.entries()) await subject.setBlock(subject.world([sourceX(LEVELS[index]!), HEAD_Y, z]), "lava");
      // The lava beside each head cell stands at its level (the stream takes 30 ticks a cell): the clock of the steps starts when the last one does.
      for (const [index, z] of ROW_ZS.entries())
        await answerArrives(subject, () => readRow(subject, z).besideHead === `lava[${LEVELS[index]}]`, `level ${LEVELS[index]}: the lava beside the head cell stands`, () => JSON.stringify(readRow(subject, z)));
      await afterServerTicks(subject, LAVA_STEPS * LAVA_STEP_TICKS, `${LAVA_STEPS} lava steps`);
      const read = ROW_ZS.map((z) => readRow(subject, z));
      for (const [index, level] of LEVELS.entries())
        assert.deepEqual(read[index], EXPECTED_AFTER_STEPS(level), `level ${level}: head, feet, beside head and beside feet after ${LAVA_STEPS} lava steps`);
      for (const [index, level] of LEVELS.entries()) {
        const expected = level === 0 ? ["lava"] : [];
        assert.deepEqual(headNames[index], expected, `level ${level}: the head cell took ${level === 0 ? "lava from the source beside it" : "no block while the lava beside it poured down"}`);
      }
      // Settled: two more steps change nothing.
      await afterServerTicks(subject, 2 * LAVA_STEP_TICKS, "two more lava steps");
      assert.deepEqual(ROW_ZS.map((z) => readRow(subject, z)), read, "the rows are settled: two more lava steps changed nothing");
    } finally {
      for (const { event, onHead } of listeners) subject.bot.off(event, onHead);
    }
  },
};

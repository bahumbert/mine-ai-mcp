/**
 * The light the server sends for a cell, and what `bot.blockAt(cell).skyLight` / `.light` hold of it. Shapes: open air under a noon sky, the inside
 * of a closed stone box, the cells along a torch's row inside a second closed box, the cells just above each roof, and one cell far above the arena.
 *
 * Measured on the real 1.21.4 server through Mine Labs, 2026-11-07 (plan 2026-11-07-p4-03-condition-line, task 1), on the shared scenario server and on a
 * server of its own (the same values). The check asserts the sent values; the packet counts, the predicate probe, the chunk re-send and the permuted row below were read in
 * diagnostic runs of this check's first versions (a runtime torch in open air at local (0, -60, 4), a probe `execute positioned .. if predicate`, a teleport 600 blocks away and back), not kept in it:
 * - The server's light is the game's: open air 15 sky and 0 block; the closed box 0 and 0; the torch cell 14 block light (the torch's `emitLight`), the
 *   cells at distance 1, 2, 3 along its row 13, 12, 11 (`emitLight` minus the distance), 0 sky light inside the closed box; the cells just above a roof 15 sky.
 *   The server's own `execute if predicate {light}` agrees (closed box dark, row end >= 11).
 * - The light arrives in the chunk packet (`map_chunk`: `skyLight` and `blockLight` byte arrays, 2048 bytes a 16 x 16 x 16 section, two cells a byte, the
 *   low nibble first) and no `update_light` packet came in 300 server ticks after a runtime `setblock` (0 packets, with `update_time` and `block_change` arriving).
 *   A chunk sent again (the bot away 600 blocks and back) carries the light of the edited world.
 * - The column holds light sections 0..2 only (y -80..-33) of the 26 the dimension has: a cell in a section the server sent none for (the high cell,
 *   y -13) has no light data on the client; the true value there is open sky, which the client does not hold. Prismarine's `getSkyLight` answers 0 for it.
 * - `bot.blockAt(cell).skyLight` and `.light` do NOT hold what the server sent: prismarine-chunk 1.41.0 `loadParsedLight` fills the section's `BitArray`
 *   with `readBuffer`, which reads the 8-byte groups of the byte array as big-endian longs (the layout of palette data), so within each row of 16 cells along x the
 *   nibbles come out permuted (the closed box read 15 and the torch cell 0; a runtime torch's row, 2 to 7 cells from it, read 2, 1, 4, 3, 6, 5 where the server sent 12, 11, 10, ...). Rows
 *   that are one value all along (open air, solid rock) read right. The bytes the server sent are recoverable from the stored words (`sentLight` below).
 *   The check asserts what the server sent and writes what `blockAt` held in its note.
 * The shared fake answers none of this yet (`waitsForFake`). The measurement is kept in `.agent/knowledge/facts/runtime-pitfalls.md`, section "Light and armour points the client holds", the light bullet.
 */
import assert from "node:assert/strict";
import type { FakeCell } from "../../../../src/test-support/fake-bot/index.ts";
import type { ContractCheck } from "../checks.ts";
import { answerArrives } from "../server-answer.ts";
import type { ContractBot, LocalPoint } from "../subject.ts";
import type { Vec3 } from "vec3";

/** The block whose light the check follows along the row; its `emitLight` is read from the registry, never typed. */
const LIGHT_SOURCE = "torch";
const WALL = "stone";
/** The arena's floor is stone at this y; the boxes stand on it (a `setblock` of stone on stone is refused by the server): walls and roof only. */
const FEET_Y = -60;
const ROOF_Y = FEET_Y + 1;
/** Box A: a 3 x 3 x 3 stone cube (floor included) around one air cell. */
const CLOSED_CELL: LocalPoint = [-3, FEET_Y, 0];
/** Box B: a 6 x 3 x 3 cube whose inside is the row x 2..5, the torch at its west end. */
const ROW_FROM_X = 2;
const ROW_TO_X = 5;
const TORCH_CELL: LocalPoint = [ROW_FROM_X, FEET_Y, 0];
const ROW_DISTANCES = [1, 2, 3] as const;
/** Far above the arena's air (48 blocks over the floor): in a section the server sent no light for. */
const HIGH_CELL: LocalPoint = [0, -13, 0];
const OPEN_CELL: LocalPoint = [0, FEET_Y, 0];
const DARK = 0;
const FULL_SKY = 15;

const key = ([x, y, z]: LocalPoint) => `${x},${y},${z}`;

/** Every cell of the box `from`..`to` except the ones `inside` names, stone. */
function boxCells(from: LocalPoint, to: LocalPoint, inside: (cell: LocalPoint) => boolean): Record<string, FakeCell> {
  const cells: Record<string, FakeCell> = {};
  for (let x = from[0]; x <= to[0]; x += 1) {
    for (let y = from[1]; y <= to[1]; y += 1) {
      for (let z = from[2]; z <= to[2]; z += 1) if (!inside([x, y, z])) cells[key([x, y, z])] = WALL;
    }
  }
  return cells;
}

const closedBox = boxCells([CLOSED_CELL[0] - 1, FEET_Y, -1], [CLOSED_CELL[0] + 1, ROOF_Y, 1], (cell) => key(cell) === key(CLOSED_CELL));
const torchBox = boxCells([ROW_FROM_X - 1, FEET_Y, -1], [ROW_TO_X + 1, ROOF_Y, 1], ([x, y, z]) => y === FEET_Y && z === 0 && x >= ROW_FROM_X && x <= ROW_TO_X);

type LightLayer = "skyLight" | "blockLight";

interface StoredSection {
  readonly data: Uint32Array;
}

/** The chunk column's light sections as prismarine-chunk 1.18 keeps them (`ChunkColumn.js`), `null` where the server sent none. */
type LightColumn = Record<`${LightLayer}Sections`, readonly (StoredSection | null)[]>;

/**
 * The light the server sent for the cell, or null when it sent no section: the bytes of the packet are put back from the words `BitArray.readBuffer` stored
 * (each pair of 32-bit words is one big-endian long, second word read first), then read as the game writes them: cell `(y & 15) << 8 | (z & 15) << 4 | (x & 15)`, two to a byte, low nibble first.
 */
export function sentLight(bot: ContractBot, layer: LightLayer, cell: Vec3): number | null {
  const column = bot.world.getColumnAt(cell) as unknown as LightColumn | null | undefined;
  if (!column) return null;
  const { minY } = bot.game as unknown as { minY: number };
  const section = column[`${layer}Sections`][Math.floor((cell.y - minY) / 16) + 1];
  if (!section) return null;
  const bytes = new DataView(new ArrayBuffer(section.data.length * 4));
  for (let word = 0; word < section.data.length; word += 2) {
    bytes.setUint32(word * 4, section.data[word + 1]!);
    bytes.setUint32(word * 4 + 4, section.data[word]!);
  }
  const index = (((cell.y - minY) & 15) << 8) | ((Math.floor(cell.z) & 15) << 4) | (Math.floor(cell.x) & 15);
  const byte = bytes.getUint8(index >> 1);
  return index & 1 ? byte >> 4 : byte & 15;
}

interface Reading {
  readonly sky: number | null;
  readonly block: number | null;
}

export const lightInCells: ContractCheck = {
  name: "light-in-cells",
  fixture: { cells: { ...closedBox, ...torchBox, [key(TORCH_CELL)]: LIGHT_SOURCE }, carried: {}, position: [0.5, FEET_Y, 0.5] },
  // The shared fake's blocks and columns carry no light yet, and the client's own `blockAt` light is not what the server sent (header): the fake is taught once the master has chosen how the light is read.
  waitsForFake: "the fake holds no light: task 1 of plan 2026-11-07-p4-03-condition-line stopped for the master's choice of how the light is read (its report)",
  async run(subject) {
    const { bot } = subject;
    const emitted = bot.registry.blocksByName[LIGHT_SOURCE]!.emitLight;
    const sent = (cell: LocalPoint): Reading => {
      const world = subject.world(cell);
      return { sky: sentLight(bot, "skyLight", world), block: sentLight(bot, "blockLight", world) };
    };
    const held = (cell: LocalPoint) => {
      const block = bot.blockAt(subject.world(cell));
      return { sky: block?.skyLight, block: block?.light };
    };
    const rowCell = (distance: number): LocalPoint => [ROW_FROM_X + distance, FEET_Y, 0];
    const farthest = rowCell(ROW_DISTANCES[ROW_DISTANCES.length - 1]!);
    // The light packets come after the block changes: the farthest cell of the torch's row holds its light once the lighting reached it.
    await answerArrives(subject, () => sent(farthest).block === emitted - ROW_DISTANCES.length, "the torch's light never reached the row's far end", () => JSON.stringify(sent(farthest)));
    const aboveClosedRoof: LocalPoint = [CLOSED_CELL[0], ROOF_Y + 1, 0];
    const aboveTorchRoof: LocalPoint = [rowCell(1)[0], ROOF_Y + 1, 0];
    assert.deepEqual(sent(OPEN_CELL), { sky: FULL_SKY, block: DARK }, "open air under a noon sky");
    assert.deepEqual(sent(CLOSED_CELL), { sky: DARK, block: DARK }, "the inside of a closed box");
    assert.deepEqual(sent(TORCH_CELL), { sky: DARK, block: emitted }, "the torch's own cell, in a closed box");
    for (const distance of ROW_DISTANCES) assert.deepEqual(sent(rowCell(distance)), { sky: DARK, block: emitted - distance }, `${distance} cell(s) from the torch`);
    assert.deepEqual(sent(aboveClosedRoof), { sky: FULL_SKY, block: DARK }, "just above the closed box's roof");
    assert.deepEqual(sent(aboveTorchRoof), { sky: FULL_SKY, block: DARK }, "just above the torch box's roof");
    assert.deepEqual(sent(HIGH_CELL), { sky: null, block: null }, "a cell in a section the server sent no light for");
    const cells: [string, LocalPoint][] = [["open", OPEN_CELL], ["closed", CLOSED_CELL], ["torch", TORCH_CELL], ...ROW_DISTANCES.map((d): [string, LocalPoint] => [`row ${d}`, rowCell(d)]), ["above roofs", aboveClosedRoof], ["high", HIGH_CELL]];
    return `sent (sky/block): ${cells.map(([label, cell]) => `${label} ${sent(cell).sky}/${sent(cell).block}`).join(", ")}; bot.blockAt held: ${cells.map(([label, cell]) => `${label} ${held(cell).sky}/${held(cell).block}`).join(", ")}; emitLight ${emitted}`;
  },
};

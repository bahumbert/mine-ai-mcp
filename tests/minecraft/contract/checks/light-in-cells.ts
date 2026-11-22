/**
 * The light the server sends for a cell, and what `bot.blockAt(cell).skyLight` / `.light` hold of it. Shapes: open air under a noon sky, the inside
 * of a closed stone box, the cells along a torch's row inside a second closed box, the cells just above each roof, and one cell far above the arena.
 *
 * Measured on the real 1.21.4 server through Mine Labs, 2026-11-07 (plan 2026-11-07-p4-03-condition-line, task 1), on the shared scenario server and on a
 * server of its own (the same values). The check asserts the values `bot.blockAt` holds on both targets, and the packet's own values where the client holds the packet's sections (a real server only); the packet counts, the predicate probe, the chunk re-send and the permuted row below were read in
 * diagnostic runs of this check's first versions (a runtime torch in open air at local (0, -60, 4), a probe `execute positioned .. if predicate`, a teleport 600 blocks away and back), not kept in it:
 * - The server's light is the game's: open air 15 sky and 0 block; the closed box 0 and 0; the torch cell 14 block light (the torch's `emitLight`), the
 *   cells at distance 1, 2, 3 along its row 13, 12, 11 (`emitLight` minus the distance), 0 sky light inside the closed box; the cells just above a roof 15 sky.
 *   The server's own `execute if predicate {light}` agrees (closed box dark, row end >= 11).
 * - The light arrives in the chunk packet (`map_chunk`: `skyLight` and `blockLight` byte arrays, 2048 bytes a 16 x 16 x 16 section, two cells a byte, the
 *   low nibble first) and no `update_light` packet came in 300 server ticks after a runtime `setblock` (0 packets, with `update_time` and `block_change` arriving).
 *   A chunk sent again (the bot away 600 blocks and back) carries the light of the edited world.
 * - The column holds light sections 0..2 only (y -80..-33) of the 26 the dimension has: a cell in a section the server sent none for (the high cell,
 *   y -13) has no light data on the client; the true value there is open sky, which the client does not hold. Prismarine's `getSkyLight` answers 0 for it.
 * - Without the patch `bot.blockAt(cell).skyLight` and `.light` did NOT hold what the server sent: prismarine-chunk 1.41.0 `loadParsedLight` filled the section's `BitArray`
 *   with `readBuffer`, which reads the 8-byte groups of the byte array as big-endian longs (the layout of palette data), so within each row of 16 cells along x the
 *   nibbles came out permuted (the closed box read 15 and the torch cell 0; a runtime torch's row, 2 to 7 cells from it, read 2, 1, 4, 3, 6, 5 where the server sent 12, 11, 10, ...). Rows
 *   that are one value all along (open air, solid rock) read right.
 * - 2026-11-08 (plan 2026-11-07-p4-03-condition-line, task 1L): the bun patch `patches/prismarine-chunk@1.41.0.patch` reads the light bytes as little-endian words in order; this check,
 *   red before it (the closed cell read sky 15, the server sent 0), asserts that `bot.blockAt` holds what the server sent on every sampled cell, and is the patch's guard. `sentLight`
 *   decodes the stored words (little-endian, in order) and the absolute values above (open 15/0, closed 0/0, torch 14, row 13/12/11) are the server's truth. Held with the patch, 3 of 3
 *   and the whole contract set 70 of 70 on a server of its own: open 15/0, closed 0/0, torch 0/14, row 1-3 0/13, 0/12, 0/11, above roofs 15/0, and the high cell 0/0 (no section: `getSkyLight` answers 0; the packet decode says null). The shared fake answers
 *   the cells above (`fake-world-light.ts`) and undefined for the high cell, which `lightAt` (task 2) reads as no data, as it reads the real client's section-less 0/0 through the column.
 * The measurement is kept in `.agent/knowledge/facts/runtime-pitfalls.md`, section "Light and armour points the client holds", the light bullet.
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
 * The light the server sent for the cell, or null when it sent no section: the bytes of the packet are put back from the stored words (with the patch the stored
 * 32-bit words are the packet's bytes read little-endian, in order), then read as the game writes them: cell `(y & 15) << 8 | (z & 15) << 4 | (x & 15)`, two to a byte, low nibble first.
 */
export function sentLight(bot: ContractBot, layer: LightLayer, cell: Vec3): number | null {
  const column = bot.world.getColumnAt(cell) as unknown as LightColumn | null | undefined;
  if (!column) return null;
  const { minY } = bot.game as unknown as { minY: number };
  const section = column[`${layer}Sections`][Math.floor((cell.y - minY) / 16) + 1];
  if (!section) return null;
  const bytes = new DataView(new ArrayBuffer(section.data.length * 4));
  for (let word = 0; word < section.data.length; word += 1) bytes.setUint32(word * 4, section.data[word]!, true);
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
    // `bot.blockAt` is the client's reading, which the shared fake answers too; the packet's own sections exist only on a real server (the fake's columns hold none).
    await answerArrives(subject, () => held(farthest).block === emitted - ROW_DISTANCES.length, "the torch's light never reached the row's far end", () => JSON.stringify(held(farthest)));
    const aboveClosedRoof: LocalPoint = [CLOSED_CELL[0], ROOF_Y + 1, 0];
    const aboveTorchRoof: LocalPoint = [rowCell(1)[0], ROOF_Y + 1, 0];
    const expected: [string, LocalPoint, Reading][] = [
      ["open air under a noon sky", OPEN_CELL, { sky: FULL_SKY, block: DARK }],
      ["the inside of a closed box", CLOSED_CELL, { sky: DARK, block: DARK }],
      ["the torch's own cell, in a closed box", TORCH_CELL, { sky: DARK, block: emitted }],
      ...ROW_DISTANCES.map((distance): [string, LocalPoint, Reading] => [`${distance} cell(s) from the torch`, rowCell(distance), { sky: DARK, block: emitted - distance }]),
      ["just above the closed box's roof", aboveClosedRoof, { sky: FULL_SKY, block: DARK }],
      ["just above the torch box's roof", aboveTorchRoof, { sky: FULL_SKY, block: DARK }],
    ];
    // The guard of the prismarine-chunk light patch (patches/prismarine-chunk@*.patch): what `bot.blockAt` holds is what the server sent (open 15/0, closed 0/0, torch 14, row 13/12/11).
    for (const [label, cell, reading] of expected) assert.deepEqual(held(cell), reading, `bot.blockAt light: ${label}`);
    const packetSections = sent(OPEN_CELL).sky !== null;
    if (packetSections) {
      for (const [label, cell, reading] of expected) assert.deepEqual(sent(cell), reading, `the light the server sent: ${label}`);
      assert.deepEqual(sent(HIGH_CELL), { sky: null, block: null }, "a cell in a section the server sent no light for");
    }
    const cells: [string, LocalPoint][] = [["open", OPEN_CELL], ["closed", CLOSED_CELL], ["torch", TORCH_CELL], ...ROW_DISTANCES.map((d): [string, LocalPoint] => [`row ${d}`, rowCell(d)]), ["above roofs", aboveClosedRoof], ["high", HIGH_CELL]];
    return `sent (sky/block): ${cells.map(([label, cell]) => `${label} ${sent(cell).sky}/${sent(cell).block}`).join(", ")}; bot.blockAt held: ${cells.map(([label, cell]) => `${label} ${held(cell).sky}/${held(cell).block}`).join(", ")}; emitLight ${emitted}`;
  },
};

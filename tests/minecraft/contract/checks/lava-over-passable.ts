/**
 * What lava does over a block it cannot pour into (T7e5a, Mine Labs 1.21.4): sugar cane on dirt with water beside it, a
 * nether portal in its obsidian frame, a structure void, and air as the control. Each block has a lava source in the cell
 * above it (for the portal, the frame's top block, which the lava replaces), every side of that cell and of the block walled
 * in stone, so the only way for the lava to move is down.
 * The route planner's `lavaSpreadsFrom` reads the cell under a flowing lava as open or as a floor; this check names what
 * the server makes of each of these blocks. A lava step takes 30 ticks (`lava-over-hole.ts`), so the cells are read after
 * two steps.
 *
 * Measured on the shared server, 2026-10-24 (4 probe runs and 3 asserting runs): lava over sugar cane and over a structure void does not pour into
 * them (they stay, the lava stays a source); lava over air pours down as a falling column (level 8). A standing portal
 * has its frame's top block over it, so there is no lava over a portal block: lava placed in that frame block breaks the
 * portal at once and then pours down through its blocks.
 */
import assert from "node:assert/strict";
import type { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";
import { afterServerTicks, serverQuiet } from "../server-answer.ts";
import type { ContractSubject, LocalPoint } from "../subject.ts";

/** Ticks of one lava step in the overworld; the cells are read after two (`lava-over-hole.ts`). */
const LAVA_STEP_TICKS = 30;
/** The lava pours down from the cell above each block. */
const FLOOR_Y = -60;

/** One block under test: its cell, the name it must read before the lava goes in, and the cell the lava source takes. */
interface Case {
  readonly label: string;
  readonly block: LocalPoint;
  readonly present: string;
  readonly lava: LocalPoint;
}

const CONTROL_AIR: Case = { label: "air", block: [-4, FLOOR_Y, -4], present: "air", lava: [-4, FLOOR_Y + 1, -4] };
const STRUCTURE_VOID: Case = { label: "structure void", block: [-4, FLOOR_Y, 4], present: "structure_void", lava: [-4, FLOOR_Y + 1, 4] };
/** The cane stands on dirt at the floor with water in the dirt's row beside it, so it survives; the lava is two above the dirt. */
const SUGAR_CANE: Case = { label: "sugar cane", block: [4, FLOOR_Y + 1, -4], present: "sugar_cane", lava: [4, FLOOR_Y + 2, -4] };
const SUGAR_CANE_DIRT: LocalPoint = [4, FLOOR_Y, -4];
const SUGAR_CANE_WATER: LocalPoint = [5, FLOOR_Y, -4];
/** The portal is two cells wide and three high in the plane z = 4; the lava replaces the frame's top block above the left column's top portal block. */
const PORTAL_Z = 4;
const PORTAL_LEFT_X = 2;
const PORTAL_COLUMNS = [PORTAL_LEFT_X, PORTAL_LEFT_X + 1] as const;
const PORTAL_ROWS = [FLOOR_Y, FLOOR_Y + 1, FLOOR_Y + 2] as const;
const PORTAL_BLOCKS: readonly LocalPoint[] = PORTAL_COLUMNS.flatMap((x) => PORTAL_ROWS.map((y): LocalPoint => [x, y, PORTAL_Z]));
const NETHER_PORTAL: Case = { label: "nether portal", block: [PORTAL_LEFT_X, FLOOR_Y + 2, PORTAL_Z], present: "nether_portal", lava: [PORTAL_LEFT_X, FLOOR_Y + 3, PORTAL_Z] };
const CASES: readonly Case[] = [CONTROL_AIR, SUGAR_CANE, NETHER_PORTAL, STRUCTURE_VOID];

type Cells = Record<string, string | { readonly name: string; readonly properties: Record<string, string> }>;
const key = ([x, y, z]: LocalPoint) => `${x},${y},${z}`;
const stoneAround = ([x, y, z]: LocalPoint): LocalPoint[] => [[x - 1, y, z], [x + 1, y, z], [x, y, z - 1], [x, y, z + 1]];

/** The cells of the arena: stone walls first, then the blocks, so nothing stands before the wall around it. */
function arenaCells(): Cells {
  const cells: Cells = {};
  const place = (points: readonly LocalPoint[], block: Cells[string]) => points.forEach((point) => void (cells[key(point)] = block));
  // The walls: the block's own cell and the lava's cell on every side; sugar cane's dirt row is left open except around the water.
  for (const { block, lava } of [CONTROL_AIR, STRUCTURE_VOID, SUGAR_CANE]) place([...stoneAround(block), ...stoneAround(lava)], "stone");
  place([[6, FLOOR_Y, -4], [5, FLOOR_Y, -5], [5, FLOOR_Y, -3]], "stone");
  place(stoneAround(NETHER_PORTAL.lava).filter(([x]) => x !== PORTAL_LEFT_X + 1), "stone");
  // The portal's two sides along z are walled over its rows, so lava poured down through a broken portal cannot spread out of the arena.
  place(PORTAL_COLUMNS.flatMap((x) => PORTAL_ROWS.flatMap((y): LocalPoint[] => [[x, y, PORTAL_Z - 1], [x, y, PORTAL_Z + 1]])), "stone");
  // The portal's frame: a floor of obsidian under the two columns, a column each side, a top the lava replaces on the left.
  place([...PORTAL_COLUMNS.map((x): LocalPoint => [x, FLOOR_Y - 1, PORTAL_Z]), ...PORTAL_COLUMNS.map((x): LocalPoint => [x, FLOOR_Y + 3, PORTAL_Z])], "obsidian");
  place(PORTAL_ROWS.flatMap((y): LocalPoint[] => [[PORTAL_LEFT_X - 1, y, PORTAL_Z], [PORTAL_LEFT_X + 2, y, PORTAL_Z]]), "obsidian");
  place(PORTAL_BLOCKS, { name: "nether_portal", properties: { axis: "x" } });
  place([SUGAR_CANE_DIRT], "dirt");
  place([SUGAR_CANE_WATER], "water");
  place([SUGAR_CANE.block], "sugar_cane");
  place([STRUCTURE_VOID.block], "structure_void");
  return cells;
}

const describeCell = (subject: ContractSubject, local: LocalPoint): string => {
  const block = subject.bot.blockAt(subject.world(local));
  if (block === null) return "unloaded";
  const level = block.getProperties().level;
  return level === undefined ? block.name : `${block.name}[level=${level}]`;
};

/** What each case's block and its lava cell read, one line each (the portal's six blocks as their names). */
function readCases(subject: ContractSubject): string[] {
  return CASES.map(({ label, block, lava }) => {
    const portal = label === NETHER_PORTAL.label ? `, portal blocks ${PORTAL_COLUMNS.flatMap((x) => PORTAL_ROWS.map((y) => describeCell(subject, [x, y, PORTAL_Z]))).join("/")}` : "";
    return `${label}: block ${describeCell(subject, block)}, lava cell ${describeCell(subject, lava)}${portal}`;
  });
}

export const lavaOverPassable: ContractCheck = {
  name: "lava-over-passable",
  fixture: { cells: arenaCells(), carried: {}, position: [0.5, FLOOR_Y, 0.5] },
  async run(subject) {
    // Every block stands before the lava goes in, with what keeps it (the cane's dirt and water, all six portal blocks) after 21 ticks of the server.
    await serverQuiet(subject, "the blocks before the lava");
    const standing = [
      ...CASES.map(({ label, block, present }) => ({ label, cell: block, present })),
      { label: "sugar cane's dirt", cell: SUGAR_CANE_DIRT, present: "dirt" },
      { label: "sugar cane's water", cell: SUGAR_CANE_WATER, present: "water" },
      ...PORTAL_BLOCKS.map((cell) => ({ label: "nether portal block", cell, present: "nether_portal" })),
    ];
    for (const { label, cell, present } of standing) assert.equal(subject.bot.blockAt(subject.world(cell))?.name, present, `${label} ${cell}: stands before the lava goes in`);
    const lavaCells: Vec3[] = CASES.map(({ lava }) => subject.world(lava));
    for (const cell of lavaCells) await subject.setBlock(cell, "lava");
    await afterServerTicks(subject, 2 * LAVA_STEP_TICKS, "two lava steps");
    const became = readCases(subject).join("; ");
    // The control must have changed, else no flow was seen and the other cells prove nothing.
    assert.equal(describeCell(subject, CONTROL_AIR.block), "lava[level=8]", `the control air under the lava became a falling column (${became})`);
    for (const { label, lava } of CASES) assert.equal(describeCell(subject, lava), "lava[level=0]", `${label}: the lava source stayed a source (${became})`);
    assert.equal(describeCell(subject, SUGAR_CANE.block), "sugar_cane", `lava over sugar cane did not pour into it (${became})`);
    assert.equal(describeCell(subject, STRUCTURE_VOID.block), "structure_void", `lava over a structure void did not pour into it (${became})`);
    // A standing portal has its frame's top block over it, so the lava replaced that block: the portal broke and the lava poured into its top block.
    const portalNames = PORTAL_COLUMNS.flatMap((x) => PORTAL_ROWS.map((y) => subject.bot.blockAt(subject.world([x, y, PORTAL_Z]))?.name));
    assert.ok(!portalNames.includes("nether_portal"), `the portal broke when lava replaced the top of its frame (${became})`);
    assert.equal(describeCell(subject, NETHER_PORTAL.block), "lava[level=8]", `the lava poured into the top block of the broken portal (${became})`);
  },
};

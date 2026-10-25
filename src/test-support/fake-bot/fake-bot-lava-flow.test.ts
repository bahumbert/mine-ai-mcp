/**
 * The fake bot's lava, as the 1.21.4 server flowed it in contract check `lava-over-hole` (Mine Labs, 2026-10-24): a lava
 * source on a floor fills the open cell beside it with a flowing level 2 after 30 ticks, a flowing cell on a floor fills its
 * open neighbour with level 4 after 30 more, and a flowing cell with air or lava under it pours down (air becomes a falling
 * column, level 8) and fills nothing beside it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeHarness, createFakeBot } from "./fake-bot.js";
import type { FakeCell } from "./fake-world.js";

const TICK_MS = 50;
const FLOW_TICKS = 30;
const FLOOR_Y = 62;
const LAVA_Y = 63;

const lava = (level: number): FakeCell => ({ name: "lava", properties: { level } });
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** A row along x at z 0 from a source at x 0: floors at y 62 (the fake's ground) under every lava cell but those in `holes`, walls beside the row at z -1 and 1. */
function rowBot(cells: Record<string, FakeCell> = {}): FakeHarness {
  const walls: Record<string, FakeCell> = {};
  for (let x = -1; x <= 4; x += 1) for (const z of [-1, 1]) walls[key(x, LAVA_Y, z)] = "stone";
  return createFakeBot({ position: new Vec3(8.5, LAVA_Y, 0.5), groundY: FLOOR_Y, cells: { ...walls, ...cells } });
}

const nameAt = ({ bot }: FakeHarness, x: number, y: number, z = 0) => {
  const block = bot.blockAt(new Vec3(x, y, z))!;
  return block.name === "lava" ? `lava ${String(block.getProperties().level)}` : block.name;
};

test("a source on a floor fills the open cell beside it with a level 2 after 30 ticks and that one its neighbour with a level 4 after 30 more; a wall takes none", async () => {
  const harness = rowBot({ [key(3, LAVA_Y, 0)]: "stone" });
  harness.world.setCell(new Vec3(0, LAVA_Y, 0), lava(0));
  await harness.clock.advance((FLOW_TICKS - 1) * TICK_MS);
  assert.equal(nameAt(harness, 1, LAVA_Y), "air", "not before 30 ticks");
  await harness.clock.advance(TICK_MS);
  assert.equal(nameAt(harness, 1, LAVA_Y), "lava 2");
  await harness.clock.advance(FLOW_TICKS * TICK_MS);
  assert.deepEqual([1, 2, 3].map((x) => nameAt(harness, x, LAVA_Y)), ["lava 2", "lava 4", "stone"]);
});

test("a level 2 with air under it pours a falling column and fills nothing beside it; with lava under it nothing happens beside it either", async () => {
  const overAir = rowBot({ [key(1, FLOOR_Y, 0)]: "air" });
  overAir.world.setCell(new Vec3(1, LAVA_Y, 0), lava(2));
  await overAir.clock.advance(FLOW_TICKS * 3 * TICK_MS);
  assert.equal(nameAt(overAir, 1, FLOOR_Y), "lava 8");
  assert.deepEqual([0, 2].map((x) => nameAt(overAir, x, LAVA_Y)), ["air", "air"]);
  const overLava = rowBot({ [key(1, FLOOR_Y, 0)]: lava(8) });
  overLava.world.setCell(new Vec3(1, LAVA_Y, 0), lava(2));
  await overLava.clock.advance(FLOW_TICKS * 3 * TICK_MS);
  assert.deepEqual([0, 2].map((x) => nameAt(overLava, x, LAVA_Y)), ["air", "air"]);
});

test("a source over air pours a falling column after 30 ticks and that column goes on down one cell every 30 ticks; the cells beside the source stay air (not measured)", async () => {
  const harness = rowBot({ [key(1, FLOOR_Y, 0)]: "air", [key(1, FLOOR_Y - 1, 0)]: "air" });
  harness.world.setCell(new Vec3(1, LAVA_Y, 0), lava(0));
  await harness.clock.advance((FLOW_TICKS - 1) * TICK_MS);
  assert.equal(nameAt(harness, 1, FLOOR_Y), "air", "not before 30 ticks");
  await harness.clock.advance(TICK_MS);
  assert.deepEqual([nameAt(harness, 1, FLOOR_Y), nameAt(harness, 1, FLOOR_Y - 1)], ["lava 8", "air"]);
  await harness.clock.advance(FLOW_TICKS * TICK_MS);
  assert.deepEqual([nameAt(harness, 1, FLOOR_Y), nameAt(harness, 1, FLOOR_Y - 1)], ["lava 8", "lava 8"]);
  assert.deepEqual([0, 2].map((x) => nameAt(harness, x, LAVA_Y)), ["air", "air"]);
});

/** Contract check `lava-over-passable` (T7e5a, 2026-10-24): lava over these blocks stays where it is and the block stays. */
const LAVA_PROOF = ["sugar_cane", "structure_void"] as const;

test("a source or a level 2 over sugar cane or a structure void: the block stays and the lava stays (the cells beside it are not answered)", async () => {
  for (const name of LAVA_PROOF) {
    for (const level of [0, 2]) {
      const harness = rowBot({ [key(1, FLOOR_Y, 0)]: name });
      harness.world.setCell(new Vec3(1, LAVA_Y, 0), lava(level));
      await harness.clock.advance(FLOW_TICKS * 3 * TICK_MS);
      assert.deepEqual([nameAt(harness, 1, FLOOR_Y), nameAt(harness, 1, LAVA_Y)], [name, `lava ${level}`], `${name} level ${level}`);
    }
  }
});

test("the sugar cane under a lava source broken before its turn: the lava reads the cell at its turn and pours into the air", async () => {
  const broken = rowBot({ [key(1, FLOOR_Y, 0)]: "sugar_cane", [key(1, FLOOR_Y - 1, 0)]: "air" });
  broken.world.setCell(new Vec3(1, LAVA_Y, 0), lava(0));
  await broken.clock.advance(10 * TICK_MS);
  broken.world.setCell(new Vec3(1, FLOOR_Y, 0), "air");
  await broken.clock.advance(FLOW_TICKS * TICK_MS);
  assert.equal(nameAt(broken, 1, FLOOR_Y), "lava 8");
});

test("lava in the cell above a nether portal breaks the whole portal at once and then pours down through it, a cell every 30 ticks", async () => {
  const portal: Record<string, FakeCell> = {};
  for (const y of [FLOOR_Y, FLOOR_Y - 1, FLOOR_Y - 2]) portal[key(1, y, 0)] = { name: "nether_portal", properties: { axis: "x" } };
  portal[key(2, FLOOR_Y, 0)] = { name: "nether_portal", properties: { axis: "x" } };
  portal[key(1, LAVA_Y, 0)] = "obsidian";
  const harness = rowBot(portal);
  harness.world.setCell(new Vec3(1, LAVA_Y, 0), lava(0));
  assert.deepEqual([[1, FLOOR_Y], [1, FLOOR_Y - 1], [1, FLOOR_Y - 2], [2, FLOOR_Y]].map(([x, y]) => nameAt(harness, x!, y!)), ["air", "air", "air", "air"], "the portal blocks went with the frame");
  await harness.clock.advance(FLOW_TICKS * TICK_MS);
  assert.deepEqual([FLOOR_Y, FLOOR_Y - 1].map((y) => nameAt(harness, 1, y)), ["lava 8", "air"]);
  await harness.clock.advance(FLOW_TICKS * TICK_MS);
  assert.deepEqual([FLOOR_Y, FLOOR_Y - 1].map((y) => nameAt(harness, 1, y)), ["lava 8", "lava 8"]);
});

test("lava beside a portal block, not over it, does not break it or fill it: only air is flowed into", async () => {
  const harness = rowBot({ [key(2, LAVA_Y, 0)]: { name: "nether_portal", properties: { axis: "x" } } });
  harness.world.setCell(new Vec3(0, LAVA_Y, 0), lava(0));
  await harness.clock.advance(FLOW_TICKS * 3 * TICK_MS);
  assert.deepEqual([1, 2].map((x) => nameAt(harness, x, LAVA_Y)), ["lava 2", "nether_portal"]);
});

test("a stopped server flows no lava, and lava removed and set again counts its 30 ticks from the second time", async () => {
  const stopped = rowBot();
  stopped.server.stop();
  stopped.world.setCell(new Vec3(0, LAVA_Y, 0), lava(0));
  await stopped.clock.advance(FLOW_TICKS * 3 * TICK_MS);
  assert.equal(nameAt(stopped, 1, LAVA_Y), "air");
  const reset = rowBot();
  reset.world.setCell(new Vec3(0, LAVA_Y, 0), lava(0));
  await reset.clock.advance(20 * TICK_MS);
  reset.world.setCell(new Vec3(0, LAVA_Y, 0), "air");
  await reset.clock.advance(5 * TICK_MS);
  reset.world.setCell(new Vec3(0, LAVA_Y, 0), lava(0));
  await reset.clock.advance(15 * TICK_MS);
  assert.equal(nameAt(reset, 1, LAVA_Y), "air", "35 ticks after the first set, 15 after the second");
  await reset.clock.advance(15 * TICK_MS);
  assert.equal(nameAt(reset, 1, LAVA_Y), "lava 2");
});

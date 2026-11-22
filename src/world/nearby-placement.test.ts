import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../test-support/fake-bot/index.js";
import { cellKey } from "../utils/index.js";
import { findStandingSpot, placeCarriedBlockNearby } from "./nearby-placement.js";
import { setProtectedRegionsProvider, type ProtectedRegion } from "./protected-regions.js";

/** Every cell of the box becomes `name`; later calls overwrite earlier ones. */
function fill(cells: Record<string, string>, name: string, [x0, y0, z0]: number[], [x1, y1, z1]: number[]): void {
  for (let x = x0!; x <= x1!; x += 1)
    for (let y = y0!; y <= y1!; y += 1) for (let z = z0!; z <= z1!; z += 1) cells[cellKey(new Vec3(x, y, z))] = name;
}

/** Open air above, stone up to y=59 and the feet of the bot at (0, 62, 0). */
function botIn(cells: Record<string, string>) {
  return createFakeBot({ cells, groundY: null, position: { x: 0.5, y: 62, z: 0.5 } }).bot;
}

/** A lake of water (y 60..62) for x <= 4, dry stone ground (top y=61) from x = shoreX on. */
function lake(shoreX: number): Record<string, string> {
  const cells: Record<string, string> = {};
  fill(cells, "stone", [-14, 50, -14], [14, 59, 14]);
  fill(cells, "water", [-14, 60, -14], [shoreX - 1, 62, 14]);
  fill(cells, "stone", [shoreX, 60, -14], [14, 61, 14]);
  return cells;
}

test("a bot swimming in a lake is sent to the shore 5 blocks off", () => {
  const bot = botIn(lake(5));
  assert.deepEqual(findStandingSpot(bot), new Vec3(5, 62, 0));
});

test("the nearest dry cell wins when the lake has two shores", () => {
  const cells = lake(6);
  // A second, nearer shore to the west.
  fill(cells, "stone", [-14, 60, -14], [-4, 61, 14]);
  fill(cells, "air", [-14, 62, -14], [-4, 62, 14]);
  const bot = botIn(cells);
  assert.deepEqual(findStandingSpot(bot), new Vec3(-4, 62, 0));
});

test("a flooded tunnel leads to the side room 6 blocks off, not to a flooded cell", () => {
  const cells: Record<string, string> = {};
  fill(cells, "stone", [-14, 55, -14], [14, 70, 14]);
  // The tunnel is 1 wide and flooded, the room is dry with stone below.
  fill(cells, "water", [-3, 62, 0], [5, 63, 0]);
  fill(cells, "air", [6, 62, -1], [8, 64, 1]);
  const bot = botIn(cells);
  assert.deepEqual(findStandingSpot(bot), new Vec3(6, 62, 0));
});

test("a spot inside a protected region is found when nothing outside has a free cell", () => {
  const bot = botIn(lake(5));
  setProtectedRegionsProvider(bot, () => [
    { regionId: 1, dimension: "overworld", min: { x: 4, y: 40, z: -20 }, max: { x: 20, y: 80, z: 20 }, owner: "TestBot", label: "house" },
  ]);
  assert.deepEqual(findStandingSpot(bot), new Vec3(5, 62, 0));
});

test("nothing within 8 blocks gives null", () => {
  assert.equal(findStandingSpot(botIn(lake(10))), null);
});

test("the radius is the caller's to widen", () => {
  assert.deepEqual(findStandingSpot(botIn(lake(10)), 12), new Vec3(10, 62, 0));
});

test("cells that are not loaded are not offered", () => {
  const cells = lake(5);
  fill(cells, "void", [5, 60, -14], [14, 70, 14]);
  assert.equal(findStandingSpot(botIn(cells)), null);
});

test("a spot is skipped when no cell can be filled from it", () => {
  const cells = lake(5);
  // The shore is solid rock but for a 1x1x2 pit: dry feet and head, solid below, a dead end with no free cell.
  fill(cells, "stone", [5, 62, -14], [14, 70, 14]);
  fill(cells, "air", [8, 62, 0], [8, 63, 0]);
  assert.equal(findStandingSpot(botIn(cells)), null);
});

function craftingTableBot() {
  const cells: Record<string, string> = {};
  fill(cells, "stone", [-6, 50, -6], [6, 61, 6]);
  return createFakeBot({ cells, groundY: null, position: { x: 0.5, y: 62, z: 0.5 }, carried: { crafting_table: 1 } }).bot;
}

test("the cell is reported right before the placement packet, so an aborted placement still names it", async () => {
  const bot = craftingTableBot();
  const controller = new AbortController();
  let reported: readonly Vec3[] | null = null;
  let reportedBeforePacket = false;
  Object.assign(bot, {
    _placeBlockWithOptions: async () => {
      reportedBeforePacket = reported !== null;
      controller.abort(new Error("reflex took the body"));
      throw controller.signal.reason;
    },
  });

  await assert.rejects(
    placeCarriedBlockNearby(bot, "crafting_table", { signal: controller.signal, onPlacementSent: (cells) => (reported = cells) }),
    /reflex took the body/,
  );

  assert.equal(reportedBeforePacket, true);
  assert.equal(reported!.length, 1);
  assert.equal(reported![0]!.y, 62, "an air cell on the stone floor");
  assert.ok(reported![0]!.distanceTo(bot.entity.position) <= 4);
});

/**
 * Solid rock around a bot standing at (0, 62, 0) with two free pockets beside it, east (1, 62, 0) and west (-1, 62, 0):
 * the only cells a table can go in. Creative, so the placement needs no count; a mocked clock drives the server's answer.
 */
function pocketBot(pockets: readonly Vec3[], regions: readonly ProtectedRegion[]) {
  const cells: Record<string, string> = {};
  fill(cells, "stone", [-6, 50, -6], [6, 66, 6]);
  fill(cells, "air", [0, 62, 0], [0, 63, 0]);
  for (const pocket of pockets) cells[cellKey(pocket)] = "air";
  const harness = createFakeBot({
    cells, groundY: null, position: { x: 0.5, y: 62, z: 0.5 }, carried: { crafting_table: 1 },
    username: "Ayla", gameMode: "creative", clock: createFakeClock({ mode: "mocked" }),
  });
  setProtectedRegionsProvider(harness.bot, () => regions);
  return harness;
}

const EAST = new Vec3(1, 62, 0);
const WEST = new Vec3(-1, 62, 0);
const boxAround = (cell: Vec3, owner: string): ProtectedRegion => ({
  regionId: 5, dimension: "overworld", min: { x: cell.x, y: 60, z: cell.z }, max: { x: cell.x, y: 70, z: cell.z }, owner, label: "a build",
});

test("a table is put in a free cell outside every region, never in a foreign one", async () => {
  const { bot, clock } = pocketBot([EAST, WEST], [boxAround(EAST, "Tom")]);
  using _timers = clock.install();
  const result = await clock.settle(placeCarriedBlockNearby(bot, "crafting_table"), 50);
  assert.equal(result.kind, "placed");
  if (result.kind === "placed") assert.deepEqual(result.position, WEST);
});

test("when the only free cell lies in a foreign region nothing is placed", async () => {
  const { bot, clock, server } = pocketBot([EAST], [boxAround(EAST, "Tom")]);
  using _timers = clock.install();
  const result = await clock.settle(placeCarriedBlockNearby(bot, "crafting_table"), 50);
  assert.equal(result.kind, "no_cell");
  assert.equal(server.packets.filter((packet) => packet.name === "block_place").length, 0);
});

test("when the only free cell lies in the bot's own region the second pass takes it", async () => {
  const { bot, clock } = pocketBot([EAST], [boxAround(EAST, "ayla")]);
  using _timers = clock.install();
  const result = await clock.settle(placeCarriedBlockNearby(bot, "crafting_table"), 50);
  assert.equal(result.kind, "placed");
  if (result.kind === "placed") assert.deepEqual(result.position, EAST);
});

test("a standing spot is not offered when its only free cells are foreign, and is when they are the bot's own", () => {
  const foreign = pocketBot([EAST], [boxAround(EAST, "Tom")]).bot;
  assert.equal(findStandingSpot(foreign, 1), null);
  const own = pocketBot([EAST], [boxAround(EAST, "Ayla")]).bot;
  assert.notEqual(findStandingSpot(own, 1), null);
});

test("a placement cut before the packet is sent reports no cell: nothing of it is ours", async () => {
  const bot = craftingTableBot();
  const controller = new AbortController();
  controller.abort(new Error("reflex took the body"));
  let reported = false;

  await assert.rejects(
    placeCarriedBlockNearby(bot, "crafting_table", { signal: controller.signal, onPlacementSent: () => (reported = true) }),
    /reflex took the body/,
  );

  assert.equal(reported, false);
});

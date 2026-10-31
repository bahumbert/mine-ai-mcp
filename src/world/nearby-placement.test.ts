import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../test-support/fake-bot/index.js";
import { cellKey } from "../utils/index.js";
import { findStandingSpot, placeCarriedBlockNearby } from "./nearby-placement.js";
import { setProtectedRegionsProvider } from "./protected-regions.js";

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

const OPEN_FLOOR = ((): Record<string, string> => {
  const cells: Record<string, string> = {};
  fill(cells, "stone", [-16, 50, -16], [16, 61, 16]);
  return cells;
})();

function craftingBotAmong(regionOwner: string, box: { min: [number, number, number]; max: [number, number, number] }) {
  const clock = createFakeClock({ mode: "mocked" });
  const bot = createFakeBot({ cells: { ...OPEN_FLOOR }, groundY: null, position: { x: 0.5, y: 62, z: 0.5 }, carried: { crafting_table: 1 }, clock }).bot;
  setProtectedRegionsProvider(bot, () => [
    {
      regionId: 1,
      dimension: "overworld",
      min: { x: box.min[0], y: box.min[1], z: box.min[2] },
      max: { x: box.max[0], y: box.max[1], z: box.max[2] },
      owner: regionOwner,
      label: "Finn_Perimeter",
    },
  ]);
  return { bot, clock };
}

const AROUND_THE_BOT = { min: [-13, 40, -13] as [number, number, number], max: [13, 80, 13] as [number, number, number] };

test("a block to take back is refused inside an area another player owns, naming the nearest edge on each side", async () => {
  const sides = [
    { box: { min: [-5, 40, -13], max: [13, 80, 13] }, way: "6 blocks west" },
    { box: { min: [-13, 40, -13], max: [6, 80, 13] }, way: "7 blocks east" },
    { box: { min: [-13, 40, -4], max: [13, 80, 13] }, way: "5 blocks north" },
    { box: { min: [-13, 40, -13], max: [13, 80, 7] }, way: "8 blocks south" },
  ] as const;
  for (const { box, way } of sides) {
    const { bot } = craftingBotAmong("Finn", box as never);
    const result = await placeCarriedBlockNearby(bot, "crafting_table", { takeBack: true });
    assert.deepEqual(result, { kind: "no_cell", foreignArea: `inside Finn's protected area 'Finn_Perimeter': go ${way} to its edge first` });
  }
});

test("a bot swimming beside the area whose free cells are all inside it is not told to walk to an edge", async () => {
  const cells = lake(1);
  const bot = createFakeBot({ cells, groundY: null, position: { x: 0.5, y: 62, z: 0.5 }, carried: { crafting_table: 1 } }).bot;
  setProtectedRegionsProvider(bot, () => [
    { regionId: 1, dimension: "overworld", min: { x: 1, y: 40, z: -20 }, max: { x: 20, y: 80, z: 20 }, owner: "Finn", label: "Finn_Perimeter" },
  ]);
  const result = await placeCarriedBlockNearby(bot, "crafting_table", { takeBack: true });
  assert.deepEqual(result, {
    kind: "no_cell",
    foreignArea: "inside Finn's protected area 'Finn_Perimeter' (you stand outside it): look for open ground elsewhere",
  });
});

test("a block put down to stay still goes inside an area another player owns", async () => {
  const { bot, clock } = craftingBotAmong("Finn", AROUND_THE_BOT);
  using _installed = clock.install();
  const result = await clock.settle(placeCarriedBlockNearby(bot, "crafting_table"), 2_000);
  assert.equal(result.kind, "placed");
});

test("a block to take back is put down inside the bot's own area, the owner's name in another case", async () => {
  const { bot, clock } = craftingBotAmong("testbot", AROUND_THE_BOT);
  using _installed = clock.install();
  const result = await clock.settle(placeCarriedBlockNearby(bot, "crafting_table", { takeBack: true }), 2_000);
  assert.equal(result.kind, "placed");
});

test("a block to take back goes outside the foreign area when a cell is free there", async () => {
  const { bot, clock } = craftingBotAmong("Finn", { min: [-13, 40, -13], max: [0, 80, 13] });
  using _installed = clock.install();
  const result = await clock.settle(placeCarriedBlockNearby(bot, "crafting_table", { takeBack: true }), 2_000);
  assert.equal(result.kind, "placed");
  if (result.kind === "placed") assert.ok(result.position.x >= 1, "east of the area");
});

test("a standing spot to take a block back from is not inside a foreign area", () => {
  const { bot } = craftingBotAmong("Finn", AROUND_THE_BOT);
  assert.equal(findStandingSpot(bot, 8, "crafting_table", { takeBack: true }), null, "the edge is 14 blocks off");
  const { bot: near } = craftingBotAmong("Finn", { min: [-13, 40, -13], max: [4, 80, 13] });
  const spot = findStandingSpot(near, 8, "crafting_table", { takeBack: true });
  assert.deepEqual(spot, new Vec3(2, 62, 0), "close enough to put a block east of the area");
});

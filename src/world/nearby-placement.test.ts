import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../test-support/bot.js";
import { cellKey } from "../utils/index.js";
import { findStandingSpot } from "./nearby-placement.js";
import { setProtectedRegionsProvider } from "./protected-regions.js";

/** Every cell of the box becomes `name`; later calls overwrite earlier ones. */
function fill(cells: Record<string, string>, name: string, [x0, y0, z0]: number[], [x1, y1, z1]: number[]): void {
  for (let x = x0!; x <= x1!; x += 1)
    for (let y = y0!; y <= y1!; y += 1) for (let z = z0!; z <= z1!; z += 1) cells[cellKey(new Vec3(x, y, z))] = name;
}

/** Open air above, stone up to y=59 and the feet of the bot at (0, 62, 0). */
function botIn(cells: Record<string, string>) {
  return botFixture({ blocks: cells, position: { x: 0.5, y: 62, z: 0.5 } });
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

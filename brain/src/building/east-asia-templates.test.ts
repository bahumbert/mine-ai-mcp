import assert from "node:assert/strict";
import test from "node:test";
import { FACING_VECTOR } from "./blueprint.ts";
import { templateFor, type Template } from "./templates.ts";

const IDS = ["minka", "pagoda-house", "hanok"] as const;
const placedCells = (template: Template) => template.blueprint.cells.filter((cell) => cell.role !== "air");

test("the three east-asia houses are registered under their file names", () => {
  for (const id of IDS) assert.equal(templateFor(id)?.family, "east-asia", id);
});

test("each east-asia house fits the content limits and one of them is small", () => {
  const sizes = IDS.map((id) => placedCells(templateFor(id)!).length);
  sizes.forEach((count, index) => assert.ok(count <= 700, `${IDS[index]}: ${count} cells, at most 700`));
  assert.ok(sizes.some((count) => count <= 200), `one of the three is at most 200 cells, they are ${sizes.join(", ")}`);
});

test("the two-floor pagoda house has an inner ladder on a wall and a 1x2 opening in its upper floor", () => {
  const { cells } = templateFor("pagoda-house")!.blueprint;
  const floorLayers = [...new Set(cells.filter((cell) => cell.role === "floor").map((cell) => cell.y))].sort((a, b) => a - b);
  assert.equal(floorLayers.length, 2, "pagoda-house has two floors");
  const upper = floorLayers[1]!;
  const ladder = cells.filter((cell) => cell.role === "accent" && cell.facing !== undefined);
  const rising = ladder.filter((cell) => cell.y === upper);
  assert.equal(rising.length, 1, "the ladder passes through the upper floor in one cell");
  const hole = rising[0]!;
  assert.equal(cells.some((cell) => cell.role === "floor" && cell.y === upper && cell.x === hole.x && cell.z === hole.z), false);
  const opening = cells.filter((cell) => cell.y === upper && (cell.role === "air" || (cell.role === "accent" && cell.facing !== undefined)));
  assert.equal(opening.length, 2, "the opening in the upper floor is two cells");
  assert.equal(Math.abs(opening[0]!.x - opening[1]!.x) + Math.abs(opening[0]!.z - opening[1]!.z), 1, "the two opening cells touch");
  assert.ok(ladder.some((cell) => cell.y === upper + 1), "the ladder reaches the floor level above the opening");
  for (const cell of ladder) {
    const [dx, dz] = FACING_VECTOR[cell.facing!];
    const behind = cells.find((other) => other.x === cell.x - dx && other.y === cell.y && other.z === cell.z - dz);
    assert.ok(behind !== undefined && ["foundation", "floor", "wall", "pillar", "trim"].includes(behind.role), `ladder ${cell.x},${cell.y},${cell.z}: a structural block must be behind it`);
  }
});

test("hanok's front wall is closed under the roof: a beam lies over every cell of its top", () => {
  const { cells } = templateFor("hanok")!.blueprint;
  const door = cells.find((cell) => cell.role === "door")!;
  const wallTop = door.y + 1;
  const frontLine = cells.filter((cell) => cell.z === door.z && cell.y === wallTop && cell.role !== "air");
  assert.ok(frontLine.length > 0);
  for (const cell of frontLine) {
    assert.ok(cells.some((above) => above.x === cell.x && above.z === cell.z && above.y === wallTop + 1 && above.role !== "air"), `no beam over the front wall at ${cell.x},${cell.z}`);
  }
});

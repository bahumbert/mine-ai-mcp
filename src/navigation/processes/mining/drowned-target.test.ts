// D4 pre-walk decisions over registry-backed cells, as measured by water-held-cells and the collect scenarios.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, type FakeCell } from "../../../test-support/fake-bot/index.js";
import { liveBlockReader } from "../../mineflayer/world.js";
import { drownedVerdict, hasWetFace } from "./drowned-target.js";

const target = { x: 0, y: 64, z: 0 };

/** A submerged trunk with every working cell flooded, including the cell over the top. */
function seaCells(): Record<string, FakeCell> {
  const cells: Record<string, FakeCell> = {};
  for (let x = -1; x <= 1; x++)
    for (let y = 64; y <= 67; y++)
      for (let z = -1; z <= 1; z++) cells[`${x},${y},${z}`] = "water";
  cells["0,64,0"] = "oak_log";
  cells["0,65,0"] = "oak_log";
  return cells;
}

/** The same observation reader used by the live mine process. */
function verdict(cells: Record<string, FakeCell>, blocks = 16, closures = 0, position = target) {
  const { bot } = createFakeBot({ groundY: 63, cells });
  const world = { blockAt: liveBlockReader(bot), revision: 0, subscribe: () => () => {} };
  return drownedVerdict(bot, world, position, blocks, closures);
}

test("a log with no wet face is dry, including the lower log drowned only at its top", () => {
  const scenes: Record<string, FakeCell>[] = [{ "0,64,0": "oak_log" }, { "0,64,0": "oak_log", "0,65,0": "oak_log", "0,66,0": "water" }];
  for (const cells of scenes)
    assert.deepEqual(verdict(cells), { kind: "dry" });
});

test("a pond face is drainable with one block and excludes its wet stance", () => {
  const result = verdict({ "0,64,0": "oak_log", "-1,64,0": "water" }, 1);
  assert.equal(result.kind, "drainable");
  if (result.kind !== "drainable") throw new Error("expected a drainable bank");
  assert.ok(result.wetStances.some((cell) => cell.x === -1 && cell.y === 64 && cell.z === 0));
  assert.ok(!result.wetStances.some((cell) => cell.x === 1 && cell.y === 64 && cell.z === 0));
});

test("a sea-floor trunk has no dry stance, including a solid sand step, lava feet or unloaded banks", () => {
  const variations: Record<string, FakeCell>[] = [{}, { "1,64,0": "sand", "1,65,0": "sand" }, { "1,64,0": "lava", "1,65,0": "air" }];
  for (const extra of variations) {
    assert.deepEqual(verdict({ ...seaCells(), ...extra }), {
      kind: "refused", reason: "in water: no dry ground beside it to drain it from",
    });
  }
  const { bot } = createFakeBot({ groundY: 63, cells: seaCells(), loadedColumns: [[0, 0]] });
  const world = { blockAt: liveBlockReader(bot), revision: 0, subscribe: () => () => {} };
  assert.equal(bot.blockAt(new Vec3(-1, 64, 0)), null);
  assert.deepEqual(drownedVerdict(bot, world, target, 16, 0), {
    kind: "refused", reason: "in water: no dry ground beside it to drain it from",
  });
});

test("a trunk in the sea with its top in air refuses submerged logs and keeps the dry top", () => {
  const cells = seaCells();
  for (let y = 64; y <= 68; y++) cells[`0,${y},0`] = "oak_log";
  for (const y of [64, 65, 66]) assert.equal(verdict(cells, 16, 0, { ...target, y }).kind, "refused");
  assert.deepEqual(verdict(cells, 16, 0, { ...target, y: 68 }), { kind: "dry" });
});

test("a waterlogged target in open air is judged by its faces", () => {
  const cells: Record<string, FakeCell> = { "0,64,0": { name: "mangrove_roots", properties: { waterlogged: true } } };
  assert.deepEqual(verdict(cells), { kind: "dry" });
  assert.equal(verdict({ ...cells, "-1,64,0": "water" }, 1).kind, "drainable");
});

test("kelp beside is refused because a placement does not replace it", () => {
  assert.deepEqual(verdict({ "0,64,0": "oak_log", "-1,64,0": "kelp" }), {
    kind: "refused", reason: "in water: water beside it is held by kelp, which a placement does not replace",
  });
});

test("too few blocks names distinct feeding sources and includes lava closures", () => {
  assert.deepEqual(verdict({ "0,64,0": "oak_log", "-1,64,0": { name: "water", properties: { level: 1 } }, "-2,64,0": "water" }, 1), {
    kind: "refused", reason: "in water: draining it takes 2 blocks to place, 1 carried",
  });
  assert.deepEqual(verdict({ "0,64,0": "oak_log", "-1,64,0": "water", "1,64,0": "water" }, 3, 2), {
    kind: "refused", reason: "in water: draining it takes 2 blocks to place, 3 carried",
  });
});

test("hasWetFace reads current faces rather than the target's own water", () => {
  const { bot, world: cells } = createFakeBot({ cells: { "0,64,0": { name: "mangrove_roots", properties: { waterlogged: true } } } });
  const world = { blockAt: liveBlockReader(bot), revision: 0, subscribe: () => () => {} };
  assert.equal(hasWetFace(world, target), false);
  cells.setCell(new Vec3(-1, 64, 0), "water");
  assert.equal(hasWetFace(world, target), true);
  cells.setCell(new Vec3(-1, 64, 0), "air");
  assert.equal(hasWetFace(world, target), false);
});

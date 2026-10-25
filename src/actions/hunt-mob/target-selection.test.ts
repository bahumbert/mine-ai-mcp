import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeCell, type FakeHarness, createFakeBot } from "../../test-support/fake-bot/index.js";
import { compareCollectionTargets } from "./target-selection.js";

/** The bot's own entity is id 1, so the tests' blaze `n` is the harness entity `BLAZE_ID_BASE + n`. */
const BLAZE_ID_BASE = 100;
const BLAZE_IDS = [1, 2, 3];

/** A blaze of the harness at (x, y, 0): Prismarine's entity, sized from the version's data. */
function blazeOf(harness: FakeHarness) {
  return (id: number, x: number, y: number) => {
    const entity = harness.bot.entities[BLAZE_ID_BASE + id]!;
    entity.position = new Vec3(x, y, 0);
    return entity;
  };
}

/** Ground by column below y 64 and air above; `null` is a column in a chunk the bot has not loaded. */
function terrain(ground: (x: number) => string | null) {
  const cells: Record<string, FakeCell> = {};
  for (let x = -2; x <= 10; x += 1)
    for (let z = -1; z <= 1; z += 1)
      for (let y = 30; y <= 80; y += 1) {
        const name = ground(x);
        if (name === null) cells[`${x},${y},${z}`] = "void";
        else if (y < 64) cells[`${x},${y},${z}`] = name;
      }
  const harness = createFakeBot({
    position: new Vec3(0, 64, 0),
    groundY: null,
    cells,
    entities: Object.fromEntries(BLAZE_IDS.map((id) => [BLAZE_ID_BASE + id, { name: "blaze", position: new Vec3(0, 70, 0) }])),
  });
  return { bot: harness.bot, blaze: blazeOf(harness) };
}

test("collection prefers a farther supported blaze drop over a nearby lava landing", () => {
  const { bot, blaze } = terrain((x) => (x < 5 ? "lava" : "nether_bricks"));
  assert.ok(compareCollectionTargets(bot, blaze(1, 8, 68), blaze(2, 2, 65)) < 0);
});

test("collection prefers a shorter supported drop and keeps unknown landings eligible", () => {
  const { bot, blaze } = terrain((x) => (x === 3 ? null : "nether_bricks"));
  assert.ok(compareCollectionTargets(bot, blaze(1, 8, 65), blaze(2, 2, 72)) < 0);
  assert.ok(compareCollectionTargets(bot, blaze(1, 8, 65), blaze(3, 3, 65)) < 0);
  assert.equal(compareCollectionTargets(bot, blaze(3, 3, 65), blaze(3, 3, 65)), 0);
});

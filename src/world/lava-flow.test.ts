import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeCell, createFakeBot } from "../test-support/fake-bot/index.js";
import { advancingLavaAt, lavaChangedNear, lavaFlowDelayTicks, lavaSpreadsFrom } from "./lava-flow.js";

const lavaOfLevel = (level: number): FakeCell => ({ name: "lava", properties: { level } });

test("new adjacent lava threatens a dry stance before contact, respecting flow reach and barriers", () => {
  const source = new Vec3(-1, 64, 0);
  // The two cells the body stands in (feet and head); everything else around is air over stone.
  const body = [new Vec3(0, 64, 0), new Vec3(0, 65, 0)];
  const { bot, world } = createFakeBot({ position: new Vec3(0.5, 64, 0.5), cells: { "-1,64,0": lavaOfLevel(4) } });
  const fill = (block: FakeCell) => body.forEach((cell) => world.setCell(cell, block));
  assert.equal(advancingLavaAt(bot), true);
  assert.equal(
    advancingLavaAt(bot, bot.entity.position, new Vec3(8, 64, 0)),
    false,
    "unrelated updates do not claim the body",
  );
  assert.equal(advancingLavaAt(bot, new Vec3(1.5, 64, 0.5)), false);
  world.setCell(source, lavaOfLevel(6));
  assert.equal(advancingLavaAt(bot), false, "terminal Overworld flow cannot take another horizontal step");
  bot.game.dimension = "the_nether";
  assert.equal(advancingLavaAt(bot), true, "Nether flow reaches another cell");
  fill("stone");
  assert.equal(advancingLavaAt(bot), false, "a separating solid blocks flow");
  fill("water");
  assert.equal(advancingLavaAt(bot), false, "water reacts with lava instead of admitting its flow");
  fill("kelp");
  assert.equal(advancingLavaAt(bot), false, "a water plant holds water, which reacts with lava too");
});

/** A bot at (0.5, 64, 0.5); `lavaChangedNear` reads only its position. */
function changeBot(dimension = "overworld") {
  return createFakeBot({ position: new Vec3(0.5, 64, 0.5), dimension });
}

/** The block the world holds at `at` once it is `block`: a real Prismarine block with its state id and position. */
function blockAt(harness: ReturnType<typeof changeBot>, block: FakeCell, at: Vec3) {
  harness.world.setCell(at, block);
  return harness.world.blockAt(at);
}

test("a lava level change inside the volume counts", () => {
  const harness = changeBot();
  const at = new Vec3(2, 64, 0);
  const before = blockAt(harness, lavaOfLevel(0), at);
  assert.equal(lavaChangedNear(harness.bot, before, blockAt(harness, lavaOfLevel(1), at), 4), true);
});

test("lava turning to obsidian counts", () => {
  const harness = changeBot();
  const at = new Vec3(-4, 65, 3);
  const before = blockAt(harness, lavaOfLevel(0), at);
  assert.equal(lavaChangedNear(harness.bot, before, blockAt(harness, "obsidian", at), 4), true);
});

test("lava appearing in an air cell counts", () => {
  const harness = changeBot();
  const at = new Vec3(1, 62, 1);
  const air = blockAt(harness, "air", at);
  const lava = blockAt(harness, lavaOfLevel(1), at);
  assert.equal(lavaChangedNear(harness.bot, air, lava, 4), true);
  assert.equal(lavaChangedNear(harness.bot, null, lava, 4), true, "a cell not loaded before");
});

test("a change 5 blocks away does not count", () => {
  const harness = changeBot();
  const at = new Vec3(5, 64, 0);
  assert.equal(lavaChangedNear(harness.bot, blockAt(harness, lavaOfLevel(0), at), blockAt(harness, lavaOfLevel(1), at), 4), false);
  const behind = new Vec3(0, 64, -5);
  assert.equal(lavaChangedNear(harness.bot, blockAt(harness, lavaOfLevel(0), behind), blockAt(harness, lavaOfLevel(1), behind), 4), false);
});

test("a change 3 blocks below does not count", () => {
  const harness = changeBot();
  const at = new Vec3(0, 61, 0);
  assert.equal(lavaChangedNear(harness.bot, blockAt(harness, lavaOfLevel(0), at), blockAt(harness, lavaOfLevel(1), at), 4), false);
});

test("the same state again does not count", () => {
  const harness = changeBot();
  const at = new Vec3(1, 64, 0);
  assert.equal(lavaChangedNear(harness.bot, blockAt(harness, lavaOfLevel(0), at), blockAt(harness, lavaOfLevel(0), at), 4), false);
  const stone = blockAt(harness, "stone", at);
  assert.equal(lavaChangedNear(harness.bot, stone, blockAt(harness, "air", at), 4), false, "no lava on either side");
});

test("nether flow delay is 10 ticks, overworld 30", () => {
  assert.equal(lavaFlowDelayTicks(changeBot("the_nether").bot), 10);
  assert.equal(lavaFlowDelayTicks(changeBot("overworld").bot), 30);
});

test("lava with open cell under it pours down: flowing and falling lava spread sideways only on a floor or when the floor is not known, a source always", () => {
  for (const level of [1, 2, 7, 8]) {
    assert.equal(lavaSpreadsFrom(level, false, "overworld", false), false, `level ${level} over a hole`);
    assert.equal(lavaSpreadsFrom(level, false, "the_nether", false), false, `level ${level} over a hole in the nether`);
  }
  assert.equal(lavaSpreadsFrom(0, false, "overworld", false), true, "a source over a hole");
  assert.equal(lavaSpreadsFrom(2, false, "overworld", true), true, "level 2 on a floor");
  assert.equal(lavaSpreadsFrom(2, false, "overworld"), true, "level 2, floor not known (the reflex)");
  assert.equal(lavaSpreadsFrom(7, false, "overworld", true), false, "level 7 on a floor has no level left");
  assert.equal(lavaSpreadsFrom(2, true, "overworld", false), true, "lava above the cell falls into it whatever is under the lava");
});

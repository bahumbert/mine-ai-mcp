import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { advancingLavaAt, lavaChangedNear, lavaFlowDelayTicks } from "./lava-flow.js";

test("new adjacent lava threatens a dry stance before contact, respecting flow reach and barriers", () => {
  let level = "4";
  let body = "air";
  const source = new Vec3(-1, 64, 0);
  const bot = {
    game: { dimension: "overworld" },
    entity: { position: new Vec3(0.5, 64, 0.5) },
    blockAt: (p: Vec3) => {
      if (p.equals(source)) return { name: "lava", boundingBox: "empty", getProperties: () => ({ level }) };
      return { name: body, boundingBox: body === "stone" ? "block" : "empty" };
    },
  } as unknown as Bot;
  assert.equal(advancingLavaAt(bot), true);
  assert.equal(
    advancingLavaAt(bot, bot.entity.position, new Vec3(8, 64, 0)),
    false,
    "unrelated updates do not claim the body",
  );
  assert.equal(advancingLavaAt(bot, new Vec3(1.5, 64, 0.5)), false);
  level = "6";
  assert.equal(advancingLavaAt(bot), false, "terminal Overworld flow cannot take another horizontal step");
  bot.game.dimension = "the_nether";
  assert.equal(advancingLavaAt(bot), true, "Nether flow reaches another cell");
  body = "stone";
  assert.equal(advancingLavaAt(bot), false, "a separating solid blocks flow");
  body = "water";
  assert.equal(advancingLavaAt(bot), false, "water reacts with lava instead of admitting its flow");
  body = "kelp";
  assert.equal(advancingLavaAt(bot), false, "a water plant holds water, which reacts with lava too");
});

/** A bot at (0.5, 64, 0.5); `lavaChangedNear` reads only its position. */
function changeBot(dimension = "overworld") {
  return { game: { dimension }, entity: { position: new Vec3(0.5, 64, 0.5) } } as unknown as Bot;
}
const cell = (name: string, stateId: number, at: Vec3) => ({ name, stateId, position: at }) as unknown as NonNullable<ReturnType<Bot["blockAt"]>>;

test("a lava level change inside the volume counts", () => {
  const at = new Vec3(2, 64, 0);
  assert.equal(lavaChangedNear(changeBot(), cell("lava", 100, at), cell("lava", 101, at), 4), true);
});

test("lava turning to obsidian counts", () => {
  const at = new Vec3(-4, 65, 3);
  assert.equal(lavaChangedNear(changeBot(), cell("lava", 100, at), cell("obsidian", 200, at), 4), true);
});

test("lava appearing in an air cell counts", () => {
  const at = new Vec3(1, 62, 1);
  assert.equal(lavaChangedNear(changeBot(), cell("air", 0, at), cell("lava", 101, at), 4), true);
  assert.equal(lavaChangedNear(changeBot(), null, cell("lava", 101, at), 4), true, "a cell not loaded before");
});

test("a change 5 blocks away does not count", () => {
  const at = new Vec3(5, 64, 0);
  assert.equal(lavaChangedNear(changeBot(), cell("lava", 100, at), cell("lava", 101, at), 4), false);
  const behind = new Vec3(0, 64, -5);
  assert.equal(lavaChangedNear(changeBot(), cell("lava", 100, behind), cell("lava", 101, behind), 4), false);
});

test("a change 3 blocks below does not count", () => {
  const at = new Vec3(0, 61, 0);
  assert.equal(lavaChangedNear(changeBot(), cell("lava", 100, at), cell("lava", 101, at), 4), false);
});

test("the same state again does not count", () => {
  const at = new Vec3(1, 64, 0);
  assert.equal(lavaChangedNear(changeBot(), cell("lava", 100, at), cell("lava", 100, at), 4), false);
  assert.equal(lavaChangedNear(changeBot(), cell("stone", 1, at), cell("air", 0, at), 4), false, "no lava on either side");
});

test("nether flow delay is 10 ticks, overworld 30", () => {
  assert.equal(lavaFlowDelayTicks(changeBot("the_nether")), 10);
  assert.equal(lavaFlowDelayTicks(changeBot("overworld")), 30);
});

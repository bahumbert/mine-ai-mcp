import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { blockClass } from "../../mineflayer/world.js";
import { clearMiningWater } from "./mining-water.js";

test("dry mining seals source water, including below the target, while an existing surface swim needs no plug", async () => {
  for (const wetMiner of [false, true]) for (const offset of [new Vec3(1, 0, 0), new Vec3(0, -1, 0)]) {
    const bot = botFixture();
    bot.entity.position = new Vec3(0.5, 64, 0.5);
    bot.entity.onGround = true;
    const target = new Vec3(1, 64, 0);
    const face = target.plus(offset);
    const blocks = blockClass(bot);
    let sealed = false;
    bot.blockAt = (position) => {
      const name = (position.equals(face) && !sealed) || (wetMiner && position.equals(new Vec3(0, 64, 0)))
        ? "water" : position.equals(target) || position.y < 64 ? "stone" : "air";
      const block = blocks.fromStateId(bot.registry.blocksByName[name]!.minStateId, 0);
      block.position = position;
      return block;
    };
    // No source is visible, so preparation must seal the local face directly.
    bot.world.raycast = () => null;
    const result = await clearMiningWater(bot, target, async (_bot, position) => {
      assert.deepEqual(position, face);
      sealed = true;
      return { kind: "placed", block: bot.blockAt(face)! };
    }, null);
    assert.equal(result, null);
    assert.equal(sealed, !wetMiner);
  }
});

test("a dry mining site with no sealing material is refused without waiting for water that cannot drain", async () => {
  const bot = botFixture();
  const blocks = blockClass(bot);
  bot.entity.position = new Vec3(0.5, 64, 0.5);
  bot.blockAt = (position) => {
    const name = position.equals(new Vec3(2, 64, 0)) ? "water" : "air";
    const block = blocks.fromStateId(bot.registry.blocksByName[name]!.minStateId, 0);
    block.position = position;
    return block;
  };
  bot.world.raycast = () => null;
  const result = await clearMiningWater(bot, new Vec3(1, 64, 0), async () => ({ kind: "failed", error: "No building material" }), null);
  assert.match(result!, /could not be isolated.*No building material/);
});

test("a target touched by a kelp cell is sealed like one touched by water", async () => {
  const bot = botFixture();
  bot.entity.position = new Vec3(0.5, 64, 0.5);
  bot.entity.onGround = true;
  const target = new Vec3(1, 64, 0);
  const face = target.plus(new Vec3(1, 0, 0));
  const blocks = blockClass(bot);
  let sealed = false;
  bot.blockAt = (position) => {
    const name = position.equals(face) && !sealed ? "kelp" : position.equals(target) || position.y < 64 ? "stone" : "air";
    const block = blocks.fromStateId(bot.registry.blocksByName[name]!.minStateId, 0);
    block.position = position;
    return block;
  };
  bot.world.raycast = () => null;
  const result = await clearMiningWater(bot, target, async (_bot, position) => {
    assert.deepEqual(position, face);
    sealed = true;
    return { kind: "placed", block: bot.blockAt(face)! };
  }, null);
  assert.equal(result, null);
  assert.equal(sealed, true);
});

/** A miner at 0 64 0 beside a target at 1 64 0 in a fixture world of `water` cells (block names by "x,y,z"), stone below. */
function wetSite(water: Map<string, string>) {
  const bot = botFixture();
  bot.entity.position = new Vec3(0.5, 64, 0.5);
  bot.entity.onGround = true;
  const blocks = blockClass(bot);
  bot.blockAt = (position) => {
    const name = water.get(`${position.x},${position.y},${position.z}`) ??
      (position.equals(new Vec3(1, 64, 0)) || position.y < 64 ? "stone" : "air");
    const [base, level] = name.split("@");
    const block = level === undefined
      ? blocks.fromStateId(bot.registry.blocksByName[base!]!.minStateId, 0)
      : blocks.fromProperties(bot.registry.blocksByName[base!]!.id, { level: Number(level) }, 0);
    block.position = position;
    return block;
  };
  return bot;
}

test("water over the target and beside the cell over it is isolated with one block over the target", async () => {
  const water = new Map(["1,65,0", "2,65,0", "0,65,0", "1,65,1", "1,65,-1"].map((key) => [key, "water"]));
  const bot = wetSite(water);
  bot.world.raycast = () => null;
  const placed: string[] = [];
  const result = await clearMiningWater(bot, new Vec3(1, 64, 0), async (_bot, position) => {
    placed.push(`${position.x},${position.y},${position.z}`);
    water.delete(`${position.x},${position.y},${position.z}`);
    return { kind: "placed", block: bot.blockAt(new Vec3(position.x, position.y, position.z))! };
  }, null);
  assert.equal(result, null);
  assert.deepEqual(placed, ["1,65,0"]);
});

test("the wait for removed water to drain follows the server's clock, not client ticks that may have stopped", async () => {
  const water = new Map([["2,64,0", "water"], ["1,64,1", "water@3"]]);
  const bot = wetSite(water);
  bot.world.raycast = () => bot.blockAt(new Vec3(2, 64, 0)) as never;
  const ageing = setInterval(() => { bot.time.age += 20; }, 5);
  const result = await clearMiningWater(bot, new Vec3(1, 64, 0), async (_bot, position) => {
    water.delete(`${position.x},${position.y},${position.z}`);
    return { kind: "placed", block: bot.blockAt(new Vec3(position.x, position.y, position.z))! };
  }, null);
  clearInterval(ageing);
  assert.equal(result, null);
  assert.equal(water.size, 0);
});

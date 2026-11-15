import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../../../test-support/fake-bot/index.js";
import { cellKey } from "../../../utils/index.js";
import type { PlaceIntoCell } from "../../../world/placement.js";
import { clearMiningWater } from "./mining-water.js";
import { waterStancesHeld } from "../../steering/hold-water-position.js";

test("dry mining seals source water, including below the target, while an existing surface swim needs no plug", async () => {
  for (const wetMiner of [false, true]) for (const offset of [new Vec3(1, 0, 0), new Vec3(0, -1, 0)]) {
    const target = new Vec3(1, 64, 0);
    const face = target.plus(offset);
    const { bot, world } = createFakeBot({
      cells: { [cellKey(target)]: "stone", [cellKey(face)]: "water", ...(wetMiner && { "0,64,0": "water" }) },
    });
    let sealed = false;
    const result = await clearMiningWater(bot, target, async (_bot, position) => {
      assert.deepEqual(position, face);
      sealed = true;
      world.setCell(position, "cobblestone");
      return { kind: "placed", block: bot.blockAt(face)! };
    }, null);
    assert.equal(result, null);
    assert.equal(sealed, !wetMiner);
  }
});

test("a dry mining site with no sealing material is refused without waiting for water that cannot drain", async () => {
  const { bot } = createFakeBot({ groundY: null, cells: { "2,64,0": "water" } });
  const result = await clearMiningWater(bot, new Vec3(1, 64, 0), async () => ({ kind: "failed", error: "No building material" }), null);
  assert.match(result!, /could not be isolated.*No building material/);
});

test("a target touched by a kelp cell is sealed like one touched by water", async () => {
  const target = new Vec3(1, 64, 0);
  const face = target.plus(new Vec3(1, 0, 0));
  const { bot, world } = createFakeBot({ cells: { [cellKey(target)]: "stone", [cellKey(face)]: "kelp" } });
  let sealed = false;
  const result = await clearMiningWater(bot, target, async (_bot, position) => {
    assert.deepEqual(position, face);
    sealed = true;
    world.setCell(position, "cobblestone");
    return { kind: "placed", block: bot.blockAt(face)! };
  }, null);
  assert.equal(result, null);
  assert.equal(sealed, true);
});

/**
 * A miner at 0 64 0 beside a target at 1 64 0 in a world of `water` cells (block names by "x,y,z", "water@3" for the
 * flowing level 3), stone below. Its clock drives the global timers, which the drain wait reads.
 */
function wetSite(water: Record<string, string>, ticksPerSecond = 20) {
  const wet = Object.entries(water).map(([key, name]) => {
    const [base, level] = name.split("@");
    return [key, level === undefined ? base! : { name: base!, properties: { level: Number(level) } }] as const;
  });
  return createFakeBot({ clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond }, cells: { "1,64,0": "stone", ...Object.fromEntries(wet) } });
}

test("water over the target and beside the cell over it is isolated with one block over the target", async () => {
  const { bot, world } = wetSite(Object.fromEntries(["1,65,0", "2,65,0", "0,65,0", "1,65,1", "1,65,-1"].map((key) => [key, "water"])));
  const placed: string[] = [];
  const result = await clearMiningWater(bot, new Vec3(1, 64, 0), async (_bot, position) => {
    const cell = new Vec3(position.x, position.y, position.z);
    placed.push(cellKey(cell));
    world.setCell(cell, "cobblestone");
    return { kind: "placed", block: bot.blockAt(cell)! };
  }, null);
  assert.equal(result, null);
  assert.deepEqual(placed, ["1,65,0"]);
});

for (const { rate, stopped, endMs } of [
  { rate: 20, stopped: false, endMs: 2_000 },
  { rate: 5, stopped: false, endMs: 8_000 },
  { rate: 5, stopped: true, endMs: 20_000 },
]) test(`removed water waits for 40 server ticks at ${rate} tps or 20 s of a stopped clock (${stopped})`, async () => {
  const { bot, world, clock, server } = wetSite({ "2,64,0": "water", "1,64,1": "water@3" }, rate);
  using _timers = clock.install();
  if (stopped) server.stop();
  bot.physicsEnabled = false; // no client tick comes: only the server's time packets move on
  let result: string | null | undefined;
  const clearing = clearMiningWater(bot, new Vec3(1, 64, 0), async (_bot, position) => {
    const cell = new Vec3(position.x, position.y, position.z);
    world.setCell(cell, "cobblestone");
    return { kind: "placed", block: bot.blockAt(cell)! };
  }, null).then((answer) => (result = answer));

  // The source is plugged at once, the flowing cell stays: the wait is 40 ticks of world age, two time packets.
  await clock.advance(endMs - 50);
  assert.equal(result, undefined, "still waiting for the second time packet");
  assert.equal(bot.blockAt(new Vec3(1, 64, 1))?.name, "water", "flow is given time to drain before plugging it");
  await clock.advance(50);
  await clearing;
  assert.equal(result, null);
  assert.equal(bot.blockAt(new Vec3(1, 64, 1))?.name, "cobblestone");
  assert.equal(bot.blockAt(new Vec3(2, 64, 0))?.name, "cobblestone");
});

test("aborting a drain releases its water stance and lets the next clearing finish", async () => {
  const { bot, world, clock, server } = wetSite({ "2,64,0": "water", "1,64,1": "water@3" }, 5);
  using _timers = clock.install();
  server.stop();
  const abort = new AbortController();
  const place: PlaceIntoCell = async (_bot, position) => {
    const cell = new Vec3(position.x, position.y, position.z);
    world.setCell(cell, "cobblestone");
    return { kind: "placed", block: bot.blockAt(cell)! };
  };
  const clearing = clearMiningWater(bot, new Vec3(1, 64, 0), place, null, abort.signal);
  await clock.advance(100);
  abort.abort(new Error("reflex took the body"));
  await assert.rejects(clearing, /reflex took the body/);
  assert.equal(waterStancesHeld(bot), 0);
  assert.equal(bot.controlState.jump, false);
  assert.equal(await clock.settle(clearMiningWater(bot, new Vec3(1, 64, 0), place, null), 100), null);
});

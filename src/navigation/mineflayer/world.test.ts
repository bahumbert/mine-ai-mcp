import { blockClass, isSwimWater, MineflayerWorldView, observeMineflayerBlock } from "./world.js";
import { WATER_ONLY_BLOCKS } from "../world/deep-water.js";
import { isSolid, isWater } from "../world/block-geometry.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeHarness, createFakeBot } from "../../test-support/fake-bot/index.js";

const { bot: registryBot } = createFakeBot();
const registry = registryBot.registry;
const STONE = registry.blocksByName.stone!.defaultState!;
const DIRT = registry.blocksByName.dirt!.defaultState!;

/**
 * A bot on the shared fake over open air with the cells given and the one column (0, 0) loaded (`MineflayerWorldView`
 * reads a column's cells by their place in it, which for column (0, 0) is the world's own cell). Counts the cell reads
 * that reach the column, and `chunkData` holds the state ids the column answers instead of its own, as a chunk the
 * server sent again would.
 */
function columnBot(cells: Record<string, string>): FakeHarness & { cellReads: () => number; chunkData: Map<string, number> } {
  const harness = createFakeBot({ cells, groundY: null, loadedColumns: [[0, 0]] });
  let cellReads = 0;
  const chunkData = new Map<string, number>();
  const column = harness.world.getColumn(0, 0)!;
  const ownRead = column.getBlockStateId.bind(column);
  column.getBlockStateId = (cell: Vec3) => {
    cellReads += 1;
    return chunkData.get(`${cell.x},${cell.y},${cell.z}`) ?? ownRead(cell);
  };
  return { ...harness, cellReads: () => cellReads, chunkData };
}

const Block = blockClass(registryBot);
/** The real Prismarine block of `name`, in its default state or with these properties. */
const realBlock = (name: string, properties?: Record<string, string | number | boolean>) =>
  properties === undefined
    ? Block.fromStateId(registry.blocksByName[name]!.defaultState!, 0)
    : Block.fromProperties(registry.blocksByName[name]!.id, properties as Record<string, string | number>, 0);

test("both growing and terminal Nether vine blocks are climbable", () => {
  for (const name of ["weeping_vines", "weeping_vines_plant", "twisting_vines", "twisting_vines_plant"]) {
    assert.equal(observeMineflayerBlock(realBlock(name)).traits.climbable, true, name);
  }
});

test("a cell is read from Prismarine once, and equal cells share one observation", () => {
  const { bot, cellReads } = columnBot({ "4,63,2": "stone", "1,63,1": "stone", "2,63,1": "stone" });
  const world = new MineflayerWorldView(bot);

  const stone = world.blockAt(4, 63, 2);
  assert.equal(stone.kind, "loaded");
  if (stone.kind === "loaded") assert.equal(stone.stateId, STONE);
  assert.equal(cellReads(), 1);
  world.blockAt(4, 63, 2);
  assert.equal(cellReads(), 1, "the second answer comes from the store");

  const air = world.blockAt(5, 63, 2);
  assert.equal(air.kind === "loaded" && air.stateId, 0);
  assert.equal(cellReads(), 2);
  assert.equal(world.blockAt(40, 63, 2).kind, "unloaded");
  assert.equal(world.blockAt(1, 63, 1), world.blockAt(2, 63, 1), "cells holding the same state are one observation");
  world.close();
});

test("a block update rewrites its stored cell and publishes the change; a column reload drops the section", () => {
  const { bot, world: server, cellReads, chunkData } = columnBot({ "4,63,2": "stone" });
  const world = new MineflayerWorldView(bot);
  const changes: number[] = [];
  world.subscribe((change) => changes.push(change.after.kind === "loaded" ? change.after.stateId : -1));
  world.blockAt(4, 63, 2);

  server.setCell(new Vec3(4, 63, 2), "dirt");

  const changed = world.blockAt(4, 63, 2);
  assert.equal(changed.kind === "loaded" && changed.stateId, DIRT);
  assert.deepEqual(changes, [DIRT]);
  assert.equal(world.revision, 1);
  assert.equal(cellReads(), 1, "an update carries its own state; the column is not read again");

  // A reload replaces the section wholesale, so the next read goes back to it.
  chunkData.set("4,63,2", STONE);
  // The server sending the chunk again: the fake world has no chunk packets, so the test emits Mineflayer's event.
  bot.emit("chunkColumnLoad", new Vec3(0, 0, 0));
  const reloaded = world.blockAt(4, 63, 2);
  assert.equal(reloaded.kind === "loaded" && reloaded.stateId, STONE);
  assert.equal(cellReads(), 2);

  world.close();
  assert.equal(bot.listenerCount("blockUpdate"), 0);
});

test("block traits are read from Prismarine's own property strings", () => {
  // Prismarine reports the water level as a string, so a numeric comparison
  // would never recognise a source block.
  const water = observeMineflayerBlock(realBlock("water", { level: 0 }));
  assert.equal(water.traits.liquidSource, true);

  // Both halves of a door resolve to one activation group, so opening either
  // names the same passage.
  const upper = observeMineflayerBlock(realBlock("oak_door", { half: "upper", open: false }));
  assert.equal(upper.traits.activationGroup, "oak_door");
  assert.equal(upper.traits.upperHalf, true);
  assert.equal(upper.traits.openable, true);
});

test("every water-only plant is source water with no collision, and stays breakable", () => {
  for (const name of WATER_ONLY_BLOCKS) {
    const observation = observeMineflayerBlock(realBlock(name));
    assert.equal(observation.collisionShapes.length, 0, name);
    assert.equal(observation.traits.liquid, "water", name);
    assert.equal(observation.traits.liquidSource, true, name);
    assert.equal(observation.traits.waterlogged, false, name);
    assert.equal(observation.traits.safeToBreak, true, name);
    assert.equal(isWater(observation), true, name);
  }
});

test("a waterlogged block with no collision box is source water, while a waterlogged stair stays a solid holding water", () => {
  const lichen = observeMineflayerBlock(realBlock("glow_lichen", { waterlogged: true }));
  assert.equal(lichen.traits.liquid, "water");
  assert.equal(lichen.traits.liquidSource, true);
  const dryLichen = observeMineflayerBlock(realBlock("glow_lichen", { waterlogged: false }));
  assert.equal(dryLichen.traits.liquid, null);
  const stair = observeMineflayerBlock(realBlock("oak_stairs", { waterlogged: true }));
  assert.equal(stair.traits.liquid, null);
  assert.equal(stair.traits.waterlogged, true);
  assert.equal(isSolid(stair), true);
});

test("the water block's own traits are unchanged: flowing water is water, not a source, not waterlogged", () => {
  const flowing = observeMineflayerBlock(realBlock("water", { level: 3 }));
  assert.equal(flowing.traits.liquid, "water");
  assert.equal(flowing.traits.liquidSource, false);
  assert.equal(flowing.traits.waterlogged, false);
  assert.equal(flowing.traits.safeToBreak, false);
});

test("a bubble column carries a current that drags the body; a water plant does not", () => {
  assert.equal(observeMineflayerBlock(realBlock("bubble_column")).traits.current, true);
  assert.equal(observeMineflayerBlock(realBlock("kelp")).traits.current, false);
});

test("a kelp block is water the body swims in; air and a cell not loaded are not", () => {
  assert.equal(isSwimWater(realBlock("kelp")), true);
  assert.equal(isSwimWater(realBlock("air")), false);
  assert.equal(isSwimWater(null), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { MemoryWorld } from "./memory-world.js";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import { loadNamedBlock } from "../../test-support/layered-world.js";
import { waterMiningStance, waterOccupancy } from "./water.js";

const SOURCE = { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: true, safeToBreak: false } } as const;

/** A one-block puddle at y 60 over stone, air above it up to `roof`, solid at `roof` when given. */
function puddle(roof?: number) {
  const world = new MemoryWorld();
  world.load({ x: 0, y: 59, z: 0 }, { stateId: 1 });
  world.load({ x: 0, y: 60, z: 0 }, SOURCE);
  for (let y = 61; y <= 70; y++) world.load({ x: 0, y, z: 0 }, y === roof ? { stateId: 1 } : { stateId: 0 });
  return world;
}

const stance = (world: MemoryWorld) => waterMiningStance((x, y, z) => world.blockAt(x, y, z), { x: 0, y: 60, z: 0 }, true);

test("a puddle under open air is still-water work", () => {
  assert.equal(stance(puddle()), true);
});

test("a puddle in a roofed pocket is not: the sea behind a mined wall would seal the bot in", () => {
  assert.equal(stance(puddle(63)), false);
  assert.equal(stance(puddle(70)), false);
});

const registryBot = { registry: minecraftData("1.21.4") } as Pick<Bot, "registry">;

/** One column at x 0 z 0: a dirt floor at y 59, then `cells` upward from y 60 (block names), open air above them to y 75. */
function column(cells: readonly string[]): MemoryWorld {
  const world = new MemoryWorld();
  loadNamedBlock(world, registryBot, { x: 0, y: 59, z: 0 }, "dirt");
  for (let y = 60; y <= 75; y++) loadNamedBlock(world, registryBot, { x: 0, y, z: 0 }, cells[y - 60] ?? "air");
  return world;
}

test("a bot in a kelp column over the seabed is submerged, not unavailable", () => {
  const world = column(["kelp_plant", "kelp_plant", "kelp_plant", "kelp"]);
  assert.equal(waterOccupancy((x, y, z) => world.blockAt(x, y, z), 0, 60, 0), "submerged");
});

test("still-water work counts with the feet in a seagrass cell under open sky", () => {
  const world = column(["seagrass"]);
  assert.equal(waterMiningStance((x, y, z) => world.blockAt(x, y, z), { x: 0, y: 60, z: 0 }, true), true);
});

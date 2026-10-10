import assert from "node:assert/strict";
import test from "node:test";
import { MemoryWorld } from "./memory-world.js";
import { waterMiningStance } from "./water.js";

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

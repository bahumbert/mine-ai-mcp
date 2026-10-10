import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { WELL_FED, observation, planningStart } from "../../test-support/navigation.js";
import { exactBlockGoal } from "../goals/index.js";
import { createMovementCatalogue } from "../movements/catalogue.js";
import { MemoryWorld } from "../world/memory-world.js";
import { IncrementalSearch } from "./search.js";
import { createMovements } from "../runtime.js";
import { blockClass, observeMineflayerBlock } from "../mineflayer/world.js";
import { botFixture, registry } from "../../test-support/bot.js";
import { Vec3 } from "vec3";

interface Dump {
  x0: number;
  layers: { y: number; rows: { z: number; blocks: string }[] }[];
}


/**
 * The real blocks around Sana's escape area (live 2026-10-10): her `view_blocks` boxes (y 55-61) agree cell for cell
 * with the world backup this fixture was read from, which also holds the sea surface (water to y 62) and the shore
 * above it that the boxes stop short of.
 */
function sanaArea(bot: ReturnType<typeof sanaBot>): MemoryWorld {
  const dump: Dump = JSON.parse(readFileSync(new URL("./fixtures/sana-area.json", import.meta.url), "utf8"));
  const world = new MemoryWorld();
  const Block = blockClass(bot);
  for (const layer of dump.layers)
    for (const row of layer.rows)
      row.blocks.split(" ").forEach((name, i) => {
        const block = observeMineflayerBlock(Block.fromStateId(registry.blocksByName[name]!.defaultState, 0));
        if (block.kind !== "loaded") throw new Error(name);
        world.load({ x: dump.x0 + i, y: layer.y, z: row.z }, { stateId: block.stateId, collisionShapes: block.collisionShapes, traits: block.traits });
      });
  return world;
}

/** Sana as the status read: at her real position, with 171 dirt and a stone pickaxe. */
function sanaBot() {
  return botFixture({
    position: new Vec3(-652.7, 54.2, -80.46),
    items: [{ name: "dirt", count: 171 }, { name: "stone_pickaxe", count: 1 }],
  });
}

const SANA = { x: -653, y: 54, z: -81 };

function route(start: { x: number; y: number; z: number }, goalCell: { x: number; y: number; z: number }) {
  const bot = sanaBot();
  bot.entity.position = new Vec3(start.x + 0.5, start.y, start.z + 0.5);
  const goal = exactBlockGoal(goalCell).resolve(observation(start.x, start.y, start.z));
  if (goal.kind !== "active") throw new Error(goal.observation);
  return new IncrementalSearch({
    id: "sana", start: planningStart(start, 171), goal, now: () => 0,
    context: {
      world: sanaArea(bot),
      policy: { ...createMovements(bot), dive: { origin: start, airTicks: 300 } },
      player: WELL_FED, catalogue: createMovementCatalogue(),
    },
  }).advance({ maximumExpansions: 200_000, maximumMilliseconds: 10_000 });
}

test("Sana, in her one-wide pocket on the sea floor, plans her way out to the nearest shore ledge", () => {
  const update = route(SANA, { x: -638, y: 64, z: -74 });
  assert.ok(update.kind === "complete" || update.kind === "segment_ready", JSON.stringify(update).slice(0, 500));
});

/** A stone floor at y 58, a wading shelf (water at y 59 only) for x 0-4 and deep open water (y 59-61) from x 5 east. */
function shelfAndSea(bot: ReturnType<typeof sanaBot>): MemoryWorld {
  const world = new MemoryWorld();
  const Block = blockClass(bot);
  const put = (x: number, y: number, z: number, name: string) => {
    const block = observeMineflayerBlock(Block.fromStateId(registry.blocksByName[name]!.defaultState, 0));
    if (block.kind !== "loaded") throw new Error(name);
    world.load({ x, y, z }, { stateId: block.stateId, collisionShapes: block.collisionShapes, traits: block.traits });
  };
  for (let x = -3; x <= 24; x++) for (let z = -8; z <= 8; z++) for (let y = 58; y <= 64; y++)
    put(x, y, z, y === 58 ? "stone" : (x === 22 && ((Math.abs(z) === 1 && y >= 59) || (z === 0 && y === 62))) ? "stone" : x >= 0 && (y === 59 || (x >= 5 && y <= 61)) ? "water" : "air");
  return world;
}

function stepIntoSea(standing: { x: number; y: number; z: number }) {
  const bot = sanaBot();
  bot.entity.position = new Vec3(standing.x + 0.5, standing.y, standing.z + 0.5);
  return createMovements(bot).decideStep(10, 61, 0, shelfAndSea(bot));
}

test("a bot dry on the bank is refused the first step into deep open water", () => {
  assert.equal(stepIntoSea({ x: -1, y: 59, z: 0 }).kind, "prohibited");
});

test("a bot wading with its head dry is refused deep open water", () => {
  assert.equal(stepIntoSea({ x: 3, y: 59, z: 0 }).kind, "prohibited");
});

test("a bot submerged in a one-wide pocket may step on into deep open water", () => {
  assert.equal(stepIntoSea({ x: 22, y: 60, z: 0 }).kind, "allowed");
});

/**
 * A 2-deep channel (water y 59-60, air above) at x 0-4 beside deep open water (y 59-61) from x 5 east, over a stone
 * floor at y 58; `roofAt` puts one stone block over the water column at that x (live 2026-10-10 run 7: a river mouth).
 */
function channelAndSea(bot: ReturnType<typeof sanaBot>, roofAt?: number): MemoryWorld {
  const world = new MemoryWorld();
  const Block = blockClass(bot);
  const put = (x: number, y: number, z: number, name: string) => {
    const block = observeMineflayerBlock(Block.fromStateId(registry.blocksByName[name]!.defaultState, 0));
    if (block.kind !== "loaded") throw new Error(name);
    world.load({ x, y, z }, { stateId: block.stateId, collisionShapes: block.collisionShapes, traits: block.traits });
  };
  for (let x = -3; x <= 24; x++) for (let z = -8; z <= 8; z++) for (let y = 58; y <= 64; y++) {
    const water = x >= 0 && ((x >= 5 && y <= 61 && y >= 59) || (y === 59 || y === 60));
    put(x, y, z, y === 58 ? "stone" : x === roofAt && z === 0 && y === 61 ? "stone" : water ? "water" : "air");
  }
  return world;
}

function stepIntoSeaFromChannel(roofAt?: number) {
  const bot = sanaBot();
  bot.entity.position = new Vec3(4.5, 59, 0.5);
  return createMovements(bot).decideStep(10, 61, 0, channelAndSea(bot, roofAt));
}

test("a bot swimming in an open channel is refused deep open water (a river mouth is not the sea)", () => {
  assert.equal(stepIntoSeaFromChannel().kind, "prohibited");
});

test("the same swimming bot under a solid roof may step on into deep open water", () => {
  assert.equal(stepIntoSeaFromChannel(4).kind, "allowed");
});

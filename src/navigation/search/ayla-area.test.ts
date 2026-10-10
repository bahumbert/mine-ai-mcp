import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Vec3 } from "vec3";
import { WELL_FED, observation, planningStart } from "../../test-support/navigation.js";
import { exactBlockGoal } from "../goals/index.js";
import { createMovementCatalogue } from "../movements/catalogue.js";
import { createMovements } from "../runtime.js";
import { IncrementalSearch } from "./search.js";
import { botFixture, registry } from "../../test-support/bot.js";
import { blockClass, observeMineflayerBlock } from "../mineflayer/world.js";
import { MemoryWorld } from "../world/memory-world.js";
import { DIVE_BACKSTOP_TICKS, swimAscent } from "../world/swimming.js";

interface Dump { x0: number; layers: { y: number; rows: { z: number; blocks: string }[] }[] }

function aylaArea(bot: ReturnType<typeof aylaBot>): MemoryWorld {
  const dump: Dump = JSON.parse(readFileSync(new URL("./fixtures/ayla-area.json", import.meta.url), "utf8"));
  const world = new MemoryWorld();
  const Block = blockClass(bot);
  for (const layer of dump.layers)
    for (const row of layer.rows)
      row.blocks.split(" ").forEach((cell, i) => {
        const [name, level] = cell.split("@") as [string, string | undefined];
        const state = level === undefined
          ? Block.fromStateId(registry.blocksByName[name]!.defaultState, 0)
          : Block.fromProperties(registry.blocksByName[name]!.id, { level: Number(level) }, 0);
        const block = observeMineflayerBlock(state);
        if (block.kind !== "loaded") throw new Error(name);
        world.load({ x: dump.x0 + i, y: layer.y, z: row.z }, { stateId: block.stateId, collisionShapes: block.collisionShapes, traits: block.traits });
      });
  return world;
}

function aylaBot() {
  return botFixture({ position: new Vec3(-1144.5, 69.06, 53.58), items: [{ name: "dirt", count: 16 }] });
}

/** The cell Ayla stood in at the top of her stream (live 2026-10-10): the logged explore stops all say -1146 73 48. */
const STREAM_TOP = { x: -1146, y: 73, z: 48 };

test("Ayla, in a thin flowing stream with air round her head, is a few strokes from a breath, not a swim to the sky", () => {
  const world = aylaArea(aylaBot());
  const ascent = swimAscent((x, y, z) => world.blockAt(x, y, z), STREAM_TOP);
  assert.ok(ascent, "an ascent exists");
  assert.ok(ascent.ticks + DIVE_BACKSTOP_TICKS < 300, `the breath backstop (${ascent.ticks + DIVE_BACKSTOP_TICKS}) must stay under full air`);
  assert.ok(ascent.ticks <= 100, `${ascent.ticks} ticks`);
});

test("Ayla, standing in the stream with a full breath, is admitted a route out to the lake shore", () => {
  const bot = aylaBot();
  bot.entity.position = new Vec3(STREAM_TOP.x + 0.5, STREAM_TOP.y, STREAM_TOP.z + 0.5);
  const goal = exactBlockGoal({ x: -1136, y: 63, z: 61 }).resolve(observation(STREAM_TOP.x, STREAM_TOP.y, STREAM_TOP.z));
  if (goal.kind !== "active") throw new Error(goal.observation);
  const update = new IncrementalSearch({
    id: "ayla", start: planningStart(STREAM_TOP, 16), goal, now: () => 0,
    context: {
      world: aylaArea(bot),
      policy: { ...createMovements(bot), dive: { origin: STREAM_TOP, airTicks: 300 } },
      player: WELL_FED, catalogue: createMovementCatalogue(),
    },
  }).advance({ maximumExpansions: 200_000, maximumMilliseconds: 10_000 });
  assert.ok(update.kind === "complete" || update.kind === "segment_ready", JSON.stringify(update).slice(0, 500));
});

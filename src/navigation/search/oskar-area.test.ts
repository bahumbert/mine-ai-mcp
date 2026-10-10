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
import { createNavigator } from "../orchestration/navigator.js";
import { FakeNavigationBot, onEvent, settle } from "../../test-support/navigation.js";
import { MemoryWorld } from "../world/memory-world.js";

interface Dump { x0: number; layers: { y: number; rows: { z: number; blocks: string }[] }[] }

function oskarArea(bot: ReturnType<typeof oskarBot>): MemoryWorld {
  const dump: Dump = JSON.parse(readFileSync(new URL("./fixtures/oskar-area.json", import.meta.url), "utf8"));
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

function oskarBot() {
  return botFixture({ position: new Vec3(-969.5, 5, 257.5), items: [{ name: "dirt", count: 16 }] });
}

/** The cell Oskar sat in for 30 minutes at the end of a cave water flow (live 2026-10-10 run 7). */
const FLOW_END = { x: -970, y: 5, z: 257 };

function search(goalCell: { x: number; y: number; z: number }) {
  const bot = oskarBot();
  const goal = exactBlockGoal(goalCell).resolve(observation(FLOW_END.x, FLOW_END.y, FLOW_END.z));
  if (goal.kind !== "active") throw new Error(goal.observation);
  return new IncrementalSearch({
    id: "oskar", start: planningStart(FLOW_END, 16), goal, now: () => 0,
    context: { world: oskarArea(bot), policy: createMovements(bot), player: WELL_FED, catalogue: createMovementCatalogue() },
  }).advance({ maximumExpansions: 200_000, maximumMilliseconds: 10_000 });
}

test("Oskar, at the end of a one-block cave flow, is admitted a step up onto the ledge beside it", () => {
  const update = search({ x: -969, y: 6, z: 257 });
  assert.equal(update.kind, "complete");
  if (update.kind !== "complete") return;
  assert.equal(update.plan.steps[0]?.kind, "step_up");
});

test("Oskar, hopping in the flow while his route is searched, still gets one committed instead of planning_stalled", async () => {
  const bot = new FakeNavigationBot();
  const hop = (airborne: boolean) => ({
    ...observation(FLOW_END.x, FLOW_END.y, FLOW_END.z),
    position: { x: FLOW_END.x + 0.5, y: airborne ? 6.4 : 5, z: FLOW_END.z + 0.5 },
    stance: airborne ? "airborne" as const : "supported" as const,
  });
  bot.current = hop(false);
  let slices = 0;
  const navigator = createNavigator({
    world: oskarArea(oskarBot()), bot,
    telemetry: onEvent((event) => {
      if (event.kind === "search_slice") bot.current = hop(Math.floor(++slices / 20) % 2 === 1);
    }),
  });
  const outcome = await settle(navigator, { goal: exactBlockGoal({ x: -969, y: 6, z: 257 }), policy: createMovements(oskarBot()) });
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome).slice(0, 400));
});

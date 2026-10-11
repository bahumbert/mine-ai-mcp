import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Vec3 } from "vec3";
import { FakeNavigationBot, WELL_FED, observation, onEvent, planningStart, settle } from "../../test-support/navigation.js";
import { createNavigator } from "../orchestration/navigator.js";
import type { NavigationEvent } from "../telemetry/index.js";
import { setProtectedRegionsProvider, type ProtectedRegion } from "../../world/protected-regions.js";
import { customGoal, exactBlockGoal } from "../goals/index.js";
import { createMovementCatalogue } from "../movements/catalogue.js";
import { createMovements } from "../runtime.js";
import { IncrementalSearch } from "./search.js";
import { botFixture, registry } from "../../test-support/bot.js";
import { blockClass, observeMineflayerBlock } from "../mineflayer/world.js";
import { MemoryWorld } from "../world/memory-world.js";

interface Dump { x0: number; layers: { y: number; rows: { z: number; blocks: string }[] }[] }

/** Theo's 3x3 house on 2026-10-11 (improve test), read from the saved world: x 2286-2318, y 64-78, z 480-510. */
function theoArea(bot: ReturnType<typeof theoBot>): MemoryWorld {
  const dump: Dump = JSON.parse(readFileSync(new URL("./fixtures/theo-area.json", import.meta.url), "utf8"));
  const world = new MemoryWorld();
  const Block = blockClass(bot);
  for (const layer of dump.layers)
    for (const row of layer.rows)
      row.blocks.split(" ").forEach((cell, i) => {
        const [name, properties] = cell.split("@") as [string, string | undefined];
        const state = properties === undefined
          ? Block.fromStateId(registry.blocksByName[name]!.defaultState, 0)
          : Block.fromProperties(registry.blocksByName[name]!.id, Object.fromEntries(properties.split(",").map((pair) => {
              const [key, value] = pair.split("=") as [string, string];
              return [key, value === "true" ? true : value === "false" ? false : /^\d+$/.test(value) ? Number(value) : value];
            })) as never, 0);
        const block = observeMineflayerBlock(state);
        if (block.kind !== "loaded") throw new Error(name);
        world.load({ x: dump.x0 + i, y: layer.y, z: row.z }, { stateId: block.stateId, collisionShapes: block.collisionShapes, traits: block.traits });
      });
  return world;
}

const REGIONS: readonly ProtectedRegion[] = [
  { regionId: 1, dimension: "overworld", min: { x: 2307, y: 68, z: 496 }, max: { x: 2315, y: 75, z: 504 }, owner: "Theo", label: "small medieval house" },
  { regionId: 2, dimension: "overworld", min: { x: 2303, y: 62, z: 492 }, max: { x: 2319, y: 85, z: 508 }, owner: "Theo", label: "leveling 9x9" },
  { regionId: 3, dimension: "overworld", min: { x: 2307, y: 68, z: 487 }, max: { x: 2315, y: 75, z: 495 }, owner: "Theo", label: "small medieval house" },
  { regionId: 4, dimension: "overworld", min: { x: 2298, y: 68, z: 491 }, max: { x: 2306, y: 75, z: 499 }, owner: "Theo", label: "small medieval house" },
  { regionId: 5, dimension: "overworld", min: { x: 2303, y: 62, z: 490 }, max: { x: 2319, y: 78, z: 506 }, owner: "Tester", label: "improve_house" },
];

function theoBot(regions: readonly ProtectedRegion[]) {
  const bot = botFixture({ username: "Theo", position: new Vec3(2302.47, 70, 494.5), items: [{ name: "dirt", count: 124 }] });
  setProtectedRegionsProvider(bot as never, () => regions);
  return bot;
}

const START = { x: 2302, y: 70, z: 494 };

function search(regions: readonly ProtectedRegion[], options?: Parameters<typeof createMovements>[1], clearOfToss?: { x: number; z: number }) {
  const goalCell = { x: 2296, y: 69, z: 486 };
  const bot = theoBot(regions);
  const target = clearOfToss === undefined ? exactBlockGoal(goalCell) : customGoal("clear-of-toss", (node) => Math.hypot(node.feet.x + 0.5 - clearOfToss.x, node.feet.z + 0.5 - clearOfToss.z) >= 4, (node) => Math.max(0, 4 - Math.hypot(node.feet.x + 0.5 - clearOfToss.x, node.feet.z + 0.5 - clearOfToss.z)) * 4.6);
  const goal = target.resolve(observation(START.x, START.y, START.z));
  if (goal.kind !== "active") throw new Error(goal.observation);
  return new IncrementalSearch({
    id: "theo", start: planningStart(START, 16), goal, now: () => 0,
    context: { world: theoArea(bot), policy: createMovements(bot, options), player: WELL_FED, catalogue: createMovementCatalogue() },
  }).advance({ maximumExpansions: 200_000, maximumMilliseconds: 10_000 });
}

const found = (update: { kind: string }) => update.kind === "complete" || update.kind === "segment_ready";

test("the same search finds the way out when region #4 does not exist (the region is what shuts Theo in)", () => {
  assert.ok(found(search(REGIONS.filter((region) => region.regionId !== 4))));
});

test("the same search finds the way out when the bot's own regions are open to it", () => {
  assert.ok(found(search(REGIONS, { ignoreRegionsOwnedBy: "Theo" })));
});

test("without region #4 the walk-off reaches 4 blocks from the toss", () => {
  assert.ok(found(search(REGIONS.filter((region) => region.regionId !== 4), undefined, { x: 2302.47, z: 494.5 })));
});

/** One whole navigation from Theo's cell (the fake bot cannot dig or place, so a run that finds a route still fails to walk it). */
async function run(regions: readonly ProtectedRegion[], toss?: boolean, shared?: { bot: ReturnType<typeof theoBot>; policy: ReturnType<typeof createMovements> }) {
  const bot = shared?.bot ?? theoBot(regions);
  const events: NavigationEvent[] = [];
  const fake = new FakeNavigationBot();
  fake.current = observation(START.x, START.y, START.z);
  const navigator = createNavigator({ world: theoArea(bot), bot: fake, telemetry: onEvent((event) => events.push(event)) });
  const goal = toss === true
    ? customGoal("clear-of-toss", (node) => Math.hypot(node.feet.x + 0.5 - 2302.47, node.feet.z + 0.5 - 494.5) >= 4, (node) => Math.max(0, 4 - Math.hypot(node.feet.x + 0.5 - 2302.47, node.feet.z + 0.5 - 494.5)) * 4.6)
    : exactBlockGoal({ x: 2296, y: 69, z: 486 });
  const outcome = await settle(navigator, { goal, policy: shared?.policy ?? createMovements(bot) });
  return { events, outcome };
}

// Live 2026-10-11 (improve test, Theo): every route from 2302 70 494 failed "no path found after 0 ms; visited 13 nodes",
// and drop_item's 4-block walk-off found no cell, so every toss was picked up again. The 3x3 house's door opens onto
// three cells walled at head height by dirt left from the 9x9 build; the only ways out dig or place in region #4,
// Theo's own 'small medieval house'. A bot shut in by its own protection opens it to itself, once.
for (const [name, toss] of [["the route out", false], ["drop_item's walk-off", true]] as const) {
  test(`Theo, shut in by dirt inside his own house region, gets ${name} after opening his own regions once`, async () => {
    const { events, outcome } = await run(REGIONS, toss);
    const opened = events.findIndex((event) => event.kind === "own_regions_opened");
    assert.ok(opened >= 0, "his own regions were opened");
    assert.equal(events.filter((event) => event.kind === "own_regions_opened").length, 1);
    assert.ok(events.slice(opened).some((event) => event.kind === "route_committed"), "a route was found after that");
    void outcome;
  });
}

test("a start in a region another player owns is not opened: the search stays without a route", async () => {
  const others = REGIONS.map((region) => region.regionId === 4 ? { ...region, owner: "Tester" } : region);
  const { events, outcome } = await run(others);
  assert.ok(!events.some((event) => event.kind === "own_regions_opened"));
  assert.ok(!events.some((event) => event.kind === "route_committed"));
  assert.equal(outcome.kind, "failed");
});

test("a start outside every region of the bot does not replan", async () => {
  const { events } = await run(REGIONS.filter((region) => region.regionId !== 4 && region.regionId !== 2 && region.regionId !== 5));
  assert.ok(!events.some((event) => event.kind === "own_regions_opened"));
});

test("the opening lasts one run: the same policy refuses its own regions again afterwards, and a second run opens them again", async () => {
  const bot = theoBot(REGIONS);
  const policy = createMovements(bot);
  const world = theoArea(bot);
  const cell = { x: 2302, y: 71, z: 491 };
  const dirt = world.blockAt(cell.x, cell.y, cell.z);
  const refuses = () => policy.evaluateBreak(dirt, cell, world).decision.kind === "prohibited";
  assert.ok(refuses(), "refused before");
  const first = await run(REGIONS, false, { bot, policy });
  assert.equal(first.events.filter((event) => event.kind === "own_regions_opened").length, 1);
  assert.ok(refuses(), "refused again after the run");
  const second = await run(REGIONS, false, { bot, policy });
  assert.equal(second.events.filter((event) => event.kind === "own_regions_opened").length, 1, "opened again by the second run");
});

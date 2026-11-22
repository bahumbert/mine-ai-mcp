import { DEFAULT_SURVIVAL_POLICY } from "../../policy/contract.js";
import type { NavigationRuntime } from "../../../navigation/index.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { Item } from "prismarine-item";
import { createFakeBot, itemOf } from "../../../test-support/fake-bot/index.js";
import { setProtectedRegionsProvider } from "../../../world/protected-regions.js";
import { buildCrystalStaircase, pillarShortfall, planCrystalStaircase, staircaseShortfall } from "./crystal-staircase.js";

/** Native spike geometry with a damaged column and a cage on the narrow tower. */
function spikeCells(radius: number): Record<string, string> {
  const blocks: Record<string, string> = {};
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) blocks[`${x},60,${z}`] = "end_stone";
  for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++)
    if (x*x+z*z <= radius*radius + 1) for (let y = 55; y < 89; y++) blocks[`${x},${y},${z}`] = "obsidian";
  delete blocks["0,74,0"];
  blocks["0,89,0"] = "bedrock";
  if (radius === 2)
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = 89; y <= 92; y++)
      if (Math.abs(x) === 2 || Math.abs(z) === 2 || y === 92) blocks[`${x},${y},${z}`] = "iron_bars";
  return blocks;
}

const crystal = new Vec3(0.5, 90, 0.5);

for (const radius of [2, 3, 5]) test(`radius ${radius} staircase preserves its layout after construction and counts only missing treads`, async () => {
  const blocks = spikeCells(radius);
  const { bot, world, inventory } = createFakeBot({ cells: blocks, groundY: null });
  const carry = (count: number) => (inventory.updateSlot as (slot: number, item: Item | null) => void)
    .call(inventory, 36, count > 0 ? itemOf(bot.registry, "end_stone", count) : null);
  const plan = planCrystalStaircase(bot, crystal);
  assert.match(staircaseShortfall(bot, plan)!, /CRYSTAL_STAIRCASE_SHORTFALL.*carrying 0.*Gather at least.*approach "pillar".*about \d+ carried scaffold blocks/);
  assert.equal(plan.pillarBlocks, 88 - 60 - 1, "a pillar from the island surface to the rim's feet level");
  assert.match(pillarShortfall(bot, DEFAULT_SURVIVAL_POLICY, plan)!, /CRYSTAL_PILLAR_SHORTFALL.*about 27 scaffold blocks.*carrying 0/);
  assert.match(pillarShortfall(bot, { ...DEFAULT_SURVIVAL_POLICY, combat: { ...DEFAULT_SURVIVAL_POLICY.combat, terrain: { dig: true, place: false } } }, plan)!, /CRYSTAL_PILLAR_CONSTRAINED/);
  carry(27);
  assert.equal(pillarShortfall(bot, DEFAULT_SURVIVAL_POLICY, plan), null);
  carry(0);
  assert.equal(plan.cells.some(cell => cell.blockName === "air" && cell.position.x === 0 && cell.position.z === 0), false, "never excavate the blast-cover pedestal column");
  assert.equal(plan.cells.some(cell => cell.blockName === "air" && bot.blockAt(new Vec3(cell.position.x, cell.position.y, cell.position.z))?.name === "obsidian"), false,
    "the tower is never mined");
  const planned = new Set(plan.cells.map(cell => `${cell.position.x},${cell.position.y},${cell.position.z}`));
  const expectedTower = Object.keys(blocks).filter(key => {
    const [, y] = key.split(",").map(Number);
    return blocks[key] === "obsidian" && y! >= 56 && y! <= 88 && !planned.has(key);
  });
  const tower = plan.tower.map(({ x, y, z }) => `${x},${y},${z}`);
  assert.equal(tower.length, expectedTower.length, "protect the full observed column, including four layers below the island");
  assert.deepEqual(tower.sort(), expectedTower.sort(), "skip the damaged cell, cage, and plan cells");
  const bounds = (pick: (values: number[]) => number, delta: number) => new Vec3(
    ...(["x", "y", "z"] as const).map(axis => pick(plan.cells.map(cell => cell.position[axis])) + delta) as [number, number, number],
  );
  assert.deepEqual(plan.box, { min: bounds(values => Math.min(...values), -4), max: bounds(values => Math.max(...values), 4) });
  const firstTread = plan.cells[0]!.position;
  assert.deepEqual(plan.foot, new Vec3(firstTread.x, firstTread.y + 1, firstTread.z));
  if (radius <= 3) {
    // The rim one below the pedestal's top face is within reach: full cover, feet outside the top layer.
    assert.deepEqual(plan.stance, new Vec3(2, 88, -radius));
    assert.equal(plan.covered, true);
    assert.equal(bot.blockAt(plan.stance)?.name, "air");
  } else {
    // Out of reach from the rim: swing from the top layer's far diagonal, standing on native obsidian.
    assert.deepEqual(plan.stance, new Vec3(3, 89, -3));
    assert.equal(plan.covered, false);
    assert.equal(bot.blockAt(plan.stance.offset(0, -1, 0))?.name, "obsidian");
    assert.equal(plan.cells.some(cell => cell.position.y >= 89 && cell.blockName !== "air" && (cell.position.x !== 0 || cell.position.z !== 0)), false,
      "nothing is built on the top layer; only head clearance and the retained pedestal are recorded there");
  }
  assert.equal(plan.cells.filter(cell => cell.blockName === "air" && bot.blockAt(new Vec3(cell.position.x, cell.position.y, cell.position.z))?.name === "iron_bars").length, radius === 2 ? 1 : 0,
    "open only the corner bar needed for standing clearance on a caged tower");
  let wallTreads = 0, cornerSupports = 0;
  for (const cell of plan.cells.filter(cell => cell.blockName === "end_stone" && cell.position.y > 60)) {
    const position = new Vec3(cell.position.x, cell.position.y, cell.position.z);
    const below = plan.cells.find(other => position.offset(0, -1, 0).equals(new Vec3(other.position.x, other.position.y, other.position.z)));
    const above = plan.cells.find(other => position.offset(0, 1, 0).equals(new Vec3(other.position.x, other.position.y, other.position.z)));
    const againstWall = [position.offset(1, 0, 0), position.offset(-1, 0, 0), position.offset(0, 0, 1), position.offset(0, 0, -1)]
      .some(neighbor => bot.blockAt(neighbor)?.name === "obsidian");
    if (againstWall && above?.blockName === "air") {
      wallTreads++;
      assert.equal(below, undefined, "wall-attached treads need no lower support");
    }
    if (above?.blockName === "end_stone") cornerSupports++;
  }
  assert.ok(wallTreads > 0 && cornerSupports > 0, "exercise both wall attachment and supported corners");
  for (const cell of plan.cells) world.setCell(new Vec3(cell.position.x, cell.position.y, cell.position.z), cell.blockName);
  assert.equal(staircaseShortfall(bot, plan), null);
  assert.equal(await buildCrystalStaircase(bot, {} as NavigationRuntime, { ...DEFAULT_SURVIVAL_POLICY,
    combat: { ...DEFAULT_SURVIVAL_POLICY.combat, terrain: { dig: false, place: false } },
  }, plan, new AbortController().signal), null, "existing stairs need no placement permission or route work");
  const rebuilt = planCrystalStaircase(bot, crystal);
  assert.deepEqual(rebuilt, plan, "a new crystal request must regenerate the same layout");
  for (const cell of plan.cells.filter(cell => cell.blockName === "end_stone").slice(-2))
    world.setCell(new Vec3(cell.position.x, cell.position.y, cell.position.z), "air");
  assert.match(staircaseShortfall(bot, rebuilt)!, /2 end_stone blocks still needed; carrying 0/);
  carry(2);
  assert.equal(staircaseShortfall(bot, rebuilt), null);
});

/** Protected regions at the staircase's treads (plan 2026-11-07-p4-06a-threat T5b, ADR-012): the placement core refuses a tread inside another's region. */
function oneTreadPlan(owner: string | "own") {
  const harness = createFakeBot({ position: new Vec3(0.5, 64, 0.5), carried: { end_stone: 4 }, cells: { "1,63,0": "end_stone" } });
  const regionOwner = owner === "own" ? harness.bot.username : owner;
  setProtectedRegionsProvider(harness.bot, () => [
    { regionId: 12, dimension: "overworld", owner: regionOwner, label: "Tom's tower", min: { x: 1, y: 64, z: 0 }, max: { x: 1, y: 64, z: 0 } },
  ]);
  const plan = {
    cells: [{ position: { x: 1, y: 64, z: 0 }, blockName: "end_stone" }],
    stance: new Vec3(1, 65, 0), covered: false, pedestal: new Vec3(0, 70, 0), tower: [], pillarBlocks: 0,
    box: { min: new Vec3(-3, 60, -4), max: new Vec3(5, 68, 4) }, foot: new Vec3(1, 65, 0),
  };
  return { ...harness, plan };
}

test("a tread inside another owner's region is not built: the build names the region and sends no placement", async () => {
  const { bot, clock, server, plan } = oneTreadPlan("Tom");
  const result = await clock.settle(buildCrystalStaircase(bot, {} as NavigationRuntime, DEFAULT_SURVIVAL_POLICY, plan, new AbortController().signal), 30_000);
  assert.match(result ?? "", /CRYSTAL_STAIRCASE_INCOMPLETE/);
  assert.ok(result?.includes("(owner Tom)"), String(result));
  assert.equal(server.packets.filter((packet) => packet.name === "block_place").length, 0);
  assert.equal(bot.blockAt(new Vec3(1, 64, 0))?.name, "air");
});

for (const replacement of ["air", "iron_bars"]) {
  test(`the staircase refuses a native tower with ${replacement} in its surveyed core`, () => {
    const blocks = spikeCells(2);
    blocks["0,86,0"] = replacement;
    const { bot } = createFakeBot({ cells: blocks, groundY: null });
    assert.throws(() => planCrystalStaircase(bot, crystal), /CRYSTAL_TOWER_UNSUPPORTED.*native full-block core/);
  });
}

test("a tread inside the bot's own region is built", async () => {
  const { bot, clock, plan } = oneTreadPlan("own");
  const result = await clock.settle(buildCrystalStaircase(bot, {} as NavigationRuntime, DEFAULT_SURVIVAL_POLICY, plan, new AbortController().signal), 30_000);
  assert.equal(result, null);
  assert.equal(bot.blockAt(new Vec3(1, 64, 0))?.name, "end_stone");
});

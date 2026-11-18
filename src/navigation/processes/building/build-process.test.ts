import { MemoryWorld as GoalTestWorld } from "../../world/memory-world.js";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { Vec3 } from "vec3";
import { packKey } from "../../index.js";
import { structureWorld } from "../../../test-support/structure-world.js";
import { createFakeClock, itemOf } from "../../../test-support/fake-bot/index.js";
import { build, BuildProgress, BuildTargeting, enclosesBot, holdsCell, type BuildCell, type BuildRequest, type BuildResult } from "./build-process.js";
import { observation } from "../../../test-support/navigation.js";

const goalTestWorld = new GoalTestWorld();

function cells(list: [number, number, number][], blockName = "cobblestone"): BuildCell[] {
  return list.map(([x, y, z]) => ({ position: { x, y, z }, blockName }));
}

function kinds(result: BuildResult): string[] {
  return result.cells.map(({ state }) => state.kind);
}

/** The shell of a 3×3×3 hollow box whose interior is the bot's own cell column. */
function hollowBox(): [number, number, number][] {
  const shell: [number, number, number][] = [];
  for (let x = 0; x <= 2; x += 1)
    for (let y = 64; y <= 66; y += 1)
      for (let z = 0; z <= 2; z += 1) if (!(x === 1 && z === 1 && y <= 65)) shell.push([x, y, z]);
  return shell;
}

test("places supported cells lowest first from where it stands, and the top row only once its supports exist", async () => {
  const { bot, physics, placements, routes } = structureWorld();
  // A 2-wide, 3-tall pillar pair with a lintel: the lintel needs the pillars first.
  const structure = cells([
    [2, 66, 0],
    [3, 66, 0],
    [2, 64, 0],
    [2, 65, 0],
    [3, 64, 0],
    [3, 65, 0],
  ]);
  const result = await build(bot, { ...physics, cells: structure, removeWrongBlocks: false });

  assert.equal(result.status, "complete");
  assert.deepEqual(placements.slice(0, 2).sort(), ["2,64,0", "3,64,0"]);
  assert.deepEqual(placements.slice(-2).sort(), ["2,66,0", "3,66,0"]);
  assert.deepEqual(routes, [], "everything was within reach");
  assert.equal(result.placed, 6);
});

test("reach, not distance, decides which cells are walked to", async () => {
  for (const row of [
    {
      name: "a cell exactly a reach away is placed where the bot stands, as a route would report it already reached",
      cell: [4, 64, 0] as [number, number, number],
      world: {},
      routes: 0,
    },
    {
      name: "a cell not loaded yet is walked to, and placed once it is",
      cell: [30, 64, 0] as [number, number, number],
      world: { loadedRadius: 8 },
      routes: 1,
    },
  ]) {
    const { bot, physics, routes, placements } = structureWorld(row.world);
    const result = await build(bot, { ...physics, cells: cells([row.cell]), removeWrongBlocks: false });
    assert.equal(result.status, "complete", row.name);
    assert.equal(routes.length, row.routes, row.name);
    assert.deepEqual(placements, [row.cell.join(",")], row.name);
  }
});

test("a cell 6 above the feet, straight up, is placed from where the bot stands: the reach is the eye's, not the feet's", async () => {
  const { bot, physics, routes, placements, put } = structureWorld();
  put(new Vec3(0, 69, 0), "stone");
  const result = await build(bot, { ...physics, cells: cells([[0, 70, 0]]), removeWrongBlocks: false });
  assert.equal(result.status, "complete");
  assert.deepEqual(routes, [], "4.38 from the eye, 4.5 allowed");
  assert.deepEqual(placements, ["0,70,0"]);
});

/** What the build asks its route for, with the goal's answers for the given feet cells; the route then stops. */
async function goalOfTheFirstRoute(world: ReturnType<typeof structureWorld>, request: Pick<BuildRequest, "cells">, feet: [number, number, number][]) {
  let revision = "";
  const satisfied: boolean[] = [];
  await build(world.bot, {
    ...world.physics,
    ...request,
    removeWrongBlocks: false,
    route: async ({ goal }) => {
      const resolved = goal.resolve(observation(0, 64, 0));
      if (resolved.kind === "active") {
        revision = resolved.revision;
        for (const [x, y, z] of feet) satisfied.push(resolved.isSatisfied({ feet: { x, y, z }, remainingScaffolds: 0, overlayId: "" }, goalTestWorld));
      }
      return { status: "stopped", reason: "the test only reads the goal", elapsedMs: 0 };
    },
  });
  return { revision, satisfied };
}

test("a cell 7 above the feet is out of reach from the ground: the route's goal is the top of a column one block high, not the cell", async () => {
  const world = structureWorld();
  world.put(new Vec3(0, 70, 0), "stone");
  const { revision, satisfied } = await goalOfTheFirstRoute(world, { cells: cells([[0, 71, 0]]) }, [[0, 65, 0], [0, 64, 0], [1, 65, 0], [0, 66, 0]]);
  assert.equal(revision, "any(block:0,65,0)", "the nearest column of those that serve it from the lowest feet");
  assert.deepEqual(satisfied, [true, false, false, false], "on the column's top; nothing else (the pillar goes up exactly that far)");
});

test("a stand column never stands in a cell the request puts a block in", async () => {
  const world = structureWorld();
  world.put(new Vec3(0, 70, 0), "stone");
  // The structure's own block lies in the nearest column's head room, (0,66,0): that column is not one.
  const { revision } = await goalOfTheFirstRoute(world, { cells: cells([[0, 71, 0], [0, 66, 0]]) }, []);
  assert.doesNotMatch(revision, /block:0,65,0/);
  assert.match(revision, /block:-?\d+,65,-?\d+/, "another column, still one high");
});

test("a cell within reach from the ground keeps its own goal, reached from the eye", async () => {
  const world = structureWorld();
  world.put(new Vec3(8, 69, 0), "stone");
  const { revision, satisfied } = await goalOfTheFirstRoute(world, { cells: cells([[8, 70, 0]]) }, [[8, 64, 0], [0, 64, 0]]);
  assert.equal(revision, "any(reach:8,70,0:4.5)");
  assert.deepEqual(satisfied, [true, false]);
});

test("a column under a ceiling is not one: the world's solid blocks stop it, and a cell no column serves keeps its own goal", async () => {
  const world = structureWorld();
  world.put(new Vec3(0, 70, 0), "stone");
  // A solid slab over every column the window offers, 2 above the feet: no pillar has head room.
  for (let x = -12; x <= 12; x += 1) for (let z = -12; z <= 12; z += 1) world.put(new Vec3(x, 66, z), "stone");
  const { revision } = await goalOfTheFirstRoute(world, { cells: cells([[0, 71, 0]]) }, []);
  assert.equal(revision, "any(reach:0,71,0:4.5)");
});

/** The route goal's revision a fresh look at the world gives with the bot's feet over the given x (z 0); the run's own search reads it so. */
function revisionWithBotAt(world: ReturnType<typeof structureWorld>, targeting: BuildTargeting, x: number): string {
  world.bot.entity.position.set(x + 0.5, 64, 0.5);
  targeting.refresh();
  const resolved = targeting.goal().resolve(observation(0, 64, 0));
  assert.equal(resolved.kind, "active");
  return resolved.kind === "active" ? resolved.revision : "";
}

// Mine Labs 2026-11-17, template-roof-counted-scaffold-saltbox, 2 of 72 runs: the same search (same world revision) from the
// same feet came twice, each route having ended as "goal revised" after a few steps toward columns the other feet did not
// choose, and the run refused the ridge stair as repeated_search.
test("the stand columns do not change while the world does not, wherever the bot stands on the way to them", () => {
  const world = structureWorld();
  world.put(new Vec3(0, 70, 0), "stone");
  const targeting = new BuildTargeting(world.bot, { ...({} as BuildRequest), cells: cells([[0, 71, 0]]), removeWrongBlocks: false });
  const first = revisionWithBotAt(world, targeting, -3);
  assert.equal(revisionWithBotAt(world, targeting, 3), first, "walking toward the column does not pick another one");
  assert.equal(revisionWithBotAt(world, targeting, -3), first);
});

test("a stand column the world has since filled is chosen again, from where the bot stands", () => {
  const world = structureWorld();
  world.put(new Vec3(0, 70, 0), "stone");
  const targeting = new BuildTargeting(world.bot, { ...({} as BuildRequest), cells: cells([[0, 71, 0]]), removeWrongBlocks: false });
  const first = revisionWithBotAt(world, targeting, -3);
  const column = /block:(-?\d+),(-?\d+),(-?\d+)/.exec(first)!;
  world.put(new Vec3(Number(column[1]), Number(column[2]) + 1, Number(column[3])), "stone");
  const second = revisionWithBotAt(world, targeting, -3);
  assert.notEqual(second, first, "the column's head room is solid now");
});

test("walks to cells out of reach under one goal that moves on as cells are placed, protecting the cells already right", async () => {
  const { bot, physics, routes, protectedSets, placements } = structureWorld();
  const result = await build(bot, {
    ...physics,
    cells: cells([
      [10, 64, 0],
      [20, 64, 0],
    ]),
    removeWrongBlocks: false,
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(placements, ["10,64,0", "20,64,0"]);
  assert.equal(routes.length, 2, "one route, two legs: the goal revised itself after the first placement");
  assert.match(routes[0]!, /10,64,0/);
  assert.match(routes[1]!, /^any\(reach:20,64,0:4\.5\)$/, "the second leg names only the cell still wrong");
  assert.equal(protectedSets.length, 1, "one policy for the run, over a live set");
  assert.ok(protectedSets[0]!.has(packKey(10, 64, 0)) && protectedSets[0]!.has(packKey(20, 64, 0)));
});

test("a sealed box is finished from outside: the bot walks out before the last block", async () => {
  const feet = new Vec3(1, 64, 1);
  const { bot, physics, routes } = structureWorld({ feet });
  const shell = hollowBox();
  const result = await build(bot, { ...physics, cells: cells(shell), removeWrongBlocks: false });

  assert.equal(result.status, "complete");
  assert.equal(result.placed, shell.length);
  assert.ok(routes.length >= 1, "the bot had to leave the box");
  const finalFeet = bot.entity.position.floored();
  assert.ok(finalFeet.x < 0 || finalFeet.x > 2 || finalFeet.z < 0 || finalFeet.z > 2, `ended outside, at ${finalFeet}`);
});

test("enclosesBot reads a roofed box as sealed and a doorway as open", () => {
  const { bot, put } = structureWorld({ feet: new Vec3(1, 64, 1) });
  const filled = new Set(hollowBox().map(([x, y, z]) => packKey(x, y, z)));
  const bounds = { min: new Vec3(0, 64, 0), max: new Vec3(2, 66, 2) };
  assert.equal(enclosesBot(bot, new Vec3(1, 64, 1), filled, bounds), true);
  filled.delete(packKey(0, 64, 1));
  filled.delete(packKey(0, 65, 1));
  assert.equal(enclosesBot(bot, new Vec3(1, 64, 1), filled, bounds), false);
  put(new Vec3(-1, 64, 1), "stone");
  put(new Vec3(-1, 65, 1), "stone");
  assert.equal(enclosesBot(bot, new Vec3(1, 64, 1), filled, bounds), true, "a wall beyond the doorway seals it again");
});

/**
 * A cell the run cannot place is named by its own state rather than by a
 * whole-run reason, and the run gives up on it instead of passing over it
 * forever.
 *
 * The unsupported row is the live portal call of 3 September: the two
 * top-middle cells of a frame whose corners were missing, so nothing was beside
 * or below them to place against. The audit said "2 cells still wrong" in 0 ms.
 */
test("a cell that cannot be placed is reported by its own state, and the run stops without spinning", async () => {
  const refusal = "the server did not update the block";
  const refuse: BuildRequest["place"] = async () => ({ kind: "failed", error: refusal });
  const pair: [number, number, number][] = [
    [2, 64, 0],
    [3, 64, 0],
  ];
  const lintel: [number, number, number][] = [
    [2, 67, 0],
    [3, 67, 0],
  ];
  for (const row of [
    {
      name: "not carried",
      world: { carried: { cobblestone: 1 } },
      cells: cells(pair),
      place: null,
      kinds: ["correct", "not_carried"],
      placed: 1,
      stateReason: null,
    },
    {
      name: "nothing to place against",
      world: {},
      cells: cells(lintel, "obsidian"),
      place: null,
      kinds: ["unsupported", "unsupported"],
      placed: 0,
      stateReason: null,
    },
    {
      name: "the server refuses the placement",
      world: {},
      cells: cells(pair),
      place: refuse,
      kinds: ["refused", "refused"],
      placed: 0,
      stateReason: refusal,
    },
  ]) {
    const { bot, physics, placements } = structureWorld(row.world);
    const result = await build(bot, {
      ...physics,
      ...(row.place && { place: row.place }),
      cells: row.cells,
      removeWrongBlocks: false,
    });
    assert.equal(result.status, "stopped", row.name);
    assert.equal(result.reason, null, `${row.name}: the cell states say why`);
    assert.deepEqual(kinds(result), row.kinds, row.name);
    assert.equal(result.placed, row.placed, row.name);
    assert.equal(placements.length, row.placed, row.name);
    assert.ok(result.passes <= 4, `${row.name}: passes ${result.passes}`);
    if (row.stateReason !== null)
      assert.equal((result.cells[0]!.state as { reason: string }).reason, row.stateReason, row.name);
  }
});

/**
 * The live shelter call of 3 September: the upper wall cells held leaves, the
 * request left wrong blocks alone, and the audit said only "4 cells still
 * wrong". The state has to name the block so the next request can ask to dig it.
 */
test("a wrong block is reported by name when left, and dug first when asked", async () => {
  const { bot, put, physics } = structureWorld();
  put(new Vec3(2, 64, 0), "oak_leaves");
  const left = await build(bot, { ...physics, cells: cells([[2, 64, 0]]), removeWrongBlocks: false });
  assert.equal(left.status, "stopped");
  assert.deepEqual(left.cells[0]!.state, { kind: "blocked", holds: "oak_leaves" });

  const replaced = await build(bot, { ...physics, cells: cells([[2, 64, 0]]), removeWrongBlocks: true });
  assert.equal(replaced.status, "complete");
  assert.equal(replaced.dug, 1);
  assert.equal(replaced.placed, 1);
});

/**
 * The live house of 30 September: its door was hung with whatever yaw the bot
 * had, sideways in the wall, and its open panel lay across the doorway.
 */
test("an oriented block is placed looking its way, and the same block facing elsewhere is wrong", async () => {
  const { bot, put, physics, looks } = structureWorld({ carried: { oak_door: 2 } });
  const door: BuildCell = { position: { x: 2, y: 64, z: 0 }, blockName: "oak_door", facing: "south" };
  const placed = await build(bot, { ...physics, cells: [door], removeWrongBlocks: false });
  assert.equal(placed.status, "complete");
  assert.deepEqual(looks, ["south"]);

  put(new Vec3(2, 64, 0), "oak_door", { facing: "east" });
  const left = await build(bot, { ...physics, cells: [door], removeWrongBlocks: false });
  assert.deepEqual(left.cells[0]!.state, { kind: "blocked", holds: "oak_door facing east" });
  const rehung = await build(bot, { ...physics, cells: [door], removeWrongBlocks: true });
  assert.equal(rehung.status, "complete");
  assert.deepEqual(looks, ["south", "south"]);
});

test("a hidden wrong block is approached from a visible stance instead of permanently refused", async () => {
  const { bot, put, physics, routes } = structureWorld({ feet: new Vec3(3, 64, 0) });
  put(new Vec3(2, 64, 0), "oak_leaves");
  const result = await build(bot, {
    ...physics,
    canSeeDig: (_target, standing) => standing.x < 1,
    breakInPlace: async (request) => {
      assert.ok(bot.entity.position.x < 1, "never attempt the hidden dig");
      return physics.breakInPlace(request);
    },
    route: async (request) => {
      const goal = request.goal.resolve(observation());
      assert.equal(goal.kind, "active");
      if (goal.kind === "active") {
        assert.equal(
          goal.isSatisfied({ feet: { x: 3, y: 64, z: 0 }, remainingScaffolds: 0, overlayId: "" }, goalTestWorld),
          false,
        );
        assert.equal(
          goal.isSatisfied({ feet: { x: 0, y: 64, z: 0 }, remainingScaffolds: 0, overlayId: "" }, goalTestWorld),
          true,
        );
      }
      return physics.route(request);
    },
    cells: cells([[2, 64, 0]]),
    removeWrongBlocks: true,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.dug, 1);
  assert.equal(result.placed, 1);
  assert.equal(routes.length, 1);
});

/**
 * The live house of 30 September: the bot stood off the centre of its cell, the
 * dig was visible from that centre but not from where it stood, so the route
 * arrived without moving and the in-reach work saw nothing, twice, and stopped.
 */
test("the bot's own cell is judged from where it stands, not from the cell's centre", async () => {
  const { bot, put, physics } = structureWorld({ feet: new Vec3(3, 64, 0) });
  put(new Vec3(2, 64, 0), "oak_leaves");
  bot.entity.position = new Vec3(3.1, 64, 0.5);
  const fromCentreOnly = (_target: unknown, standing: { x: number }) => standing.x >= 3.4 || standing.x < 1;
  const result = await build(bot, {
    ...physics,
    canSeeDig: fromCentreOnly,
    route: async (request) => {
      const goal = request.goal.resolve({ ...observation(3, 64, 0), position: { x: 3.1, y: 64, z: 0.5 } });
      assert.equal(goal.kind, "active");
      if (goal.kind === "active") {
        assert.equal(
          goal.isSatisfied({ feet: { x: 3, y: 64, z: 0 }, remainingScaffolds: 0, overlayId: "" }, goalTestWorld),
          false,
          "the start cell cannot see the dig from where the bot stands",
        );
      }
      return physics.route(request);
    },
    cells: cells([[2, 64, 0]]),
    removeWrongBlocks: true,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.dug, 1);
});

/**
 * The live portal of 3 September had cobblestone scaffolded up through its
 * interior, which a portal cannot be lit through. A cell asked to be air is
 * dug whether or not wrong blocks may be removed elsewhere, and it is never
 * counted as short of anything.
 */
test("a cell asked to be air is dug clear without being asked to remove wrong blocks", async () => {
  const { bot, put, physics } = structureWorld();
  put(new Vec3(2, 64, 0), "cobblestone");
  put(new Vec3(3, 64, 0), "cobblestone");
  const result = await build(bot, {
    ...physics,
    cells: [...cells([[2, 64, 0]], "air"), ...cells([[3, 64, 0]])],
    removeWrongBlocks: false,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.dug, 1);
  assert.equal(result.placed, 0);
  assert.equal(bot.blockAt(new Vec3(2, 64, 0))!.name, "air");
});

test("a route that cannot reach a cell refuses that cell and carries on with the rest", async () => {
  const { bot, physics, placements } = structureWorld();
  let stopped = false;
  const result = await build(bot, {
    ...physics,
    route: async (options) => {
      if (!stopped) {
        stopped = true;
        return { status: "stopped", reason: "no path; closest node was 5,64,0", elapsedMs: 0 };
      }
      return physics.route(options);
    },
    cells: cells([
      [10, 64, 0],
      [12, 64, 0],
    ]),
    removeWrongBlocks: false,
  });
  assert.equal(result.status, "stopped");
  assert.equal(result.reason, null);
  assert.equal(placements.length, 1, "the other cell was still built");
  assert.ok(kinds(result).includes("refused"));
  assert.ok(kinds(result).includes("correct"));
});

test("a cell asking for block states holds only a block in those states: facing, half (or a slab's type) and axis", () => {
  const { bot, put } = structureWorld();
  const block = (name: string, properties: Record<string, unknown>) => {
    put(new Vec3(0, 64, 0), name, properties);
    return bot.blockAt(new Vec3(0, 64, 0))!;
  };
  const at = { x: 0, y: 64, z: 0 };
  const stairs: BuildCell = { position: at, blockName: "spruce_stairs", facing: "north", half: "bottom" };
  assert.equal(holdsCell(block("spruce_stairs", { facing: "north", half: "bottom", shape: "outer_left" }), stairs), true, "shape is not asked");
  assert.equal(holdsCell(block("spruce_stairs", { facing: "north", half: "top" }), stairs), false);
  assert.equal(holdsCell(block("spruce_stairs", { facing: "east", half: "bottom" }), stairs), false);
  const slab: BuildCell = { position: at, blockName: "spruce_slab", half: "top" };
  assert.equal(holdsCell(block("spruce_slab", { type: "top" }), slab), true);
  assert.equal(holdsCell(block("spruce_slab", { type: "bottom" }), slab), false);
  assert.equal(holdsCell(block("spruce_slab", { type: "double" }), slab), false);
  const beam: BuildCell = { position: at, blockName: "oak_log", axis: "x" };
  assert.equal(holdsCell(block("oak_log", { axis: "x" }), beam), true);
  assert.equal(holdsCell(block("oak_log", { axis: "y" }), beam), false);
  assert.equal(holdsCell(block("oak_log", { axis: "y" }), { position: at, blockName: "oak_log" }), true, "no state asked, any state");
});

test("a cell asking a state waits for a support that gives it: a beam beside its pillar, a top slab under or beside a block, never on the floor", async () => {
  const { bot, put, physics } = structureWorld({ carried: { oak_log: 4, spruce_slab: 4, spruce_stairs: 4 } });
  // Side neighbours for the top halves: nothing above them, only the floor below.
  put(new Vec3(6, 64, 3), "stone");
  put(new Vec3(6, 64, 6), "stone");
  const structure: BuildCell[] = [
    { position: { x: 3, y: 64, z: 0 }, blockName: "oak_log", axis: "x" },
    { position: { x: 2, y: 64, z: 0 }, blockName: "oak_log", axis: "y" },
    { position: { x: 5, y: 64, z: 3 }, blockName: "spruce_slab", half: "top" },
    { position: { x: 5, y: 64, z: 6 }, blockName: "spruce_stairs", facing: "north", half: "top" },
    { position: { x: 5, y: 65, z: 9 }, blockName: "spruce_slab", half: "bottom" },
  ];
  put(new Vec3(5, 64, 9), "stone");
  const result = await build(bot, { ...physics, cells: structure, removeWrongBlocks: false });
  assert.equal(result.status, "complete");
  const states = (x: number, y: number, z = 0) => bot.blockAt(new Vec3(x, y, z))!.getProperties();
  assert.deepEqual(states(2, 64), { axis: "y" });
  assert.deepEqual(states(3, 64), { axis: "x" }, "placed against the pillar, not the floor");
  // A placed block is one state id (contract check `state-id-agrees`): the states given on top of its default, so a
  // slab put with its type reads dry and stairs read their default shape.
  assert.deepEqual(states(5, 64, 3), { type: "top", waterlogged: false });
  assert.deepEqual(states(5, 64, 6), { facing: "north", half: "top", shape: "straight", waterlogged: false });
  assert.deepEqual(states(5, 65, 9), { type: "bottom", waterlogged: false });
});

/**
 * Live 2026-10-03: Ayla stood on her farm's farmland (y 75.94) and leveling filled its water cell beside her. The
 * floored position put her feet in the farmland block itself, every pass read the cell as sealing her in, and the
 * step-out route, already satisfied, returned at once: the loop spun on promises without ever yielding, and the
 * runtime was stopped as unresponsive after 5 s. Twice.
 */
test("standing on farmland, the feet are the cell above it: filling the water cell beside it seals nothing", async () => {
  const { bot, put, physics } = structureWorld({ feet: new Vec3(1, 64, 0), carried: { dirt: 4 } });
  for (let x = 0; x <= 2; x += 1) for (let z = -1; z <= 1; z += 1) put(new Vec3(x, 64, z), "farmland");
  put(new Vec3(0, 64, 0), "water", { level: 0 });
  Object.assign(bot.entity, { position: new Vec3(1.5, 64.9375, 0.5), onGround: true });
  const result = await build(bot, { ...physics, cells: cells([[0, 64, 0]], "dirt"), removeWrongBlocks: true });
  assert.equal(result.status, "complete");
  assert.equal(result.placed, 1);
});

test("a step out of the structure that does not move the bot ends the run instead of spinning", async () => {
  const feet = new Vec3(1, 64, 1);
  const { bot, physics } = structureWorld({ feet });
  let exits = 0;
  // A route that reports arrival without moving, as one does whose goal is already met.
  const stuck = {
    ...physics,
    route: async (request: Parameters<typeof physics.route>[0]) => {
      if (request.onArrival === undefined) {
        exits += 1;
        return { status: "completed" as const, elapsedMs: 0 };
      }
      return physics.route(request);
    },
  };
  const result = await build(bot, { ...stuck, cells: cells(hollowBox()), removeWrongBlocks: false });
  assert.equal(result.status, "stopped");
  assert.match(result.reason ?? "", /could not step out of the structure/u);
  assert.ok(exits <= 3, `asked to step out ${exits} times`);
});

// Live 2026-10-11 (Theo): the routes of a house build pillared up in a ring round it with dirt and never took it down;
// the ring shut him in. The routes now report what they place, and a complete build takes those blocks down.
function scaffoldedWorld(scaffold: [number, number, number][], breakFails: string[] = [], reportOnly: [number, number, number][] = [], options: Parameters<typeof structureWorld>[0] = {}) {
  const world = structureWorld(options);
  const broken: string[] = [];
  const route = world.physics.route;
  let placedScaffold = false;
  const physics = {
    ...world.physics,
    route: async (options: Parameters<typeof route>[0]) => {
      if (!placedScaffold) {
        placedScaffold = true;
        for (const [x, y, z] of reportOnly) options.onPlacement?.({ position: { x, y, z }, stateId: 10 });
        for (const [x, y, z] of scaffold) {
          world.harness.world.setCell(new Vec3(x, y, z), 10); // state id 10: dirt, as the route's placement reports it
          options.onPlacement?.({ position: { x, y, z }, stateId: 10 });
        }
      }
      return route(options);
    },
    breakInPlace: async (options: Parameters<typeof world.physics.breakInPlace>[0]) => {
      const at = `${options.position.x},${options.position.y},${options.position.z}`;
      if (breakFails.includes(at)) return { status: "failed", reason: "unreachable" } as never;
      broken.push(at);
      return world.physics.breakInPlace(options);
    },
  };
  return { ...world, physics, broken };
}

test("a complete build takes the scaffold its routes placed down, highest first", async () => {
  const { bot, physics, broken, blocks } = scaffoldedWorld([[9, 65, 2], [9, 67, 2], [9, 66, 2]]);
  const result = await build(bot, { ...physics, cells: cells([[10, 64, 0]]), removeWrongBlocks: false });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.scaffold, { placed: 3, removed: 3, left: [] });
  assert.deepEqual(broken, ["9,67,2", "9,66,2", "9,65,2"]);
  assert.equal(blocks.get("9,66,2")!.name, "air");
});

test("a scaffold block that is also a cell of the structure is kept", async () => {
  const { bot, physics, blocks } = scaffoldedWorld([], [], [[10, 64, 0]]);
  const result = await build(bot, { ...physics, cells: cells([[10, 64, 0]]), removeWrongBlocks: false });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.scaffold, { placed: 1, removed: 0, left: [] });
  assert.notEqual(blocks.get("10,64,0")!.name, "air");
});

test("scaffold that cannot be reached is reported and the build is still complete", async () => {
  const { bot, physics } = scaffoldedWorld([[9, 66, 2], [9, 67, 2]], ["9,67,2"]);
  const result = await build(bot, { ...physics, cells: cells([[10, 64, 0]]), removeWrongBlocks: false });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.scaffold, { placed: 2, removed: 1, left: [{ x: 9, y: 67, z: 2 }] });
});

/**
 * Mine Labs 2026-11-12 (template-roof-counted-scaffold-medieval-small): the takedown's last dig was made from three
 * blocks away and its dirt lay where it fell when the call ended, so the next call started one block short. A scaffold
 * block dug out drops its item (`drops`: one dirt entity at the block, as the server spawns it, out of the bot's reach
 * from where the fake route stands); a pickup walk (the goal reads `Entity <id> is not currently observed` on the
 * route fake's empty observation) either stands on the item and takes it (`pickup: "reaches"`) or stops.
 */
function droppingScaffold(scaffold: [number, number, number][], pickup: "reaches" | "stops" = "reaches", onWalk?: (walk: { readonly id: number; readonly options: Parameters<ScaffoldedRoute>[0]; readonly collect: (id: number) => void }) => Promise<void>) {
  const clock = createFakeClock({ mode: "mocked" });
  const world = scaffoldedWorld(scaffold, [], [], { clock });
  const { harness, bot } = world;
  const drops: number[] = [];
  const walkedTo: number[] = [];
  const breakInPlace = world.physics.breakInPlace;
  const route = world.physics.route;
  const physics = {
    ...world.physics,
    breakInPlace: async (options: Parameters<typeof breakInPlace>[0]) => {
      const result = await breakInPlace(options);
      const { x, y, z } = options.position;
      if (scaffold.some(([sx, sy, sz]) => sx === x && sy === y && sz === z)) drops.push(harness.entities.spawn({ name: "item", position: new Vec3(x + 0.5, y + 0.3, z + 0.5), item: { name: "dirt", count: 1 } }).id);
      return result;
    },
    route: async (options: Parameters<typeof route>[0]) => {
      const goal = options.goal.resolve(observation());
      const item = goal.kind === "invalid" ? /Entity (\d+) is not currently observed/u.exec(goal.observation) : null;
      if (item === null) return route(options);
      walkedTo.push(Number(item[1]));
      if (pickup === "stops") return { status: "stopped" as const, reason: "no path to the item", elapsedMs: 0 };
      await onWalk?.({ id: Number(item[1]), options, collect });
      // What the server does when the walk arrives (`fake-bot-entities.ts` `pickUp`): `playerCollect`, the stack in the bag, the entity gone.
      if (options.stopSignal?.aborted === true) return { status: "stopped" as const, reason: "the pickup was observed", elapsedMs: 0 };
      if (bot.entities[Number(item[1])] !== undefined) collect(Number(item[1]));
      return { status: "completed" as const, elapsedMs: 0 };
    },
  };
  const collect = (id: number) => {
    bot.emit("playerCollect", bot.entity, bot.entities[id]!);
    harness.entities.remove(id);
    harness.inventory.updateSlot(harness.inventory.firstEmptySlotRange(9, 45)!, itemOf(bot.registry, "dirt", 1));
  };
  return { ...world, physics, clock, drops, walkedTo };
}

type ScaffoldedRoute = ReturnType<typeof structureWorld>["physics"]["route"];

const COMPLETE_BUILD = { cells: cells([[10, 64, 0]]), removeWrongBlocks: false } as const;

test("the scaffold taken down leaves no dropped block behind: each drop of the takedown is walked to once and picked up, one that lay there before is not chased", async () => {
  const { bot, physics, clock, harness, drops, walkedTo } = droppingScaffold([[9, 65, 2], [9, 66, 2]]);
  using _timers = clock.install();
  const earlier = harness.entities.spawn({ name: "item", position: new Vec3(9.5, 64.3, 2.5), item: { name: "dirt", count: 1 } }).id;
  const result = await clock.settle(build(bot, { ...physics, ...COMPLETE_BUILD }), 60_000);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.scaffold, { placed: 2, removed: 2, left: [] });
  assert.equal(drops.length, 2);
  assert.deepEqual([...walkedTo].sort(), [...drops].sort(), "every drop of the takedown, and not the earlier one");
  assert.notEqual(bot.entities[earlier], undefined, "the earlier drop is still there");
});

test("a walk that passes over another drop does not stop at it: the drop it was sent to is picked up too", async () => {
  const dropped = droppingScaffold([[9, 65, 2], [9, 66, 2]], "reaches", async ({ id, collect }) => {
    // The first walk crosses the other drop: its pickup is seen while the route still goes on to the one it was sent to.
    const other = dropped.drops.find((drop) => drop !== id)!;
    if (dropped.walkedTo.length === 1) { collect(other); await setImmediate(); }
  });
  using _timers = dropped.clock.install();
  await dropped.clock.settle(build(dropped.bot, { ...dropped.physics, ...COMPLETE_BUILD }), 60_000);
  assert.deepEqual(Object.values(dropped.bot.entities).filter((entity) => entity.name === "item"), [], "no item is left lying");
  assert.equal(dropped.walkedTo.length, 1, "the other drop, picked up on the way, needed no walk of its own");
});

/**
 * Mine Labs 2026-11-17 (template-roof-counted-scaffold-saltbox, probe on every sweep walk, 13 of 60 runs): the sweep began
 * 1 ms after the last dig, the item of the highest dug block was still falling 2.3 above the bot's feet, and the walk set
 * a step block one cell ahead to get under it; the build ended with that dirt standing at (5,-59,z) and the scenario's
 * "scaffold stands after the build" check failed.
 */
test("what a pickup walk places is scaffold too: the next takedown round digs it, so the build ends with none standing", async () => {
  const dropped = droppingScaffold([[9, 65, 2]], "reaches", async ({ options }) => {
    if (dropped.walkedTo.length > 1) return;
    dropped.harness.world.setCell(new Vec3(20, 64, 0), 10);
    options.onPlacement?.({ position: { x: 20, y: 64, z: 0 }, stateId: 10 });
  });
  using _timers = dropped.clock.install();
  const result = await dropped.clock.settle(build(dropped.bot, { ...dropped.physics, ...COMPLETE_BUILD }), 60_000);
  assert.deepEqual(result.scaffold, { placed: 2, removed: 2, left: [] });
});

/**
 * A placement the route was cut after its click (Mine Labs 2026-11-17, `navigation-run-cancelled-placement.test.ts`) is told
 * to `onPlacement` whether or not its block stands. These three pin what the takedown does with such a report.
 */
test("a placement reported after a cut click that the server dropped is counted removed: nothing stands, nothing is dug", async () => {
  const dropped = droppingScaffold([[9, 65, 2]], "reaches", async ({ options }) => {
    if (dropped.walkedTo.length === 1) options.onPlacement?.({ position: { x: 20, y: 64, z: 0 }, stateId: 10 }); // the click went out, the block never came
  });
  using _timers = dropped.clock.install();
  const result = await dropped.clock.settle(build(dropped.bot, { ...dropped.physics, ...COMPLETE_BUILD }), 60_000);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.scaffold, { placed: 2, removed: 2, left: [] });
});

test("a build cut right after a sweep's placement is resumed into digging it: the cut attempt's progress holds the block", async () => {
  const abort = new AbortController();
  const dropped = droppingScaffold([[9, 65, 2]], "reaches", async ({ options }) => {
    dropped.harness.world.setCell(new Vec3(20, 64, 0), 10);
    options.onPlacement?.({ position: { x: 20, y: 64, z: 0 }, stateId: 10 });
    abort.abort(new Error("a reflex cut the build"));
  });
  using _timers = dropped.clock.install();
  const progress = new BuildProgress();
  await assert.rejects(dropped.clock.settle(build(dropped.bot, { ...dropped.physics, ...COMPLETE_BUILD, signal: abort.signal }, false, progress), 60_000), /a reflex cut the build/u);
  assert.notEqual(dropped.harness.world.getBlockStateId(new Vec3(20, 64, 0)), 0, "the cut left the block standing");
  const resumed = await dropped.clock.settle(build(dropped.bot, { ...dropped.physics, ...COMPLETE_BUILD }, false, progress), 60_000);
  assert.equal(resumed.status, "complete");
  assert.equal(resumed.scaffold?.left.length, 0);
  assert.equal(dropped.harness.world.getBlockStateId(new Vec3(20, 64, 0)), 0, "the resumed takedown dug the reported block");
});

test("a sweep of the last takedown round that places a block leaves it, recorded and reported as left", async () => {
  // Each sweep places a new block and each dug block drops an item, so every round (the takedown makes at most four) ends with a block standing.
  const dropped = droppingScaffold([[9, 65, 2]], "reaches", async ({ options }) => {
    const at = { x: 19 + dropped.walkedTo.length, y: 64, z: 0 };
    dropped.harness.world.setCell(new Vec3(at.x, at.y, at.z), 10);
    options.onPlacement?.({ position: at, stateId: 10 });
  });
  const breakInPlace = dropped.physics.breakInPlace;
  const dropping = {
    ...dropped.physics,
    breakInPlace: async (options: Parameters<typeof breakInPlace>[0]) => {
      const result = await breakInPlace(options);
      if (options.position.x >= 20) dropped.harness.entities.spawn({ name: "item", position: new Vec3(options.position.x + 0.5, options.position.y + 0.3, options.position.z + 0.5), item: { name: "dirt", count: 1 } });
      return result;
    },
  };
  using _timers = dropped.clock.install();
  const result = await dropped.clock.settle(build(dropped.bot, { ...dropping, ...COMPLETE_BUILD }), 60_000);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.scaffold, { placed: 5, removed: 4, left: [{ x: 23, y: 64, z: 0 }] });
});

test("a build cut during the sweep is resumed into it: the drops the first attempt left are picked up by the next", async () => {
  const abort = new AbortController();
  const dropped = droppingScaffold([[9, 65, 2], [9, 66, 2]], "reaches", async () => abort.abort(new Error("a reflex cut the build")));
  using _timers = dropped.clock.install();
  const progress = new BuildProgress();
  await assert.rejects(dropped.clock.settle(build(dropped.bot, { ...dropped.physics, ...COMPLETE_BUILD, signal: abort.signal }, false, progress), 60_000), /a reflex cut the build/u);
  assert.equal(dropped.drops.length, 2, "both blocks were dug before the cut");
  const resumed = await dropped.clock.settle(build(dropped.bot, { ...dropped.physics, ...COMPLETE_BUILD }, false, progress), 60_000);
  assert.equal(resumed.status, "complete");
  assert.deepEqual(Object.values(dropped.bot.entities).filter((entity) => entity.name === "item"), [], "the resumed attempt picked up what the cut one left");
});

test("a build the policy stopped does not walk for drops", async () => {
  const stop = new AbortController();
  const dropped = droppingScaffold([[9, 65, 2], [9, 66, 2]]);
  using _timers = dropped.clock.install();
  const breakInPlace = dropped.physics.breakInPlace;
  const stopping = { ...dropped.physics, breakInPlace: async (options: Parameters<typeof breakInPlace>[0]) => { const result = await breakInPlace(options); stop.abort("tool lost"); return result; } };
  const result = await dropped.clock.settle(build(dropped.bot, { ...stopping, ...COMPLETE_BUILD, stopSignal: stop.signal }), 60_000);
  assert.equal(result.status, "complete");
  assert.deepEqual(dropped.walkedTo, [], "the stop reached the sweep: no walk");
});

test("a drop that cannot be reached is left and the build is still complete, the walk tried once", async () => {
  const { bot, physics, clock, drops, walkedTo } = droppingScaffold([[9, 65, 2], [9, 66, 2]], "stops");
  using _timers = clock.install();
  const result = await clock.settle(build(bot, { ...physics, cells: cells([[10, 64, 0]]), removeWrongBlocks: false }), 60_000);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.scaffold, { placed: 2, removed: 2, left: [] });
  assert.deepEqual([...walkedTo].sort(), [...drops].sort(), "each drop tried once, none again");
});

test("an abort during the drop pickup ends the build with the abort", async () => {
  const { bot, physics, clock } = droppingScaffold([[9, 65, 2]]);
  using _timers = clock.install();
  const abort = new AbortController();
  const aborting = {
    ...physics,
    route: async (options: Parameters<typeof physics.route>[0]) => {
      if (options.goal.resolve(observation()).kind === "invalid") abort.abort(new Error("the call was cancelled"));
      return physics.route(options);
    },
  };
  await assert.rejects(clock.settle(build(bot, { ...aborting, cells: cells([[10, 64, 0]]), removeWrongBlocks: false, signal: abort.signal }), 60_000), /the call was cancelled/u);
});

/** What refused a cell decides whether asking again can help: only a policy refusal is for good (run 14 review SF1). */
function refusalCause(result: BuildResult): unknown {
  return (result.cells[0]!.state as { cause?: unknown }).cause;
}

test("a refused cell carries the cause: placement, entity, policy or route", async () => {
  const one = cells([[2, 64, 0]]);
  const placementWorld = structureWorld();
  const placement = await build(placementWorld.bot, {
    ...placementWorld.physics,
    place: async () => ({ kind: "failed", error: "the server did not update the block" }),
    cells: one,
    removeWrongBlocks: false,
  });
  assert.equal(refusalCause(placement), "placement");

  const entityWorld = structureWorld();
  const entity = await build(entityWorld.bot, {
    ...entityWorld.physics,
    place: async () => ({ kind: "failed", error: "a cow stands in the cell", cause: "entity" }),
    cells: one,
    removeWrongBlocks: false,
  });
  assert.equal(refusalCause(entity), "entity");

  const policyWorld = structureWorld();
  policyWorld.put(new Vec3(2, 64, 0), "crafting_table");
  const policy = await build(policyWorld.bot, {
    ...policyWorld.physics,
    breakInPlace: async () => ({ status: "failed", reason: "movement policy prohibits breaking this block", cause: "policy" }),
    cells: one,
    removeWrongBlocks: true,
  });
  assert.equal(refusalCause(policy), "policy");

  const routeWorld = structureWorld();
  let stopped = false;
  const route = await build(routeWorld.bot, {
    ...routeWorld.physics,
    route: async (options) => {
      if (stopped) return routeWorld.physics.route(options);
      stopped = true;
      return { status: "stopped", reason: "no path; closest node was 5,64,0", elapsedMs: 0 };
    },
    cells: cells([[10, 64, 0]]),
    removeWrongBlocks: false,
  });
  assert.equal(refusalCause(route), "route");
});

test("a placement the body moved out of reach of before the click is no refusal: the cell is walked to again and placed", async () => {
  // Live 2026-11-16 (saltbox roof): hanging on a ladder, the bot slid 2 blocks while a stair's turn took its ticks, and the
  // click went out 6.1 from the cell: the server dropped it in silence and the build refused a cell it could place.
  // The bot starts 2 above the ground (on a ladder), the cell 2.4 from its eye; it ends 6.4 below the cell, the fake's route
  // arrives at the ground 3.7 from it.
  const world = structureWorld({ feet: new Vec3(0, 66, 0) });
  world.put(new Vec3(0, 68, 0), "stone");
  const asked: boolean[] = [];
  let slid = false;
  const result = await build(world.bot, {
    ...world.physics,
    place: async (placement) => {
      if (!slid) {
        slid = true;
        world.bot.entity.position = new Vec3(0.5, 62, 0.5);
        const stillInReach = placement.stillInReach?.() ?? true;
        asked.push(stillInReach);
        if (!stillInReach) return { kind: "failed", error: "moved out of reach", cause: "moved" };
      }
      return world.physics.place(placement);
    },
    cells: cells([[0, 69, 0]]),
    removeWrongBlocks: false,
  });

  assert.deepEqual(asked, [false], "the build hands the placement its own reach test, which fails from 2 blocks lower");
  assert.equal(result.status, "complete");
  assert.deepEqual(world.placements, ["0,69,0"], "placed once, after the walk back");
  assert.ok(world.routes.length >= 1, "the cell was out of reach where the bot stood, so the route took it back");
  assert.equal(result.placed, 1);
});

test("a body that moves out of reach before every click ends the run by idle passes, not by spinning", async () => {
  const world = structureWorld();
  world.put(new Vec3(0, 69, 0), "stone");
  let clicks = 0;
  const result = await build(world.bot, {
    ...world.physics,
    place: async () => {
      clicks += 1;
      return { kind: "failed", error: "moved out of reach", cause: "moved" };
    },
    cells: cells([[0, 70, 0]]),
    removeWrongBlocks: false,
  });

  assert.equal(result.status, "stopped");
  assert.equal(result.placed, 0);
  assert.ok(clicks > 0 && clicks <= 8, `tried ${clicks} times`);
  assert.equal(kinds(result)[0], "placeable", "not refused for good");
});

test("a dig that came out just before the abort threw is counted in the progress the next attempt reports", async () => {
  const { bot, physics, put } = structureWorld();
  put(new Vec3(2, 64, 0), "dirt");
  const progress = new BuildProgress();
  const cut = new AbortController();
  const cutting = {
    ...physics,
    breakInPlace: async (options: Parameters<typeof physics.breakInPlace>[0]) => {
      await physics.breakInPlace(options);
      cut.abort(new Error("[HUNGER] reflex"));
      throw cut.signal.reason;
    },
  };
  await assert.rejects(build(bot, { ...cutting, cells: cells([[2, 64, 0]]), removeWrongBlocks: true, signal: cut.signal }, false, progress), /HUNGER/);
  assert.equal(progress.dug, 1);
  const resumed = await build(bot, { ...physics, cells: cells([[2, 64, 0]]), removeWrongBlocks: true }, false, progress);
  assert.equal(resumed.status, "complete");
  assert.equal(resumed.dug, 1, "the resumed attempt reports the whole request's dig, once");
});

// Plan 2026-10-27-p1-monotonic-clock T4: the 250 ms cache of cell states is a window, so it counts monotonic time.
test("the cell-state cache is refreshed 1 s later though the wall clock stepped back 0.8 s, and held for 100 ms though it stepped forward 1.2 s", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, harness } = structureWorld({ clock });
  using _timers = clock.install();
  const targeting = new BuildTargeting(bot, { ...({} as BuildRequest), cells: cells([[2, 64, 0]]), removeWrongBlocks: false });
  const kindOfCell = () => targeting.states().get(packKey(2, 64, 0))?.kind;
  assert.notEqual(kindOfCell(), "correct");
  harness.world.setCell(new Vec3(2, 64, 0), "cobblestone");
  await clock.advance(1_000);
  clock.stepWallClock(-800);
  assert.equal(kindOfCell(), "correct", "a second of clock passed: the cache is stale");
  harness.world.setCell(new Vec3(2, 64, 0), "air");
  await clock.advance(100);
  clock.stepWallClock(1_200);
  assert.equal(kindOfCell(), "correct", "100 ms of clock: the cache still holds");
});

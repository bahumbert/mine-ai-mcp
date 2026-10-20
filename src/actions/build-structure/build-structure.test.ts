import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { structureWorld } from "../../test-support/structure-world.js";
import { parseBuildStructureRequest, portalFrameCells, type StructureCell } from "./contract.js";
import { formatBuildStructureResult, buildStructure, beginBuildStructure, createBuildStructureAction } from "./build-structure.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { setProtectedRegionsProvider } from "../../world/protected-regions.js";
import { packKey } from "../../navigation/index.js";

function cells(list: [number, number, number][], blockName = "cobblestone"): StructureCell[] {
  return list.map(([x, y, z]) => ({ x, y, z, blockName }));
}

test("the portal preset uses ten obsidian, four corner supports and six interior air cells, and conflicting cells are refused", () => {
  const frame = portalFrameCells({ x: 5, y: 64, z: 0, axis: "x" });
  assert.equal(frame.length, 20);
  assert.equal(frame.filter((cell) => cell.blockName === "obsidian").length, 10);
  assert.equal(frame.filter((cell) => cell.blockName === "cobblestone").length, 4);
  const interior = frame.filter((cell) => cell.blockName === "air");
  assert.equal(interior.length, 6);
  assert.ok(interior.every((cell) => (cell.x === 5 || cell.x === 6) && cell.y >= 64 && cell.y <= 66 && cell.z === 0));
  assert.ok(
    frame.some((cell) => cell.x === 4 && cell.y === 63 && cell.z === 0 && cell.blockName === "cobblestone"),
    "bottom-left corner",
  );
  assert.ok(
    frame.some((cell) => cell.x === 7 && cell.y === 67 && cell.z === 0 && cell.blockName === "cobblestone"),
    "top-right corner",
  );
  assert.ok(
    !frame.some((cell) => cell.x === 5 && cell.y === 64 && cell.blockName === "obsidian"),
    "the interior is not frame",
  );

  const parsed = parseBuildStructureRequest({ portal_frame: { x: 5, y: 64, z: 0 } });
  assert.equal(parsed.cells.length, 20);
  assert.deepEqual(parsed.cells, frame);
  const rotated = parseBuildStructureRequest({
    portal_frame: { x: 0, y: 64, z: 5, axis: "z" },
  });
  assert.deepEqual(
    rotated.cells,
    frame.map((cell) => ({
      ...cell,
      x: cell.z,
      z: cell.x,
    })),
  );
  assert.throws(
    () =>
      parseBuildStructureRequest({
        blocks: [
          { x: 1, y: 64, z: 1, block_name: "stone" },
          { x: 1, y: 64, z: 1, block_name: "dirt" },
        ],
      }),
    /both stone and dirt/,
  );
  assert.deepEqual(
    parseBuildStructureRequest({ blocks: [{ x: 1, y: 64, z: 1, block_name: "oak_door", facing: "south" }] }).cells,
    [{ x: 1, y: 64, z: 1, blockName: "oak_door", facing: "south" }],
  );
  assert.throws(
    () =>
      parseBuildStructureRequest({
        blocks: [
          { x: 1, y: 64, z: 1, block_name: "oak_door", facing: "south" },
          { x: 1, y: 64, z: 1, block_name: "oak_door", facing: "east" },
        ],
      }),
    /both oak_door facing south and oak_door facing east/,
  );
  assert.throws(() => parseBuildStructureRequest({ blocks: [{ x: 1, y: 64, z: 1, block_name: "oak_door", facing: "up" }] }));
  assert.throws(() => parseBuildStructureRequest({}), /needs blocks/);
  assert.throws(() => parseBuildStructureRequest({
    portal_frame: { x: 5, y: 64, z: 0, corner_block: "obsidian" },
  }), /corner_block/);
  const custom = frame.map(({ x, y, z, blockName }) => ({
    x, y, z, block_name: blockName === "cobblestone" ? "obsidian" : blockName,
  }));
  assert.equal(parseBuildStructureRequest({ blocks: custom }).cells.filter(cell => cell.blockName === "obsidian").length, 14);
});

test("a finished structure is reported complete with what was placed", async () => {
  const { bot, physics } = structureWorld();
  const result = await buildStructure(
    bot,
    {
      cells: cells([
        [2, 64, 0],
        [3, 64, 0],
      ]),
      removeWrongBlocks: false,
    },
    {},
    physics,
  );
  assert.equal(result.status, "succeeded");
  assert.ok(result.structure);
  assert.equal(result.structure.placed, 2);
  assert.deepEqual(result.structure.left, []);
  assert.match(formatBuildStructureResult(result), /Every cell of the structure holds its block \(2 cells\)/);
});

test("the audit says why each wrong cell was left, naming the block in the way and the shortfall", async () => {
  const { bot, put, physics } = structureWorld({ carried: { cobblestone: 1 } });
  put(new Vec3(2, 64, 0), "oak_leaves");
  const result = await buildStructure(
    bot,
    {
      cells: cells([
        [2, 64, 0],
        [3, 64, 0],
        [4, 64, 0],
      ]),
      removeWrongBlocks: false,
    },
    {},
    physics,
  );
  if (result.status === "succeeded") assert.fail("leaves are not cobblestone and one block cannot fill two cells");
  assert.ok(result.structure);
  assert.equal(result.structure.placed, 1);
  assert.equal(result.structure.wrong, 2);
  assert.deepEqual(result.structure.left, [
    { reason: "holds_another_block", count: 1, named: [{ x: 2, y: 64, z: 0, holds: "oak_leaves" }] },
    { reason: "block_not_carried", count: 1, named: [{ x: 4, y: 64, z: 0 }] },
  ]);
  assert.deepEqual(result.structure.missing, [{ block: "cobblestone", count: 2 }]);
  assert.match(
    result.error,
    /BUILD_INCOMPLETE\] 2 cells still wrong: 1 hold another block \(oak_leaves at 2,64,0\); 1 need a block the bot does not carry \(4,64,0\); short of 2 cobblestone\./,
  );
  const markdown = formatBuildStructureResult(result);
  assert.match(markdown, /- Left wrong: 1 hold another block \(oak_leaves at 2,64,0\)/);
  assert.match(markdown, /- Missing: 2 cobblestone/);
});

test("a block Minecraft does not have is refused before anything moves", async () => {
  const { bot, physics, placements } = structureWorld();
  const result = await buildStructure(
    bot,
    { cells: cells([[2, 64, 0]], "unobtainium"), removeWrongBlocks: false },
    {},
    physics,
  );
  assert.equal(result.status, "failed");
  assert.match((result as { error: string }).error, /no block named unobtainium/);
  assert.deepEqual(placements, []);
  assert.equal(result.structure, null);
  assert.doesNotMatch(formatBuildStructureResult(result), /Every cell/);
});

test("a structure is refused before any block is touched when a cell lies in a region someone else owns, and built in its own", async () => {
  const { bot, physics } = structureWorld();
  Object.assign(bot, { username: "Ayla" });
  const region = (owner: string) => ({ regionId: 4, dimension: "overworld", min: { x: 3, y: 64, z: 0 }, max: { x: 5, y: 66, z: 2 }, owner, label: "Tom's place" });
  setProtectedRegionsProvider(bot, () => [region("Tom")]);
  const request = { cells: cells([[2, 64, 0], [3, 64, 0], [4, 64, 0]]), removeWrongBlocks: false };
  const refused = await buildStructure(bot, request, {}, physics);
  assert.deepEqual(refused, {
    status: "failed",
    error: "[BUILD_PROTECTED_REGION] 2 cells lie inside protected region #4 'Tom's place' (owner Tom), which this bot does not own; unprotect it or build elsewhere.",
    structure: null,
  });
  assert.equal(bot.blockAt(new Vec3(2, 64, 0))?.name, "air", "nothing was placed");

  setProtectedRegionsProvider(bot, () => [region("ayla")]);
  assert.equal((await buildStructure(bot, request, {}, physics)).status, "succeeded");
});

test("cells may ask a half and an axis, and one cell asked two ways is refused", () => {
  assert.deepEqual(
    parseBuildStructureRequest({ blocks: [
      { x: 1, y: 64, z: 1, block_name: "spruce_stairs", facing: "north", half: "top" },
      { x: 2, y: 64, z: 1, block_name: "oak_log", axis: "x" },
    ] }).cells,
    [
      { x: 1, y: 64, z: 1, blockName: "spruce_stairs", facing: "north", half: "top" },
      { x: 2, y: 64, z: 1, blockName: "oak_log", axis: "x" },
    ],
  );
  assert.throws(() => parseBuildStructureRequest({ blocks: [
    { x: 1, y: 64, z: 1, block_name: "spruce_slab", half: "top" },
    { x: 1, y: 64, z: 1, block_name: "spruce_slab", half: "bottom" },
  ] }), /both spruce_slab top and spruce_slab bottom/);
  assert.throws(() => parseBuildStructureRequest({ blocks: [{ x: 1, y: 64, z: 1, block_name: "oak_log", axis: "w" }] }));
});

test("cells kept from earlier parts are never dug by the routes of this one", async () => {
  const { bot, physics, protectedSets } = structureWorld();
  const request = parseBuildStructureRequest({
    blocks: [{ x: 2, y: 64, z: 0, block_name: "cobblestone" }],
    keep: [{ x: 5, y: 64, z: 0 }, { x: 5, y: 65, z: 0 }],
  });
  assert.deepEqual(request.keep, [{ x: 5, y: 64, z: 0 }, { x: 5, y: 65, z: 0 }]);
  const result = await buildStructure(bot, request, {}, physics);
  assert.equal(result.status, "succeeded");
  assert.ok(protectedSets.length > 0);
  for (const cells of protectedSets) {
    assert.ok(cells.has(packKey(5, 64, 0)) && cells.has(packKey(5, 65, 0)), "every route keeps the earlier parts");
  }
  assert.equal(parseBuildStructureRequest({ blocks: [{ x: 2, y: 64, z: 0, block_name: "cobblestone" }], keep: [] }).keep, undefined);
  assert.throws(() => parseBuildStructureRequest({ blocks: [{ x: 2, y: 64, z: 0, block_name: "cobblestone" }], keep: Array.from({ length: 2049 }, (_, x) => ({ x, y: 64, z: 0 })) }));
});

test("the result says how much scaffold the routes placed, took down and left", () => {
  const structure = {
    dimension: "overworld", cells: 2, correct: 2, placed: 2, dug: 0, wrong: 0, left: [], missing: [], passes: 2, complete: true,
    scaffold: { placed: 5, removed: 4, left: [{ x: 9, y: 67, z: 2 }], leftCount: 1 },
  };
  const markdown = formatBuildStructureResult({ status: "succeeded", structure } as never);
  assert.match(markdown, /Scaffold: 5 placed by the routes, 4 taken down, 1 still standing \(9 67 2\)/);
});

// Reflex continuity (spec 2026-10-18, R2): a reflex that takes the body mid-build hands it back, and the build goes on
// from what it already did instead of starting over or leaving its scaffold.
type Physics = ReturnType<typeof structureWorld>["physics"];
const fresh = () => new AbortController();
const aborted = (controller: AbortController, reason: string) => {
  controller.abort(new Error(reason));
  return controller.signal.reason as Error;
};

/** The physics with the `n`th placement cut short by the reflex: the block goes down, then the attempt is aborted. */
function abortingAfterPlacement(physics: Physics, n: number, controller: AbortController, throwFromPlace: boolean): Physics {
  let placed = 0;
  return {
    ...physics,
    place: async (placement) => {
      const result = await physics.place(placement);
      placed += 1;
      if (placed === n) {
        const reason = aborted(controller, "[HUNGER] reflex");
        if (throwFromPlace) throw reason;
      }
      return result;
    },
  };
}

test("a build cut short after two of four cells goes on with the other two, each counted once", async () => {
  const { bot, physics, placements, blocks } = structureWorld();
  const first = fresh();
  const request = { cells: cells([[2, 64, 0], [3, 64, 0], [4, 64, 0], [5, 64, 0]]), removeWrongBlocks: false };
  const run = beginBuildStructure(bot, request, abortingAfterPlacement(physics, 2, first, false), () => {});
  await assert.rejects(run({ signal: first.signal }), /HUNGER/);
  const result = await run({ signal: fresh().signal });
  assert.equal(result.status, "succeeded");
  assert.equal(result.structure!.placed, 4);
  assert.deepEqual([...placements].sort(), ["2,64,0", "3,64,0", "4,64,0", "5,64,0"], "no cell placed twice");
  assert.equal(blocks.get("5,64,0")!.name, "cobblestone");
});

test("a placement that landed just before the abort threw is still counted", async () => {
  const { bot, physics, placements } = structureWorld();
  const first = fresh();
  const request = { cells: cells([[2, 64, 0], [3, 64, 0], [4, 64, 0]]), removeWrongBlocks: false };
  const run = beginBuildStructure(bot, request, abortingAfterPlacement(physics, 2, first, true), () => {});
  await assert.rejects(run({ signal: first.signal }), /HUNGER/);
  const result = await run({ signal: fresh().signal });
  assert.equal(result.structure!.placed, 3, "the block placed by the cut attempt is not lost from the total");
  assert.equal(placements.length, 3);
});

test("a cell built by someone else between the attempts is not placed again nor counted as ours", async () => {
  const { bot, physics, put, placements } = structureWorld();
  const first = fresh();
  const request = { cells: cells([[2, 64, 0], [3, 64, 0], [4, 64, 0]]), removeWrongBlocks: false };
  const run = beginBuildStructure(bot, request, abortingAfterPlacement(physics, 1, first, false), () => {});
  await assert.rejects(run({ signal: first.signal }));
  put(new Vec3(3, 64, 0), "cobblestone");
  const result = await run({ signal: fresh().signal });
  assert.equal(result.status, "succeeded");
  assert.equal(result.structure!.placed, 2);
  assert.deepEqual(placements, ["2,64,0", "4,64,0"]);
});

test("water the fall reflex left in a cell to build is placed over, and a leftover block is dug when the request says so", async () => {
  const { bot, physics, put, placements } = structureWorld();
  const first = fresh();
  const request = { cells: cells([[2, 64, 0], [3, 64, 0], [4, 64, 0]]), removeWrongBlocks: true };
  const run = beginBuildStructure(bot, request, abortingAfterPlacement(physics, 1, first, false), () => {});
  await assert.rejects(run({ signal: first.signal }));
  put(new Vec3(3, 64, 0), "water");
  put(new Vec3(4, 64, 0), "dirt");
  const result = await run({ signal: fresh().signal });
  assert.equal(result.status, "succeeded");
  assert.equal(result.structure!.dug, 1);
  assert.deepEqual([...placements].sort(), ["2,64,0", "3,64,0", "4,64,0"]);
});

test("a build that already finished answers a second call with the same success and touches nothing", async () => {
  const { bot, physics, placements } = structureWorld();
  const request = { cells: cells([[2, 64, 0], [3, 64, 0]]), removeWrongBlocks: false };
  const run = beginBuildStructure(bot, request, physics, () => {});
  const done = await run({ signal: fresh().signal });
  const again = await run({ signal: fresh().signal });
  assert.equal(again.status, "succeeded");
  assert.equal(again.structure!.placed, done.structure!.placed);
  assert.equal(placements.length, 2);
});

/** A route that, on its first leg, puts scaffold down the way a pillaring route does and reports it. */
function scaffoldingFirstRoute(world: ReturnType<typeof structureWorld>, scaffold: [number, number, number][], afterScaffold?: () => void): Physics {
  let placed = false;
  return {
    ...world.physics,
    route: async (options) => {
      if (!placed) {
        placed = true;
        for (const [x, y, z] of scaffold) {
          world.put(new Vec3(x, y, z), "dirt");
          (world.blocks.get(`${x},${y},${z}`) as unknown as { stateId: number }).stateId = 10;
          options.onPlacement?.({ position: { x, y, z }, stateId: 10 });
        }
        afterScaffold?.();
      }
      return world.physics.route(options);
    },
  };
}

test("scaffold standing when the reflex cut the build is taken down by the attempt that finishes it", async () => {
  const world = structureWorld();
  const first = fresh();
  const physics = scaffoldingFirstRoute(world, [[9, 65, 2], [9, 66, 2]], () => { aborted(first, "[FALL] reflex"); });
  const request = { cells: cells([[10, 64, 0], [11, 64, 0]]), removeWrongBlocks: false };
  const run = beginBuildStructure(world.bot, request, physics, () => {});
  await assert.rejects(run({ signal: first.signal }), /FALL/);
  assert.equal(world.blocks.get("9,66,2")!.name, "dirt", "the cut attempt left its scaffold standing");
  const result = await run({ signal: fresh().signal });
  assert.equal(result.status, "succeeded");
  assert.equal(world.blocks.get("9,66,2")!.name, "air");
  assert.equal(world.blocks.get("9,65,2")!.name, "air");
  assert.deepEqual(result.structure!.scaffold, { placed: 2, removed: 2, left: [], leftCount: 0 });
});

test("a build cut while taking its scaffold down resumes into the takedown and leaves none", async () => {
  const world = structureWorld();
  const cut = fresh();
  const physics = scaffoldingFirstRoute(world, [[9, 65, 2], [9, 66, 2], [9, 67, 2]]);
  let broken = 0;
  const run = beginBuildStructure(world.bot, { cells: cells([[10, 64, 0]]), removeWrongBlocks: false }, {
    ...physics,
    breakInPlace: async (options) => {
      const result = await physics.breakInPlace(options);
      broken += 1;
      if (broken === 1) throw aborted(cut, "[HUNGER] reflex");
      return result;
    },
  }, () => {});
  await assert.rejects(run({ signal: cut.signal }), /HUNGER/);
  assert.equal(world.blocks.get("9,67,2")!.name, "air", "the highest block was already down");
  const result = await run({ signal: fresh().signal });
  assert.equal(result.status, "succeeded");
  assert.deepEqual([65, 66, 67].map((y) => world.blocks.get(`9,${y},2`)!.name), ["air", "air", "air"]);
  assert.equal(result.structure!.scaffold!.placed, 3);
  assert.equal(result.structure!.scaffold!.leftCount, 0);
});

test("scaffold that another bot already took down is skipped, not dug twice", async () => {
  const world = structureWorld();
  const first = fresh();
  const dug: string[] = [];
  const base = scaffoldingFirstRoute(world, [[9, 65, 2], [9, 66, 2]], () => { aborted(first, "[FALL] reflex"); });
  const physics: Physics = {
    ...base,
    breakInPlace: async (options) => {
      dug.push(`${options.position.x},${options.position.y},${options.position.z}`);
      return base.breakInPlace(options);
    },
  };
  const run = beginBuildStructure(world.bot, { cells: cells([[10, 64, 0]]), removeWrongBlocks: false }, physics, () => {});
  await assert.rejects(run({ signal: first.signal }));
  world.put(new Vec3(9, 66, 2), "air");
  const result = await run({ signal: fresh().signal });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(dug, ["9,65,2"]);
});

/** The action as the catalog builds it (a fake world's physics under the real wrapper), run to the end. */
async function buildAsAction(world: ReturnType<typeof structureWorld>, data: ReturnType<typeof temporaryBotData>, list: StructureCell[]) {
  (world.bot as { username: string }).username = "Builder";
  const action = createBuildStructureAction(world.bot, {} as never, data, world.physics);
  const run = action.begin({ cells: list, removeWrongBlocks: false }, new AbortController().signal, () => {});
  return run({ signal: new AbortController().signal });
}
const placedContainers = (data: ReturnType<typeof temporaryBotData>) =>
  data.read("SELECT container_key, block_name, placed_by_bot_id FROM placed_containers ORDER BY container_key");

test("a house's chest placed by build_structure is recorded, and the walls around it are not", async (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const world = structureWorld({ carried: { chest: 1, cobblestone: 4 } });

  const result = await buildAsAction(world, data, [
    ...cells([[2, 64, 0], [3, 64, 0]]),
    { x: 4, y: 64, z: 0, blockName: "chest" },
  ]);

  assert.equal(result.status, "succeeded");
  assert.deepEqual(placedContainers(data), [
    { container_key: "overworld|4|64|0", block_name: "chest", placed_by_bot_id: "Builder" },
  ]);
});

test("a chest already standing in the plan is not recorded: the bot did not place it", async (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const world = structureWorld({ carried: { cobblestone: 4 } });
  world.put(new Vec3(4, 64, 0), "chest");

  const result = await buildAsAction(world, data, [{ x: 4, y: 64, z: 0, blockName: "chest" }]);

  assert.equal(result.status, "succeeded");
  assert.deepEqual(placedContainers(data), []);
});

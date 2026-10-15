import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { structureWorld } from "../../test-support/structure-world.js";
import { parseBuildStructureRequest, portalFrameCells, type StructureCell } from "./contract.js";
import { formatBuildStructureResult, buildStructure } from "./build-structure.js";
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

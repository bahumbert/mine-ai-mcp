import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture, registry } from "../../test-support/bot.js";
import { parseViewBlocksRequest } from "./contract.js";
import { formatViewBlocksResult, viewBlocks } from "./view-blocks.js";

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

interface Placed {
  readonly name: string;
  readonly properties?: Record<string, unknown>;
}

/** One loaded chunk column at the origin, y 0 to 80, holding the named blocks over air. */
function fakeBot(placed: Record<string, Placed>, feet = new Vec3(0.5, 64, 0.5)) {
  const stateOf = (name: string) => registry.blocksByName[name]!.defaultState;
  const sections = Array.from({ length: 5 }, (_unused, index) => {
    const sectionY = index * 16;
    return {
      solidBlockCount: 1,
      data: {},
      get: (local: { x: number; y: number; z: number }) => {
        const block = placed[key(local.x, sectionY + local.y, local.z)];
        return block ? stateOf(block.name) : 0;
      },
    };
  });
  return botFixture(
    { position: feet },
    {
      world: { getColumns: () => [{ chunkX: 0, chunkZ: 0, column: { minY: 0, sections } }] },
      blockAt: (at: Vec3) => {
        if (at.x < 0 || at.x > 15 || at.z < 0 || at.z > 15 || at.y < 0 || at.y >= 80) return null;
        const block = placed[key(at.x, at.y, at.z)];
        const name = block?.name ?? "air";
        const definition = registry.blocksByName[name]!;
        return {
          name,
          position: at,
          boundingBox: definition.boundingBox,
          getProperties: () => block?.properties ?? {},
        };
      },
    },
  );
}

test("a view needs at least one of find, box, or cells, dedupes names, and defaults the limit", () => {
  assert.throws(() => parseViewBlocksRequest({}), /needs find, box, cells, or kinds/);
  const parsed = parseViewBlocksRequest({ find: { block_names: ["Obsidian", "minecraft:obsidian", "lava"] } });
  assert.deepEqual(parsed.find, { blockNames: ["obsidian", "lava"], limit: 12 });
  assert.equal(parsed.box, null);
  assert.deepEqual(parsed.cells, []);
});

test("find lists the nearest matches across what is loaded, with what is above and below, and counts the rest", () => {
  const bot = fakeBot({
    [key(3, 64, 0)]: { name: "obsidian" },
    [key(3, 65, 0)]: { name: "lava", properties: { level: "0" } },
    [key(3, 63, 0)]: { name: "stone" },
    [key(10, 64, 0)]: { name: "obsidian" },
  });
  const result = viewBlocks(bot, { find: { blockNames: ["obsidian", "lava"], limit: 1 }, box: null, cells: [] });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.blocks.find, [
    {
      name: "obsidian",
      found: 2,
      more: false,
      listed: [{ x: 3, y: 64, z: 0, name: "obsidian", shape: "solid", distance: 3, above: "lava", below: "stone" }],
    },
    {
      name: "lava",
      found: 1,
      more: false,
      listed: [
        { x: 3, y: 65, z: 0, name: "lava", shape: "liquid", level: 0, distance: 3.2, above: "air", below: "obsidian" },
      ],
    },
  ]);
  const markdown = formatViewBlocksResult(result);
  assert.match(markdown, /### obsidian: 2 loaded, nearest 1 listed/);
  assert.match(markdown, /- obsidian at 3, 64, 0, 3 blocks away \(solid\); above lava, below stone/);
  assert.match(markdown, /### lava: 1 loaded\n- lava at 3, 65, 0, 3.2 blocks away \(source\)/);
});

test("a find counts at most a thousand per name, the nearest, and says there are more", () => {
  // Live 2026-10-03: counting every stone loaded kept millions of positions and stalled the runtime past its heartbeat.
  const blocks: Record<string, { name: string }> = {};
  // Four full layers of the one loaded chunk: 1024 stone under the bot.
  for (let y = 60; y <= 63; y += 1) for (let x = 0; x < 16; x += 1) for (let z = 0; z < 16; z += 1) blocks[key(x, y, z)] = { name: "stone" };
  const result = viewBlocks(fakeBot(blocks), { find: { blockNames: ["stone"], limit: 2 }, box: null, cells: [] });
  assert.equal(result.status, "succeeded");
  const [stone] = result.blocks.find!;
  assert.deepEqual([stone!.found, stone!.more, stone!.listed.length], [1000, true, 2]);
  assert.deepEqual([stone!.listed[0]!.x, stone!.listed[0]!.y, stone!.listed[0]!.z], [0, 63, 0]);
  assert.match(formatViewBlocksResult(result), /### stone: 1000\+ loaded, nearest 2 listed/);
});

test("a name Minecraft has no block for fails the view rather than finding nothing", () => {
  const result = viewBlocks(fakeBot({}), { find: { blockNames: ["unobtainium"], limit: 12 }, box: null, cells: [] });
  assert.equal(result.status, "failed");
  assert.match((result as { error: string }).error, /no block named unobtainium/);
});

test("kinds give each named block's game data, harvest tools cheapest tier first, without reading the world", () => {
  const request = parseViewBlocksRequest({ kinds: ["stone", "iron_ore", "dirt", "minecraft:stone"] });
  assert.deepEqual(request.kinds, ["stone", "iron_ore", "dirt"]);
  const result = viewBlocks(Object.assign(fakeBot({}), { version: "1.21.4" }), request);
  assert.equal(result.status, "succeeded");
  const kinds = result.blocks.kinds!;
  assert.deepEqual({ ...kinds.dirt!, tags: undefined }, { tool: "shovel", solid: true, harvest: null, tags: undefined });
  assert.ok(kinds.dirt!.tags.includes("mineable/shovel"));
  assert.ok(kinds.stone!.tags.includes("mineable/pickaxe"));
  assert.equal(kinds.stone!.tool, "pickaxe");
  assert.equal(kinds.stone!.harvest![0], "wooden_pickaxe");
  assert.equal(kinds.iron_ore!.harvest![0], "stone_pickaxe");
  assert.ok(!kinds.iron_ore!.harvest!.includes("wooden_pickaxe"));
  assert.match(formatViewBlocksResult(result), /- dirt: solid, mined fast with a shovel, drops by hand; tags: [^\n]*mineable\/shovel/);
  const unknown = viewBlocks(fakeBot({}), parseViewBlocksRequest({ kinds: ["unobtainium"] }));
  assert.equal(unknown.status, "failed");
});

test("kinds name the game's block tags, so every wood's log is a log and a pumpkin, mined with an axe too, is not", () => {
  const bot = Object.assign(fakeBot({}), { version: "1.21.4" });
  const kinds = viewBlocks(bot, parseViewBlocksRequest({ kinds: ["spruce_log", "crimson_stem", "pumpkin"] })).blocks.kinds!;
  assert.ok(kinds.spruce_log!.tags.includes("logs"));
  assert.ok(kinds.crimson_stem!.tags.includes("logs"));
  assert.equal(kinds.pumpkin!.tool, "axe");
  assert.ok(!kinds.pumpkin!.tags.includes("logs"));
});

test("a box is drawn top layer first as one grid per layer with a legend", () => {
  const bot = fakeBot({
    [key(4, 63, 4)]: { name: "stone" },
    [key(5, 63, 4)]: { name: "stone" },
    [key(4, 64, 4)]: { name: "water", properties: { level: 0 } },
  });
  const result = viewBlocks(bot, {
    find: null,
    box: { x: 4, y: 64, z: 4, halfWidth: 1, halfHeight: 1 },
    cells: [],
  });
  assert.equal(result.status, "succeeded");
  const layers = result.blocks.box!.layers;
  assert.deepEqual(
    layers.map((layer) => layer.y),
    [65, 64, 63],
  );
  assert.equal(layers[1]!.rows.length, 3);
  assert.deepEqual(layers[1]!.rows[1]!.blocks, ["air", "water", "air"]);
  const markdown = formatViewBlocksResult(result);
  assert.match(markdown, /### Box around 4, 64, 4 \(x 3\.\.5 across, z 3\.\.5 down\)/);
  assert.match(markdown, /y=63\n```\n    3  \. \. \.\n    4  \. A A\n    5  \. \. \.\n```/);
  assert.match(markdown, /Legend: \. air \(24\), A stone \(2\), ~ water \(1\)/);
});

test("cells report shape, liquid level, and waterlogging", () => {
  const bot = fakeBot({
    [key(1, 64, 1)]: { name: "water", properties: { level: 0 } },
    [key(2, 64, 1)]: { name: "water", properties: { level: 3 } },
    [key(3, 64, 1)]: { name: "oak_slab", properties: { waterlogged: true, type: "bottom" } },
    [key(4, 64, 1)]: { name: "stone" },
  });
  const result = viewBlocks(bot, {
    find: null,
    box: null,
    cells: [
      { x: 1, y: 64, z: 1 },
      { x: 2, y: 64, z: 1 },
      { x: 3, y: 64, z: 1 },
      { x: 4, y: 64, z: 1 },
      { x: 5, y: 64, z: 1 },
      { x: 40, y: 64, z: 1 },
    ],
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    result.blocks.cells.map((cell) => [cell.name, cell.shape, cell.level, cell.waterlogged]),
    [
      ["water", "liquid", 0, undefined],
      ["water", "liquid", 3, undefined],
      ["oak_slab", "solid", undefined, true],
      ["stone", "solid", undefined, undefined],
      ["air", "open", undefined, undefined],
      ["unloaded", "open", undefined, undefined],
    ],
  );
  const markdown = formatViewBlocksResult(result);
  assert.match(markdown, /- 1, 64, 1: water \(source\)/);
  assert.match(markdown, /- 2, 64, 1: water \(flowing level 3\)/);
  assert.match(markdown, /- 3, 64, 1: oak_slab \(solid, waterlogged\)/);
});

import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { SqlBotData } from "../bot-data/index.js";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { attachSessionFrontier, RESCAN_AFTER_MS, SEEN_CAP, SEEN_MOVED, SEEN_TTL_MS, seenInWorld } from "./frontier.js";

function temporaryBotData(): SqlBotData {
  return SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "frontier-test", scope: { kind: "shared" } },
  });
}

/** The version's state id of `name` (its default state, or its first with `first`): the ids a chunk's palette holds. */
function stateOf(name: string, first = false): number {
  const block = REGISTRY.blocksByName[name]!;
  return first ? block.minStateId! : block.defaultState!;
}

const REGISTRY = createFakeBot().bot.registry;
const AIR = stateOf("air");

/** The id the login's biome registry gives `name`: Prismarine keys it by the namespaced name the server sends. */
function biomeId(name: string): number {
  return REGISTRY.biomesByName[`minecraft:${name}`]!.id;
}

/** One column at chunk (-2, 4) whose sections hold the version's state ids, as Prismarine's palettes give them. */
function fixture(surfaceWaterCells = 129) {
  const ores = ["stone", "oak_log", "prismarine", "coal_ore", "diamond_ore", "gravel", "copper_ore", "deepslate_copper_ore",
    "gold_ore", "deepslate_gold_ore", "redstone_ore", "deepslate_redstone_ore", "lapis_ore", "deepslate_lapis_ore",
    "deepslate_diamond_ore"];
  const column = {
    sections: [
      // Two states of one block (an oak log on two axes) name one material.
      { data: { palette: [AIR, ...ores.map((name) => stateOf(name)), stateOf("oak_log", true)], get: () => AIR } },
      { data: { value: AIR, get: () => AIR } },
      { data: { get: (index: number) => (index === 20 ? stateOf("ancient_debris") : AIR) } },
      {
        data: {
          palette: [AIR, stateOf("stone"), stateOf("water")],
          get: (index: number) => {
            const y = index >> 8;
            const horizontalIndex = index & 0xff;
            if (y === 15 && horizontalIndex < surfaceWaterCells) return stateOf("water");
            return y === 14 ? stateOf("stone") : AIR;
          },
        },
      },
      { data: { value: AIR, get: () => AIR } },
    ],
    biomes: [{ data: { palette: [biomeId("plains"), biomeId("forest")],
      get: (index: number) => (index < 16 ? biomeId("forest") : biomeId("plains")) } }],
  };
  const columns = [{ chunkX: -2, chunkZ: 4, column }];
  const { bot } = createFakeBot();
  // Stopgap until the master's chunk-column task merges `world.getColumns` into the shared fake (gap reported 2026-10-21): this one column is loaded.
  Object.assign(bot.world, { getColumns: () => columns, getColumn: () => column });
  const data = temporaryBotData();
  return { events: bot, bot, column, data };
}

test("records useful materials and counted biomes once for each loaded chunk", async (t) => {
  const { events, bot, data } = fixture();
  const frontier = attachSessionFrontier(bot, data);
  const recorded: Array<{ dimension: string; chunkX: number; chunkZ: number }> = [];
  frontier.onRecorded((chunk) => recorded.push(chunk));
  t.after(() => {
    frontier.close();
    data.close();
  });

  events.emit("chunkColumnLoad", new Vec3(48, 0, -32));
  events.emit("chunkColumnLoad", new Vec3(48, 0, -32));
  await frontier.idle();

  assert.deepEqual(
    data.read("SELECT chunk_key, dimension, chunk_x, chunk_z FROM frontier_chunks ORDER BY chunk_x, chunk_z"),
    [
      { chunk_key: "overworld|-2|4", dimension: "overworld", chunk_x: -2, chunk_z: 4 },
      { chunk_key: "overworld|3|-2", dimension: "overworld", chunk_x: 3, chunk_z: -2 },
    ],
  );
  assert.deepEqual(frontier.status(), {
    observedChunks: 2,
    pendingChunks: 0,
    error: null,
  });
  assert.deepEqual(recorded, [
    { dimension: "overworld", chunkX: -2, chunkZ: 4 },
    { dimension: "overworld", chunkX: 3, chunkZ: -2 },
  ]);
  assert.equal(frontier.boundary("overworld", { x: 1, z: 0 }), 3);
  assert.equal(frontier.boundary("overworld", { x: 0, z: -1 }), 2);
  assert.equal(frontier.boundary("the_nether", { x: 1, z: 0 }), null);
  assert.deepEqual(data.read("SELECT DISTINCT material FROM frontier_chunk_materials ORDER BY material"), [
    { material: "ancient_debris" },
    { material: "diamond_ore" },
    { material: "oak_log" },
    { material: "prismarine" },
  ]);
  assert.deepEqual(
    data.read(`
      SELECT c.chunk_x, c.chunk_z
      FROM frontier_chunks AS c
      JOIN frontier_chunk_materials AS m USING (chunk_key)
      WHERE m.material = 'oak_log'
      ORDER BY c.chunk_x, c.chunk_z
    `),
    [
      { chunk_x: -2, chunk_z: 4 },
      { chunk_x: 3, chunk_z: -2 },
    ],
  );
  assert.deepEqual(data.read("SELECT DISTINCT biome FROM frontier_chunk_biomes ORDER BY biome"), [
    { biome: "forest" },
    { biome: "plains" },
  ]);
  assert.deepEqual(
    data.read(
      "SELECT biome, sample_count FROM frontier_chunk_biomes WHERE chunk_key = 'overworld|3|-2' ORDER BY biome",
    ),
    [
      { biome: "forest", sample_count: 16 },
      { biome: "plains", sample_count: 48 },
    ],
  );
  const enrichment = data.read(`
    SELECT scanned_at, surface_water_fraction
    FROM frontier_chunks
    WHERE chunk_x = 3 AND chunk_z = -2
  `)[0];
  assert.equal(typeof enrichment?.scanned_at, "string");
  assert.equal(enrichment?.surface_water_fraction, 129 / 256);
});

test("clears a chunk's frontier flag once all four neighbours are recorded", async (t) => {
  const { events, bot, data } = fixture();
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    frontier.close();
    data.close();
  });
  await frontier.idle();

  events.emit("chunkColumnLoad", new Vec3(-32, 0, 48));
  events.emit("chunkColumnLoad", new Vec3(-16, 0, 64));
  events.emit("chunkColumnLoad", new Vec3(-32, 0, 80));
  events.emit("chunkColumnLoad", new Vec3(-48, 0, 64));
  await frontier.idle();

  assert.deepEqual(
    data.read(`
      SELECT chunk_x, chunk_z, is_frontier
      FROM frontier_chunks
      ORDER BY chunk_z, chunk_x
    `),
    [
      { chunk_x: -2, chunk_z: 3, is_frontier: 1 },
      { chunk_x: -3, chunk_z: 4, is_frontier: 1 },
      { chunk_x: -2, chunk_z: 4, is_frontier: 0 },
      { chunk_x: -1, chunk_z: 4, is_frontier: 1 },
      { chunk_x: -2, chunk_z: 5, is_frontier: 1 },
    ],
  );
});

test("reports only chunks committed by this session observer", async (t) => {
  const { bot, data } = fixture();
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    frontier.close();
    data.close();
  });
  await frontier.idle();

  const recorded: Array<{ dimension: string; chunkX: number; chunkZ: number }> = [];
  const unsubscribe = frontier.onRecorded((chunk) => recorded.push(chunk));
  data.transaction((database) => {
    database
      .prepare(
        `
        INSERT INTO frontier_chunks (
          chunk_key, dimension, chunk_x, chunk_z,
          first_observed_at, scanned_at, surface_water_fraction
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run("overworld|20|20", "overworld", 20, 20, "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.001Z", 0);
  });

  assert.deepEqual(recorded, []);
  assert.equal(frontier.boundary("overworld", { x: 1, z: 0 }), 20);
  unsubscribe();
});

test("a recorded-chunk listener cannot poison frontier health or later listeners", async (t) => {
  const { bot, data } = fixture();
  const frontier = attachSessionFrontier(bot, data);
  const recorded: Array<{ dimension: string; chunkX: number; chunkZ: number }> = [];
  frontier.onRecorded(() => {
    throw new Error("broken consumer");
  });
  frontier.onRecorded((chunk) => recorded.push(chunk));
  t.after(() => {
    frontier.close();
    data.close();
  });

  await frontier.idle();

  assert.deepEqual(frontier.status(), { observedChunks: 1, pendingChunks: 0, error: null });
  assert.deepEqual(recorded, [{ dimension: "overworld", chunkX: -2, chunkZ: 4 }]);
});

test("rejects a chunk key that does not match its dimension and coordinates", (t) => {
  const data = temporaryBotData();
  t.after(() => data.close());

  assert.throws(
    () =>
      data.transaction((database) => {
        database
          .prepare(
            `
            INSERT INTO frontier_chunks (
              chunk_key, dimension, chunk_x, chunk_z,
              first_observed_at, scanned_at, surface_water_fraction
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run("wrong", "overworld", 3, -2, "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.001Z", 0.5);
      }),
    /CHECK constraint failed/,
  );
});

test("records exact surface water coverage rather than only a majority", async (t) => {
  const { bot, data } = fixture(128);
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    frontier.close();
    data.close();
  });

  await frontier.idle();

  assert.equal(data.read("SELECT surface_water_fraction FROM frontier_chunks")[0]?.surface_water_fraction, 0.5);
});

test("does not persist a partial chunk when scanning fails", async (t) => {
  const { bot, column, data } = fixture();
  column.sections[2]!.data.get = () => {
    throw new Error("broken chunk palette");
  };
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    frontier.close();
    data.close();
  });

  await frontier.idle();

  assert.equal(data.read("SELECT COUNT(*) AS count FROM frontier_chunks")[0]?.count, 0);
  assert.match(frontier.status().error ?? "", /broken chunk palette/);
});

test("does not scan an enriched chunk again when it reloads", async (t) => {
  const { events, bot, column, data } = fixture();
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    frontier.close();
    data.close();
  });
  await frontier.idle();

  column.sections[0]!.data.palette!.push(stateOf("birch_log"));
  events.emit("chunkColumnLoad", new Vec3(-32, 0, 64));
  await frontier.idle();

  assert.deepEqual(data.read("SELECT material FROM frontier_chunk_materials ORDER BY material"), [
    { material: "ancient_debris" },
    { material: "diamond_ore" },
    { material: "oak_log" },
    { material: "prismarine" },
  ]);
});

test("a chunk loaded again after the rescan time is scanned again: its materials are what it holds now", async (t) => {
  // Live 2026-10-04: materials kept from the first sight sent bots to logs long cut.
  const { events, bot, column, data } = fixture();
  const frontier = attachSessionFrontier(bot, data);
  const recorded: unknown[] = [];
  frontier.onRecorded((chunk) => recorded.push(chunk));
  t.after(() => {
    frontier.close();
    data.close();
  });
  await frontier.idle();
  const before = frontier.status().observedChunks;
  recorded.length = 0;
  data.transaction((database) => database.prepare("UPDATE frontier_chunks SET scanned_at = ?").run(new Date(Date.now() - RESCAN_AFTER_MS - 1000).toISOString()), { name: "age" });
  column.sections[0]!.data.palette!.push(stateOf("birch_log"));
  events.emit("chunkColumnLoad", new Vec3(-32, 0, 64));
  await frontier.idle();

  assert.ok(data.read("SELECT material FROM frontier_chunk_materials WHERE chunk_key = 'overworld|-2|4'").some((row) => row.material === "birch_log"));
  assert.equal(frontier.status().observedChunks, before, "a rescan is no new chunk");
  assert.deepEqual(recorded, []);
});

test("coalesces repeated chunk loads before scanning", async (t) => {
  const { events, bot, column, data } = fixture();
  let directPaletteReads = 0;
  column.sections[2]!.data.get = (index: number) => {
    directPaletteReads += 1;
    return index === 20 ? stateOf("ancient_debris") : AIR;
  };
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    frontier.close();
    data.close();
  });

  events.emit("chunkColumnLoad", new Vec3(48, 0, -32));
  events.emit("chunkColumnLoad", new Vec3(48, 0, -32));
  await frontier.idle();

  assert.equal(directPaletteReads, 4096 * 2);
});

test("stops recording when the session frontier closes", (t) => {
  const { events, bot, data } = fixture();
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    data.close();
  });

  frontier.close();
  events.emit("chunkColumnLoad", new Vec3(16, 0, 16));

  assert.equal(data.read("SELECT COUNT(*) AS count FROM frontier_chunks")[0]?.count, 0);
});

test("counts the recorded chunks that hold a material; a material the scan leaves out counts none", async (t) => {
  const { events, bot, data } = fixture();
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    frontier.close();
    data.close();
  });
  events.emit("chunkColumnLoad", new Vec3(48, 0, -32));
  events.emit("chunkColumnLoad", new Vec3(-32, 0, 64));
  await frontier.idle();

  assert.equal(frontier.chunksWithMaterial("oak_log"), 2);
  assert.equal(frontier.chunksWithMaterial("pale_oak_log"), 0);
  // Stone is left out of the scan as everywhere: no chunk records it.
  assert.equal(frontier.chunksWithMaterial("stone"), 0);
});

/** A bot whose loaded blocks within reach are `near` (block name -> count), asked as Mineflayer's findBlocks does. */
/** A bot standing in one loaded section whose first `near[name]` cells (x, then z, then y) hold that block. */
function seeingBot(near: Record<string, number>, scans = { count: 0 }): Bot {
  const { bot } = createFakeBot({ position: new Vec3(8, 8, 8) });
  const registry = bot.registry;
  const cells = new Map<number, number>();
  let cell = 0;
  for (const [name, count] of Object.entries(near)) {
    for (let index = 0; index < count; index += 1) cells.set(cell++, registry.blocksByName[name]!.minStateId!);
  }
  const section = {
    solidBlockCount: 4_096,
    palette: [0, ...new Set(cells.values())],
    data: {},
    get: ({ x, y, z }: { x: number; y: number; z: number }) => cells.get(y * 256 + z * 16 + x) ?? 0,
  };
  // Stopgap until the master's chunk-column task merges `world.getColumns` into the shared fake (gap reported 2026-10-21): one loaded section around the bot.
  Object.assign(bot.world, {
    getColumns: () => {
      scans.count += 1;
      return [{ chunkX: 0, chunkZ: 0, column: { minY: 0, sections: [section] } }];
    },
  });
  return bot;
}

test("an item is as seen as the most-seen block it is gathered from: loaded blocks near the bot, or recorded chunks", () => {
  const chunks: Record<string, number> = { oak_log: 12 };
  const frontier = { chunksWithMaterial: (material: string) => chunks[material] ?? 0 };
  const seen = seenInWorld(seeingBot({ stone: 500 }), frontier);
  assert.equal(seen("oak_log"), 12);
  // Near blocks are counted up to the cap.
  assert.equal(seen("cobblestone"), SEEN_CAP);
  assert.equal(seen("pale_oak_log"), 0);
  // Deepslate is neither near nor recorded: cobbled_deepslate is unseen, though stone is common.
  assert.equal(seen("cobbled_deepslate"), 0);
  assert.equal(seenInWorld(seeingBot({ deepslate: 5 }), frontier)("cobbled_deepslate"), 5);
});

test("the planner's repeated questions scan the loaded blocks once while the bot stays put, and again after the TTL or a move", () => {
  const scans = { count: 0 };
  const bot = seeingBot({ oak_log: 3 }, scans);
  let clock = 1_000;
  const seen = seenInWorld(bot, { chunksWithMaterial: () => 0 }, () => clock);
  assert.equal(seen("oak_log"), 3);
  const afterFirst = scans.count;
  assert.ok(afterFirst > 0);
  for (let call = 0; call < 20; call += 1) assert.equal(seen("oak_log"), 3);
  assert.equal(scans.count, afterFirst, "answers are kept");

  clock += SEEN_TTL_MS + 1;
  seen("oak_log");
  assert.ok(scans.count > afterFirst, "scanned again after the TTL");

  const afterTtl = scans.count;
  (bot.entity.position as Vec3).x += SEEN_MOVED + 1;
  seen("oak_log");
  assert.ok(scans.count > afterTtl, "scanned again after a move");
});

test("a scan for a block kind absent from every loaded section reads no block", () => {
  const bot = seeingBot({ oak_log: 3 });
  assert.equal(seenInWorld(bot, { chunksWithMaterial: () => 0 })("pale_oak_log"), 0);
});

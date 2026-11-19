import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { updateBotStatus, type BotStatusSnapshot } from "./bot-status.js";
import { nearestFrontierQuery } from "./nearest-frontier.js";
import { readSqlQuery } from "./sql-query.js";
import { SqlBotData } from "./sql-bot-data.js";
import { frontierChunkExistsQuery, frontierMapBoundsQuery, frontierMapWindowQuery } from "../actions/view-frontier/view-frontier.js";
import { countChunksWithMaterial, recordedBoundary } from "../runtime/frontier.js";
import { recordChunk, temporaryBotData } from "../test-support/bot-data.js";

const DICTIONARY =
  "SELECT database_name, table_name, column_name, description FROM data_dictionary ORDER BY table_name, column_name";

test("describes every queryable table and column, in the terms a model has to read them", (t) => {
  const data = temporaryBotData({ closeAfter: t });

  const schemaObjects = data.read(`
    SELECT name AS table_name
    FROM sqlite_schema
    WHERE type IN ('table', 'view')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);
  const describedObjects = data.read(`
    SELECT table_name
    FROM data_dictionary
    WHERE database_name = 'main' AND column_name IS NULL
    ORDER BY table_name
  `);

  assert.deepEqual(describedObjects, schemaObjects);

  const schemaColumns = data.read(`
    SELECT schema_object.name AS table_name, column_info.name AS column_name
    FROM sqlite_schema AS schema_object
    JOIN pragma_table_xinfo(schema_object.name) AS column_info
    WHERE schema_object.type IN ('table', 'view')
      AND schema_object.name NOT LIKE 'sqlite_%'
      AND column_info.hidden = 0
    ORDER BY schema_object.name, column_info.cid
  `);
  const describedColumns = data.read(`
    SELECT table_name, column_name
    FROM data_dictionary
    WHERE database_name = 'main' AND column_name IS NOT NULL
    ORDER BY table_name, column_name
  `);

  assert.deepEqual(
    describedColumns,
    [...schemaColumns].sort((left, right) =>
      `${String(left.table_name)}|${String(left.column_name)}`.localeCompare(
        `${String(right.table_name)}|${String(right.column_name)}`,
      ),
    ),
  );

  // Coverage alone would be satisfied by empty prose; a description has to say
  // what the value means, key format and unit included.
  assert.deepEqual(
    data.read(`
      SELECT table_name, column_name, description
      FROM data_dictionary
      WHERE database_name = 'world'
        AND table_name = 'frontier_chunks'
        AND column_name IN ('chunk_key', 'surface_water_fraction')
      ORDER BY column_name
    `),
    [
      {
        table_name: "frontier_chunks",
        column_name: "chunk_key",
        description: "Stable world-relative key formatted as dimension|chunk_x|chunk_z.",
      },
      {
        table_name: "frontier_chunks",
        column_name: "surface_water_fraction",
        description:
          "Fraction from 0.0 to 1.0 of the 256 horizontal cells whose highest non-air block is water or a bubble column.",
      },
    ],
  );
});

test("publishes compact map rows with a deterministic dominant biome", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  recordChunk(data, {
    dimension: "minecraft:overworld",
    chunkX: 0,
    chunkZ: 0,
    biomes: [
      ["forest", 10],
      ["plains", 54],
    ],
  });

  assert.deepEqual(data.read("SELECT chunk_x, dominant_biome, biomes FROM frontier_map_chunks"), [
    { chunk_x: 0, dominant_biome: "plains", biomes: "forest, plains" },
  ]);
});

test("rebuilds rather than duplicates the data dictionary when a persistent database reopens", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mine-ai-bot-data-schema-"));
  const options = {
    storage: { kind: "persistent" as const, root },
    identity: { worldId: "dictionary-reopen-test", scope: { kind: "shared" as const } },
  };
  let data = SqlBotData.create(options);
  t.after(() => {
    data.close();
    rmSync(root, { recursive: true, force: true });
  });
  const expected = data.read(DICTIONARY);
  data.close();

  data = SqlBotData.create(options);
  assert.deepEqual(data.read(DICTIONARY), expected);
});

const DIMENSION = "overworld";
const botStatusAt = (botId: string, x: number, z: number): BotStatusSnapshot => ({
  botId, dimension: DIMENSION, x, y: 64, z, chunkX: Math.floor(x / 16), chunkZ: Math.floor(z / 16), yaw: 0, pitch: 0, health: 20, food: 20,
  gameMode: "survival", difficulty: "normal", onGround: true, inWater: false, saturation: 5, timeOfDay: 0, isSleeping: false, isRaining: false, inventory: [],
});

test("is_frontier is 0 only with all four neighbours seen", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  for (const [chunkX, chunkZ] of [[0, 0], [1, 0], [-1, 0], [0, 1]] as const) recordChunk(data, { chunkX, chunkZ });
  const flag = () => data.read("SELECT is_frontier FROM frontier_chunks WHERE chunk_x = 0 AND chunk_z = 0")[0]?.is_frontier;
  assert.equal(flag(), 1, "three neighbours seen: still the frontier");
  recordChunk(data, { chunkX: 0, chunkZ: -1 });
  assert.equal(flag(), 0, "all four seen");
  assert.deepEqual(
    data.read("SELECT chunk_x, chunk_z FROM frontier_chunks WHERE is_frontier = 0"),
    [{ chunk_x: 0, chunk_z: 0 }],
    "the four neighbours each miss one of theirs",
  );
});

test("a neighbour another bot of the world scanned but this file never saw does not clear the flag", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  for (const [chunkX, chunkZ] of [[0, 0], [1, 0], [-1, 0], [0, 1]] as const) recordChunk(data, { chunkX, chunkZ });
  recordChunk(data, { chunkX: 0, chunkZ: -1, seenBy: null });
  assert.equal(data.read("SELECT is_frontier FROM frontier_chunks WHERE chunk_x = 0 AND chunk_z = 0")[0]?.is_frontier, 1);
  assert.equal(data.read("SELECT COUNT(*) AS n FROM world.frontier_chunks")[0]?.n, 5, "the world file holds all five");
});

test("materials of chunks this bot never saw are not in frontier_chunk_materials", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  recordChunk(data, { chunkX: 0, chunkZ: 0, materials: ["oak_log"] });
  recordChunk(data, { chunkX: 5, chunkZ: 5, materials: ["iron_ore"], seenBy: null });
  assert.deepEqual(data.read("SELECT chunk_key, material FROM frontier_chunk_materials"), [{ chunk_key: "overworld|0|0", material: "oak_log" }]);
  assert.deepEqual(data.read("SELECT chunk_key, biome FROM frontier_chunk_biomes"), []);
  assert.deepEqual(data.read("SELECT material FROM world.frontier_chunk_materials ORDER BY material"), [{ material: "iron_ore" }, { material: "oak_log" }]);
});

test("frontier_navigation gives distance and heading as before", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  recordChunk(data, { chunkX: 1, chunkZ: 2 });
  updateBotStatus(data, botStatusAt("bot1", 0, 0));
  assert.deepEqual(data.read("SELECT bot_id, chunk_x, chunk_z, distance_blocks, heading_degrees FROM frontier_navigation"), [
    { bot_id: "bot1", chunk_x: 1, chunk_z: 2, distance_blocks: 46.6, heading_degrees: 149 },
  ]);
});

test("shared scope: two bots' sightings of one chunk show one row", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  recordChunk(data, { chunkX: 3, chunkZ: 4, seenBy: "Ayla", firstSeenAt: "2026-08-20T00:00:05.000Z", materials: ["oak_log"] });
  recordChunk(data, { chunkX: 3, chunkZ: 4, seenBy: "Theo", firstSeenAt: "2026-08-20T00:00:02.000Z", materials: ["oak_log"] });
  assert.equal(data.read("SELECT COUNT(*) AS n FROM main.frontier_seen")[0]?.n, 2);
  assert.deepEqual(data.read("SELECT chunk_key, first_observed_at FROM frontier_chunks"), [
    { chunk_key: "overworld|3|4", first_observed_at: "2026-08-20T00:00:02.000Z" },
  ]);
  assert.deepEqual(data.read("SELECT material FROM frontier_chunk_materials"), [{ material: "oak_log" }], "one row per material, not per bot");
});

test("every frontier reader stays under 50 ms over 31 355 seen chunks", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  seedSeenChunks(data, 31_355);
  updateBotStatus(data, botStatusAt("bot1", 1600, 1200));
  const readers: ReadonlyArray<readonly [string, () => unknown]> = [
    ["nearest frontier", () => readSqlQuery(data, nearestFrontierQuery.bind({ botId: "bot1", dimension: DIMENSION }))],
    ["frontier_navigation", () => data.read("SELECT * FROM frontier_navigation WHERE bot_id = 'bot1' AND dimension = 'overworld' ORDER BY distance_blocks LIMIT 20")],
    ["countChunksWithMaterial", () => countChunksWithMaterial(data, DIMENSION, "oak_log")],
    ["recordedBoundary", () => recordedBoundary(data, DIMENSION, { x: 1, z: 0 })],
    ["observedChunks count", () => data.read("SELECT COUNT(*) AS count FROM frontier_chunks")],
    ["view-frontier bounds", () => readSqlQuery(data, frontierMapBoundsQuery.bind({ dimension: DIMENSION }))],
    ["view-frontier window", () => readSqlQuery(data, frontierMapWindowQuery.bind({ dimension: DIMENSION, minChunkX: 90, maxChunkX: 110, minChunkZ: 70, maxChunkZ: 90 }))],
    ["view-frontier exists", () => readSqlQuery(data, frontierChunkExistsQuery.bind({ dimension: DIMENSION, chunkX: 100, chunkZ: 80 }))],
    // The brain's five queries (brain/src/bot-data-sql.ts) are timed in brain/src/frontier-sql-speed.test.ts: src cannot import brain.
  ];
  const slow: string[] = [];
  const times: string[] = [];
  for (const [name, read] of readers) {
    // The reader's own cost: CPU time of this process (best of five), not wall time, which on a loaded machine counts
    // the slices other processes took (8 CPU burners made the wall time 3 x as long, review 2026-11-19).
    let ms = Infinity;
    for (let run = 0; run < 5; run += 1) {
      const began = process.cpuUsage();
      read();
      const used = process.cpuUsage(began);
      ms = Math.min(ms, (used.user + used.system) / 1000);
    }
    times.push(`${name} ${ms.toFixed(1)} ms`);
    if (ms >= 50) slow.push(`${name} ${ms.toFixed(1)} ms`);
  }
  console.log(`[speed] ${times.join("; ")}`);
  assert.deepEqual(slow, []);
});

/** `count` chunks in a 200-wide block, each with two biomes and (every 7th) a material, scanned in the world file and seen by bot1. */
function seedSeenChunks(data: SqlBotData, count: number): void {
  const keyAt = (i: number) => `${DIMENSION}|${i % 200}|${Math.floor(i / 200)}`;
  data.world.write((database) => {
    const chunk = database.prepare(
      "INSERT INTO frontier_chunks (chunk_key, dimension, chunk_x, chunk_z, first_observed_at, scanned_at, surface_water_fraction) VALUES (?, ?, ?, ?, 't', 't', ?)",
    );
    const material = database.prepare("INSERT INTO frontier_chunk_materials (chunk_key, material) VALUES (?, ?)");
    const biome = database.prepare("INSERT INTO frontier_chunk_biomes (chunk_key, biome, sample_count) VALUES (?, ?, ?)");
    for (let i = 0; i < count; i += 1) {
      chunk.run(keyAt(i), DIMENSION, i % 200, Math.floor(i / 200), (i % 10) / 10);
      if (i % 7 === 0) material.run(keyAt(i), "oak_log");
      biome.run(keyAt(i), "plains", 40);
      biome.run(keyAt(i), "forest", 24);
    }
  }, { name: "seed" });
  data.transaction((database) => {
    const seen = database.prepare("INSERT INTO frontier_seen (bot_id, chunk_key, dimension, chunk_x, chunk_z, first_seen_at) VALUES ('bot1', ?, ?, ?, ?, 't')");
    for (let i = 0; i < count; i += 1) seen.run(keyAt(i), DIMENSION, i % 200, Math.floor(i / 200));
  });
}

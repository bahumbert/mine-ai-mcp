import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { SqlBotData } from "../bot-data/index.js";
import { persistentBotData, recordChunk } from "../test-support/bot-data.js";
import { createFakeBot, createFakeClock } from "../test-support/fake-bot/index.js";
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
function fixture(surfaceWaterCells = 129, options: { readonly username?: string; readonly data?: SqlBotData } = {}) {
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
  // Strings as the game hands them (`prismarine-world/src/world.js:195-203`; the typings say numbers).
  const columns = [{ chunkX: "-2", chunkZ: "4", column }];
  const { bot } = createFakeBot({ username: options.username });
  // Stopgap that stays (T3b-B): the tests script this column's containers (a palette of materials over empty cells, 64 biome
  // samples, a read counter, a read that throws) and every chunk answers it; the fake's columns hold the world's real cells.
  Object.assign(bot.world, { getColumns: () => columns, getColumn: () => column });
  const data = options.data ?? temporaryBotData();
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
    legacyLeft: 0,
    legacyImportError: null,
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
  recordChunk(data, { chunkX: 20, chunkZ: 20 });

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

  assert.deepEqual(frontier.status(), { observedChunks: 1, pendingChunks: 0, error: null, legacyLeft: 0, legacyImportError: null });
  assert.deepEqual(recorded, [{ dimension: "overworld", chunkX: -2, chunkZ: 4 }]);
});

test("the world file rejects a chunk key that does not match its dimension and coordinates", (t) => {
  const data = temporaryBotData();
  t.after(() => data.close());

  assert.throws(
    () =>
      data.world.write((database) => {
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
      }, { name: "test" }),
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
  data.world.write((database) => database.prepare("UPDATE frontier_chunks SET scanned_at = ?").run(new Date(Date.now() - RESCAN_AFTER_MS - 1000).toISOString()), { name: "age" });
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

const UUID_AYLA = "7d2c9f1e-3a4b-4c5d-8e6f-0a1b2c3d4e5f";
const UUID_THEO = "0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e";

/** Two bots of one world, each with its own bot file (identity botId a UUID, username a name) and the world file between them. */
function twoBotsOfOneWorld(t: { after(fn: () => void): void }) {
  const storage = persistentBotData(t);
  const ayla = fixture(129, { username: "Ayla", data: storage.open("shared-world", { kind: "bot", botId: UUID_AYLA }) });
  const theo = fixture(129, { username: "Theo", data: storage.open("shared-world", { kind: "bot", botId: UUID_THEO }) });
  return { ayla, theo };
}

/** Counts the cells a scan of `column` reads: a chunk that is not scanned reads none. */
function countScanReads(column: ReturnType<typeof fixture>["column"]): { count: number } {
  const reads = { count: 0 };
  const original = column.sections[2]!.data.get;
  column.sections[2]!.data.get = (index: number) => {
    reads.count += 1;
    return original(index);
  };
  return reads;
}

/** A clock and a wait that move together: the recorder's retry waits cost no real time and the clock shows them. */
function steppedTime() {
  let now = 1_000_000;
  const waits: number[] = [];
  return {
    waits,
    options: {
      now: () => now,
      random: () => 0.5,
      wait: async (ms: number) => {
        waits.push(ms);
        now += ms;
      },
    },
  };
}

test("a chunk another bot scanned is not scanned again: this bot gets a sighting and onRecorded", async (t) => {
  const { ayla, theo } = twoBotsOfOneWorld(t);
  const first = attachSessionFrontier(ayla.bot, ayla.data);
  await first.idle();
  const reads = countScanReads(theo.column);
  const second = attachSessionFrontier(theo.bot, theo.data);
  const recorded: unknown[] = [];
  second.onRecorded((chunk) => recorded.push(chunk));
  t.after(() => {
    first.close();
    second.close();
  });
  await second.idle();

  assert.equal(reads.count, 0, "the second bot did not scan the chunk");
  assert.deepEqual(recorded, [{ dimension: "overworld", chunkX: -2, chunkZ: 4 }]);
  assert.deepEqual(theo.data.read("SELECT bot_id, chunk_key FROM main.frontier_seen"), [{ bot_id: "Theo", chunk_key: "overworld|-2|4" }]);
  assert.deepEqual(ayla.data.read("SELECT bot_id FROM main.frontier_seen"), [{ bot_id: "Ayla" }], "the username, not the identity's UUID");
  assert.equal(theo.data.read("SELECT COUNT(*) AS n FROM world.frontier_chunks")[0]?.n, 1, "one world row for the two bots");
  assert.ok(theo.data.read("SELECT material FROM frontier_chunk_materials").some((row) => row.material === "oak_log"), "its map has the chunk's materials");
  assert.equal(second.status().observedChunks, 1);
  assert.equal(second.status().error, null);
});

test("a chunk scanned 10+ min ago by another bot is rescanned and its materials replaced", async (t) => {
  const { ayla, theo } = twoBotsOfOneWorld(t);
  const first = attachSessionFrontier(ayla.bot, ayla.data);
  await first.idle();
  ayla.data.world.write((database) => database.prepare("UPDATE frontier_chunks SET scanned_at = ?").run(new Date(Date.now() - RESCAN_AFTER_MS - 1000).toISOString()), { name: "age" });
  theo.column.sections[0]!.data.palette!.push(stateOf("birch_log"));
  const reads = countScanReads(theo.column);
  const second = attachSessionFrontier(theo.bot, theo.data);
  t.after(() => {
    first.close();
    second.close();
  });
  await second.idle();

  assert.ok(reads.count > 0, "the stale chunk was scanned again");
  assert.ok(theo.data.read("SELECT material FROM world.frontier_chunk_materials WHERE chunk_key = 'overworld|-2|4'").some((row) => row.material === "birch_log"));
  assert.equal(theo.data.read("SELECT COUNT(*) AS n FROM world.frontier_chunks")[0]?.n, 1);
  assert.deepEqual(theo.data.read("SELECT bot_id FROM main.frontier_seen"), [{ bot_id: "Theo" }]);
});

test("busy world write re-queues the chunk and records it on a later try", async (t) => {
  const { bot, data } = fixture();
  const original = data.world.write.bind(data.world);
  let busyLeft = 2;
  const attempts: number[] = [];
  t.mock.method(data.world, "write", (...args: Parameters<typeof original>) => {
    attempts.push(1);
    return busyLeft-- > 0 ? { status: "busy" as const } : original(...args);
  });
  const time = steppedTime();
  const frontier = attachSessionFrontier(bot, data, time.options);
  const recorded: unknown[] = [];
  frontier.onRecorded((chunk) => recorded.push(chunk));
  t.after(() => {
    frontier.close();
    data.close();
  });

  await frontier.idle();

  assert.equal(attempts.length, 3, "two busy answers, then the write");
  assert.equal(time.waits.length, 2);
  assert.ok(time.waits.every((ms) => ms >= 20 && ms <= 200), `retry waits ${time.waits.join(", ")} stay within 20-200 ms`);
  assert.equal(data.read("SELECT COUNT(*) AS n FROM frontier_chunks")[0]?.n, 1);
  assert.deepEqual(recorded, [{ dimension: "overworld", chunkX: -2, chunkZ: 4 }]);
  assert.equal(frontier.status().error, null);
  assert.equal(frontier.status().pendingChunks, 0);
});

test("20 busy tries give the scan error, and a later load clears it", async (t) => {
  const { events, bot, data } = fixture();
  t.mock.method(data.world, "write", () => ({ status: "busy" as const }));
  const time = steppedTime();
  const frontier = attachSessionFrontier(bot, data, time.options);
  t.after(() => {
    frontier.close();
    data.close();
  });

  await frontier.idle();

  assert.equal(frontier.status().error, "Chunk overworld|-2|4: world data busy for 20 tries");
  assert.equal(time.waits.length, 19, "a wait between tries, none after the 20th");
  assert.equal(data.read("SELECT COUNT(*) AS n FROM frontier_chunks")[0]?.n, 0);

  t.mock.restoreAll();
  events.emit("chunkColumnLoad", new Vec3(-32, 0, 64));
  await frontier.idle();

  assert.equal(frontier.status().error, null);
  assert.equal(data.read("SELECT COUNT(*) AS n FROM frontier_chunks")[0]?.n, 1);
});

test("close during a retry wait records nothing more", async (t) => {
  const { bot, data } = fixture();
  let writes = 0;
  t.mock.method(data.world, "write", () => {
    writes += 1;
    return { status: "busy" as const };
  });
  let frontier: ReturnType<typeof attachSessionFrontier> | undefined;
  frontier = attachSessionFrontier(bot, data, {
    now: () => 0,
    random: () => 0,
    wait: async () => {
      frontier?.close();
    },
  });
  t.after(() => data.close());

  await frontier.idle();

  assert.equal(writes, 1, "no try after the close");
  assert.equal(frontier.status().pendingChunks, 0);
  assert.equal(data.read("SELECT COUNT(*) AS n FROM main.frontier_seen")[0]?.n, 0);
});

/** A bot whose loaded blocks within reach are `near` (block name -> count): the first cells (x, then z, then y) of chunk 0, 0 hold them. */
function seeingBot(near: Record<string, number>, scans = { count: 0 }): Bot {
  const cells: Record<string, string> = {};
  let cell = 0;
  for (const [name, count] of Object.entries(near)) {
    for (let index = 0; index < count; index += 1, cell += 1) cells[`${cell & 15},${cell >> 8},${(cell >> 4) & 15}`] = name;
  }
  const { bot } = createFakeBot({ position: new Vec3(8, 8, 8), groundY: null, cells, loadedColumns: [[0, 0]] });
  // Counts the scans: each one asks the world for its columns.
  const listColumns = bot.world.getColumns.bind(bot.world);
  Object.assign(bot.world, {
    getColumns: () => {
      scans.count += 1;
      return listColumns();
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

type RingMember = "C" | "N" | "E" | "S" | "W";
const RING_OFFSET: Record<RingMember, readonly [number, number]> = { C: [0, 0], N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

/**
 * The 3x3 spawn ring around `centre`, in the order a login lists it: the four corners, then the centre and its four
 * neighbours in `last` order.
 */
function spawnRing(centre: readonly [number, number], last: readonly RingMember[]): Array<[number, number]> {
  const corners: Array<readonly [number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  return [...corners, ...last.map((member) => RING_OFFSET[member])].map(([dx, dz]) => [centre[0] + dx, centre[1] + dz]);
}

function frontierFlags(data: SqlBotData): Map<string, number> {
  const rows = data.read("SELECT chunk_x, chunk_z, is_frontier FROM frontier_chunks");
  return new Map(rows.map((row) => [`${row.chunk_x},${row.chunk_z}`, Number(row.is_frontier)]));
}

async function flagsAfterAttach(loadedColumns: Array<[number, number]>, t: { after(fn: () => void): void }): Promise<Map<string, number>> {
  const { bot } = createFakeBot({ loadedColumns });
  const data = temporaryBotData();
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    frontier.close();
    data.close();
  });
  await frontier.idle();
  return frontierFlags(data);
}

function assertOnlyCentreIsInner(flags: Map<string, number>, centre: readonly [number, number]): void {
  assert.equal(flags.size, 9);
  for (const [chunk, flag] of flags) assert.equal(flag, chunk === `${centre[0]},${centre[1]}` ? 0 : 1, `chunk ${chunk}`);
}

// Prismarine hands the spawn ring over with string coordinates (`world.js:195-203`): the coordinates must still make
// the keys and the neighbour positions the computed `is_frontier` reads (it is no longer rechecked per insert, so the
// order the ring is listed in does not matter: one order is enough).
test("a spawn ring loaded before the frontier attaches clears the flags of its inner chunks", async (t) => {
  const centre = [-1, -1] as const;
  assertOnlyCentreIsInner(await flagsAfterAttach(spawnRing(centre, ["C", "N", "E", "S", "W"]), t), centre);
});

test("a chunk loaded by event after attach clears the same flag a spawn-ring chunk does", async (t) => {
  const centre = [1, 0] as const;
  const ringWithoutEast = spawnRing(centre, ["C", "N", "S", "W"]);
  const { bot, world } = createFakeBot({ loadedColumns: ringWithoutEast });
  const data = temporaryBotData();
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    frontier.close();
    data.close();
  });
  await frontier.idle();
  assert.equal(frontierFlags(data).get("1,0"), 1, "the east neighbour is missing");

  // The column of chunk (2, 0) loads: Prismarine's `setColumn` emits `chunkColumnLoad` (the fake's `setCell` into an unlisted chunk).
  world.setCell(new Vec3(32, 64, 0), "stone");
  await frontier.idle();

  assert.equal(frontierFlags(data).get("1,0"), 0);
  assertOnlyCentreIsInner(frontierFlags(data), centre);
});

test("a column list that holds a non-integer coordinate is a storage error, the session still attaches and records later chunks", async (t) => {
  const { bot } = createFakeBot({ loadedColumns: [[0, 0]] });
  // Stopgap on the fake's list (T1): the fake lists integer chunks only, so the bad entry is handed over by hand; chunk (0, 0) stays loaded.
  Object.assign(bot.world, { getColumns: () => [{ chunkX: "1.5", chunkZ: "0", column: {} }] });
  const data = temporaryBotData();
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => {
    frontier.close();
    data.close();
  });
  await frontier.idle();

  assert.match(String(frontier.status().error), /Spawn-ring chunks are not recorded.*chunkX.*"1.5"/);
  assert.equal(data.read("SELECT COUNT(*) AS count FROM frontier_chunks")[0]?.count, 0);

  bot.emit("chunkColumnLoad", new Vec3(0, 0, 0));
  await frontier.idle();
  assert.deepEqual(data.read("SELECT chunk_x, chunk_z FROM frontier_chunks"), [{ chunk_x: 0, chunk_z: 0 }]);
  // A recorded chunk does not wipe the report: the spawn ring is still not recorded, and health says so.
  assert.match(String(frontier.status().error), /Spawn-ring chunks are not recorded.*chunkX/);
});

// Plan 2026-10-27-p1-monotonic-clock T5: the scan's TTL is a duration, so the default clock is monotonic.
for (const row of [
  { name: "a wall step forward of 1.2 s does not end it early", advanceMs: SEEN_TTL_MS - 1_000, wallStepMs: 1_200, rescanned: false },
  { name: "a wall step back of 2 s does not stretch it", advanceMs: SEEN_TTL_MS + 500, wallStepMs: -2_000, rescanned: true },
]) {
  test(`seenInWorld rescans after its TTL on the default clock: ${row.name}`, async () => {
    const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
    using _installed = clock.install();
    // The default `now` is bound when seenInWorld is called: step once first so it holds the stepped `Date.now`.
    clock.stepWallClock(5_000);
    const scans = { count: 0 };
    const seen = seenInWorld(seeingBot({ oak_log: 3 }, scans), { chunksWithMaterial: () => 0 });
    seen("oak_log");
    const afterFirst = scans.count;
    await clock.advance(row.advanceMs);
    clock.stepWallClock(row.wallStepMs);
    seen("oak_log");
    assert.equal(scans.count > afterFirst, row.rescanned);
  });
}

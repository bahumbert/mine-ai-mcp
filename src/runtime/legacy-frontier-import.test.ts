import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Vec3 } from "vec3";
import type { BotDataScope } from "../bot-data/bot-data-identity.js";
import type { SqlBotData } from "../bot-data/index.js";
import { persistentBotData, persistentFile } from "../test-support/bot-data.js";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { makeLegacyFrontierFile, type LegacyChunk } from "../test-support/legacy-frontier.js";
import { attachSessionFrontier } from "./frontier.js";
import { startLegacyFrontierImport } from "./legacy-frontier-import.js";

const UUID = "7d2c9f1e-3a4b-4c5d-8e6f-0a1b2c3d4e5f";
const LEGACY_SCAN = "2026-08-20T00:00:01.000Z";

type Storage = ReturnType<typeof persistentBotData>;

/** `count` legacy chunks in a row on the x axis from `from`, each with one material and one biome. */
function chunksFrom(from: number, count: number, extra: Partial<LegacyChunk> = {}): LegacyChunk[] {
  return Array.from({ length: count }, (_, i) => ({ chunkX: from + i, chunkZ: 0, materials: ["oak_log"], biomes: [["plains", 64]], ...extra }));
}

/** A bot file of the runtime before the world file (version 2, the frontier in its own tables), opened by the new code. */
function openLegacy(storage: Storage, worldId: string, scope: BotDataScope, chunks: readonly LegacyChunk[]): SqlBotData {
  const fresh = storage.open(worldId, scope);
  const file = persistentFile(fresh);
  fresh.close();
  makeLegacyFrontierFile(file, chunks);
  return storage.open(worldId, scope);
}

const instant = async () => {};
const count = (data: SqlBotData, table: string) => Number(data.read(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n);
const legacyTables = (data: SqlBotData) =>
  data.read("SELECT name FROM sqlite_schema WHERE name LIKE 'legacy_frontier_%' AND type = 'table' ORDER BY name").map((row) => String(row.name));

test("step 3 renames the tables and drops the views, in O(1)", (t) => {
  const data = openLegacy(persistentBotData(t), "step3", { kind: "bot", botId: UUID }, chunksFrom(0, 3));

  assert.deepEqual(data.read("PRAGMA user_version"), [{ user_version: 3 }]);
  assert.deepEqual(legacyTables(data), ["legacy_frontier_chunk_biomes", "legacy_frontier_chunk_materials", "legacy_frontier_chunks"]);
  assert.equal(count(data, "legacy_frontier_chunks"), 3);
  assert.equal(count(data, "legacy_frontier_chunk_materials"), 3);
  assert.equal(count(data, "legacy_frontier_chunk_biomes"), 3);
  assert.deepEqual(data.read("SELECT name, type FROM sqlite_schema WHERE name IN ('frontier_navigation', 'frontier_map_chunks', 'frontier_chunks')"), [],
    "the main schema keeps no frontier view or table of the old shape");
  assert.equal(count(data, "main.frontier_seen"), 0, "nothing is copied by the step");
  assert.equal(count(data, "frontier_chunks"), 0, "the map is the TEMP view: empty until the import runs");
});

test("the import moves rows to the world and sightings to the bot file under the bot's username", async (t) => {
  const data = openLegacy(persistentBotData(t), "move", { kind: "bot", botId: UUID }, chunksFrom(0, 3, { firstObservedAt: "2026-08-19T10:00:00.000Z" }));

  const run = startLegacyFrontierImport(data, "Ayla");
  assert.equal(run.left(), 3);
  await run.done;

  assert.equal(run.left(), 0);
  assert.equal(run.error(), null);
  assert.deepEqual(data.read("SELECT DISTINCT bot_id FROM main.frontier_seen"), [{ bot_id: "Ayla" }], "the username, not the identity's UUID");
  assert.deepEqual(data.read("SELECT chunk_key, first_seen_at FROM main.frontier_seen ORDER BY chunk_key"), [
    { chunk_key: "overworld|0|0", first_seen_at: "2026-08-19T10:00:00.000Z" },
    { chunk_key: "overworld|1|0", first_seen_at: "2026-08-19T10:00:00.000Z" },
    { chunk_key: "overworld|2|0", first_seen_at: "2026-08-19T10:00:00.000Z" },
  ]);
  assert.equal(count(data, "world.frontier_chunks"), 3);
  assert.equal(count(data, "world.frontier_chunk_materials"), 3);
  assert.equal(count(data, "world.frontier_chunk_biomes"), 3);
  assert.deepEqual(legacyTables(data), [], "the legacy tables are dropped at the end");
  assert.equal(count(data, "frontier_chunks"), 3, "the map shows the imported chunks");
});

// The world already holds a scan of the chunk (water 0.25, material "world_material", biome plains) when the legacy one
// (scanned 2026-08-20T00:00:01Z, water 0.5, material "legacy_material", biome desert) is imported: the newer scan wins.
for (const { name, worldScannedAt, winner } of [
  { name: "an older scan never replaces a newer world row", worldScannedAt: "2026-08-21T00:00:01.000Z", winner: { water: 0.25, material: "world_material", biome: "plains" } },
  { name: "a newer scan replaces the row with its materials and biomes", worldScannedAt: "2026-08-01T00:00:01.000Z", winner: { water: 0.5, material: "legacy_material", biome: "desert" } },
]) {
  test(name, async (t) => {
    const data = openLegacy(persistentBotData(t), "scan-order", { kind: "shared" }, chunksFrom(5, 1, { materials: ["legacy_material"], biomes: [["desert", 30]], waterFraction: 0.5 }));
    data.world.write((database) => {
      database.prepare("INSERT INTO frontier_chunks VALUES ('overworld|5|0', 'overworld', 5, 0, '2026-08-01T00:00:00.000Z', ?, 0.25)").run(worldScannedAt);
      database.prepare("INSERT INTO frontier_chunk_materials VALUES ('overworld|5|0', 'world_material')").run();
      database.prepare("INSERT INTO frontier_chunk_biomes VALUES ('overworld|5|0', 'plains', 10)").run();
    }, { name: "test" });

    await startLegacyFrontierImport(data, "Ayla").done;

    assert.deepEqual(data.read("SELECT surface_water_fraction FROM world.frontier_chunks"), [{ surface_water_fraction: winner.water }]);
    assert.deepEqual(data.read("SELECT material FROM world.frontier_chunk_materials"), [{ material: winner.material }]);
    assert.deepEqual(data.read("SELECT biome FROM world.frontier_chunk_biomes"), [{ biome: winner.biome }]);
    assert.equal(count(data, "main.frontier_seen"), 1, "the bot saw the chunk either way");
    // Shared scope: the sighting is the host's bot name, never the "" of the shared scope.
    assert.deepEqual(data.read("SELECT DISTINCT bot_id FROM main.frontier_seen"), [{ bot_id: "Ayla" }]);
  });
}

test("a busy world write waits and retries", async (t) => {
  const data = openLegacy(persistentBotData(t), "busy", { kind: "shared" }, chunksFrom(0, 4));
  const original = data.world.write.bind(data.world);
  let busyLeft = 3;
  t.mock.method(data.world, "write", (...args: Parameters<typeof original>) => (busyLeft-- > 0 ? { status: "busy" as const } : original(...args)));
  const waits: number[] = [];

  const run = startLegacyFrontierImport(data, "Ayla", { wait: async (ms) => void waits.push(ms), random: () => 0.5 });
  await run.done;

  assert.equal(waits.length, 3);
  assert.ok(waits.every((ms) => ms >= 20 && ms <= 200), `waits ${waits.join(", ")} stay within 20-200 ms`);
  assert.equal(count(data, "world.frontier_chunks"), 4);
  assert.equal(count(data, "main.frontier_seen"), 4);
  assert.equal(run.error(), null);
});

test("a crash between the world commit and the bot commit repeats the batch harmlessly", async (t) => {
  const data = openLegacy(persistentBotData(t), "crash", { kind: "shared" }, chunksFrom(0, 4));
  const realTransaction = data.transaction.bind(data);
  let thrown = 0;
  t.mock.method(data, "transaction", ((operation: Parameters<typeof realTransaction>[0], context?: Parameters<typeof realTransaction>[1]) => {
    if (thrown++ === 0) throw new Error("disk went away after the world commit");
    return realTransaction(operation, context);
  }) as typeof realTransaction);

  const first = startLegacyFrontierImport(data, "Ayla", { wait: instant });
  await first.done;
  assert.match(first.error() ?? "", /disk went away/u);
  assert.equal(count(data, "world.frontier_chunks"), 4, "the world commit stands");
  assert.equal(count(data, "main.frontier_seen"), 0, "the bot commit did not happen");
  assert.equal(first.left(), 4);

  const second = startLegacyFrontierImport(data, "Ayla", { wait: instant });
  await second.done;
  assert.equal(second.error(), null);
  assert.equal(count(data, "world.frontier_chunks"), 4, "the repeated batch left the same world rows");
  assert.equal(count(data, "main.frontier_seen"), 4, "the batch's sightings land on the retry");
  assert.deepEqual(legacyTables(data), []);
});

test("a restart resumes from what is left", async (t) => {
  const data = openLegacy(persistentBotData(t), "resume", { kind: "shared" }, chunksFrom(0, 1200));
  const original = data.world.write.bind(data.world);
  let first: ReturnType<typeof startLegacyFrontierImport> | undefined;
  // The close arrives while the first batch is being written: that batch still commits, no other starts.
  t.mock.method(data.world, "write", (...args: Parameters<typeof original>) => {
    first?.stop();
    return original(...args);
  });

  first = startLegacyFrontierImport(data, "Ayla", { wait: instant });
  await first.done;
  assert.equal(first.left(), 700);
  assert.equal(count(data, "main.frontier_seen"), 500);
  assert.equal(count(data, "legacy_frontier_chunks"), 700);

  t.mock.restoreAll();
  const second = startLegacyFrontierImport(data, "Ayla", { wait: instant });
  assert.equal(second.left(), 700);
  await second.done;
  assert.equal(count(data, "world.frontier_chunks"), 1200);
  assert.equal(count(data, "main.frontier_seen"), 1200);
  assert.deepEqual(legacyTables(data), []);
});

test("two imports into one world at once end with the world rows equal to the distinct chunks and each bot's sightings its own", async (t) => {
  const storage = persistentBotData(t);
  // Ayla's chunks 0-1199, Theo's 600-1799: 600 shared. Two bot files, one world file, two connections to it.
  const ayla = openLegacy(storage, "two-at-once", { kind: "bot", botId: "uuid-ayla" }, chunksFrom(0, 1200));
  const theo = openLegacy(storage, "two-at-once", { kind: "bot", botId: "uuid-theo" }, chunksFrom(600, 1200));

  await Promise.all([startLegacyFrontierImport(ayla, "Ayla").done, startLegacyFrontierImport(theo, "Theo").done]);

  assert.equal(count(ayla, "world.frontier_chunks"), 1800);
  assert.equal(count(ayla, "world.frontier_chunk_materials"), 1800);
  assert.equal(count(theo, "world.frontier_chunks"), 1800);
  assert.deepEqual(ayla.read("SELECT bot_id, COUNT(*) AS n FROM main.frontier_seen GROUP BY bot_id"), [{ bot_id: "Ayla", n: 1200 }]);
  assert.deepEqual(theo.read("SELECT bot_id, COUNT(*) AS n FROM main.frontier_seen GROUP BY bot_id"), [{ bot_id: "Theo", n: 1200 }]);
  assert.deepEqual(legacyTables(ayla).concat(legacyTables(theo)), []);
});

test("a file of version 0 with the old frontier tables and views reaches version 3 in one open, and its import works", async (t) => {
  const storage = persistentBotData(t);
  const fresh = storage.open("version-zero", { kind: "bot", botId: UUID });
  const file = persistentFile(fresh);
  fresh.close();
  makeLegacyFrontierFile(file, chunksFrom(0, 3));
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA user_version = 0");
  raw.close();

  const data = storage.open("version-zero", { kind: "bot", botId: UUID });
  await startLegacyFrontierImport(data, "Ayla").done;

  assert.deepEqual(data.read("PRAGMA user_version"), [{ user_version: 3 }]);
  assert.equal(count(data, "frontier_chunks"), 3);
  assert.deepEqual(legacyTables(data), []);
});

test("a file with no legacy tables has nothing to import", async (t) => {
  const data = persistentBotData(t).open("nothing", { kind: "shared" });

  const run = startLegacyFrontierImport(data, "Ayla");

  assert.equal(run.left(), 0);
  await run.done;
  assert.equal(run.error(), null);
});

test("the recorder records while the import runs: a chunk loaded during it gets its sighting once", async (t: TestContext) => {
  const data = openLegacy(persistentBotData(t), "during", { kind: "shared" }, chunksFrom(0, 1200));
  const { bot } = createFakeBot({ username: "Ayla" });
  const air = bot.registry.blocksByName.air!.defaultState!;
  const plains = bot.registry.biomesByName["minecraft:plains"]!.id;
  const column = { sections: [{ data: { value: air, get: () => air } }], biomes: [{ data: { value: plains, get: () => plains } }] };
  // Stopgap, as frontier.test.ts `fixture`: the test scripts the column's palettes, the fake's world holds real cells.
  Object.assign(bot.world, { getColumns: () => [], getColumn: () => column });
  const frontier = attachSessionFrontier(bot, data);
  t.after(() => frontier.close());

  // Chunk (3, 0) is also in the legacy rows still to import.
  bot.emit("chunkColumnLoad", new Vec3(48, 0, 0));
  await frontier.idle();
  await frontier.whenLegacyImported();

  assert.equal(frontier.status().legacyLeft, 0);
  assert.equal(frontier.status().legacyImportError, null);
  assert.equal(frontier.status().observedChunks, 1200, "the chunks the import moved are on the map: health counts them");
  assert.deepEqual(data.read("SELECT COUNT(*) AS n FROM main.frontier_seen WHERE chunk_key = 'overworld|3|0'"), [{ n: 1 }]);
  assert.equal(count(data, "main.frontier_seen"), 1200);
  assert.notEqual(data.read("SELECT scanned_at FROM world.frontier_chunks WHERE chunk_key = 'overworld|3|0'")[0]?.scanned_at, LEGACY_SCAN, "the recorder's newer scan stands");
  assert.deepEqual(legacyTables(data), []);
});

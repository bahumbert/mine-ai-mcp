// Moves the frontier a bot file kept before the world file (tables `legacy_frontier_*`, left by migration step 3) into
// the world file and this bot's sightings. It grows with the world (up to 50 204 rows measured), so it is never a
// migration step: it runs asynchronously after the bot is connected, in batches, and a restart resumes from what is left.
import { setImmediate as yieldToEventLoop, setTimeout as sleep } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";
import { worldWriteRetryDelayMs, type SqlBotData } from "../bot-data/index.js";

/** Chunks moved per world write and per bot transaction. */
const BATCH_CHUNKS = 500;

export interface LegacyFrontierImportOptions {
  /** Waits `ms`, and rejects when the signal aborts. Tests pass their own. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

export interface LegacyFrontierImport {
  /** Settles when the import ended: done, stopped, or failed (see `error`). Never rejects. */
  readonly done: Promise<void>;
  /** Legacy chunks not yet moved. */
  left(): number;
  /** Why the import ended early, or null. A restart resumes it. */
  error(): string | null;
  /** Ends the import after the batch in progress. */
  stop(): void;
}

interface LegacyChunkRow {
  readonly chunk_key: string;
  readonly dimension: string;
  readonly chunk_x: number;
  readonly chunk_z: number;
  readonly first_observed_at: string;
  readonly scanned_at: string;
  readonly surface_water_fraction: number;
}

/** What the legacy tables hold for one batch of chunks, keyed by chunk. */
interface LegacyBatch {
  readonly chunks: readonly LegacyChunkRow[];
  readonly materials: ReadonlyMap<string, readonly string[]>;
  readonly biomes: ReadonlyMap<string, ReadonlyArray<readonly [biome: string, sampleCount: number]>>;
  /** The chunk keys as a JSON array, for `json_each(?)`. */
  readonly keysJson: string;
}

/** One import of one bot file into the world file: batches until the legacy tables are empty, stopped, or failed. */
class LegacyImportRun implements LegacyFrontierImport {
  readonly done: Promise<void>;
  private readonly abort = new AbortController();
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private remaining: number;
  private failure: string | null = null;

  constructor(private readonly data: SqlBotData, private readonly botName: string, options: LegacyFrontierImportOptions) {
    this.wait = options.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }));
    this.random = options.random ?? Math.random;
    const hasLegacy = legacyTableExists(data);
    this.remaining = hasLegacy ? Number(data.read("SELECT COUNT(*) AS n FROM legacy_frontier_chunks")[0]?.n ?? 0) : 0;
    this.done = hasLegacy ? this.run().catch((cause: unknown) => this.fail(cause)) : Promise.resolve();
  }

  left(): number {
    return this.remaining;
  }

  error(): string | null {
    return this.failure;
  }

  stop(): void {
    this.abort.abort();
  }

  private async run(): Promise<void> {
    // The first batch is not read inside the caller's call: attaching a session must not wait for it.
    await yieldToEventLoop();
    while (!this.abort.signal.aborted) {
      const batch = readBatch(this.data);
      if (batch === null) {
        dropLegacyTables(this.data);
        this.remaining = 0;
        return;
      }
      await this.moveBatch(batch);
      await yieldToEventLoop();
    }
  }

  /** A stop is no failure; anything else ends the import with its reason, and the next start resumes it. */
  private fail(cause: unknown): void {
    if (this.abort.signal.aborted) return;
    this.failure = `Legacy frontier import stopped (a restart resumes it): ${cause instanceof Error ? cause.message : String(cause)}`;
  }

  private async moveBatch(batch: LegacyBatch): Promise<void> {
    // The world commit first, the bot commit second: a crash between them repeats this batch, and the repeat changes
    // nothing (the world keeps the newer scan, the sighting insert ignores its duplicate).
    for (;;) {
      const written = this.data.world.write((database) => upsertScans(database, batch), { name: "legacyFrontierImport" });
      if (written.status === "written") break;
      await this.wait(worldWriteRetryDelayMs(this.random), this.abort.signal);
    }
    this.data.transaction((database) => recordSightingsAndForget(database, this.botName, batch), { name: "legacyFrontierImportBatch" });
    this.remaining -= batch.chunks.length;
  }
}

export function startLegacyFrontierImport(data: SqlBotData, botName: string, options: LegacyFrontierImportOptions = {}): LegacyFrontierImport {
  return new LegacyImportRun(data, botName, options);
}

/** The bot's sightings of the batch (first seen when the old row first observed it), then the batch leaves the legacy tables. */
function recordSightingsAndForget(database: DatabaseSync, botName: string, batch: LegacyBatch): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO frontier_seen (bot_id, chunk_key, dimension, chunk_x, chunk_z, first_seen_at)
       SELECT ?, chunk_key, dimension, chunk_x, chunk_z, first_observed_at
       FROM legacy_frontier_chunks WHERE chunk_key IN (SELECT value FROM json_each(?))`,
    )
    .run(botName, batch.keysJson);
  for (const table of ["legacy_frontier_chunk_materials", "legacy_frontier_chunk_biomes", "legacy_frontier_chunks"]) {
    database.prepare(`DELETE FROM ${table} WHERE chunk_key IN (SELECT value FROM json_each(?))`).run(batch.keysJson);
  }
}

function legacyTableExists(data: SqlBotData): boolean {
  return data.read("SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = 'legacy_frontier_chunks'").length > 0;
}

/** The next chunks in key order with their materials and biomes; null when none is left. */
function readBatch(data: SqlBotData): LegacyBatch | null {
  const chunks = data.read(
    `SELECT chunk_key, dimension, chunk_x, chunk_z, first_observed_at, scanned_at, surface_water_fraction
     FROM legacy_frontier_chunks ORDER BY chunk_key LIMIT ?`,
    BATCH_CHUNKS,
  ) as unknown as LegacyChunkRow[];
  if (chunks.length === 0) return null;
  const keysJson = JSON.stringify(chunks.map((chunk) => chunk.chunk_key));
  const materials = new Map<string, string[]>();
  for (const row of data.read("SELECT chunk_key, material FROM legacy_frontier_chunk_materials WHERE chunk_key IN (SELECT value FROM json_each(?))", keysJson)) {
    const key = String(row.chunk_key);
    materials.set(key, [...(materials.get(key) ?? []), String(row.material)]);
  }
  const biomes = new Map<string, Array<readonly [string, number]>>();
  for (const row of data.read("SELECT chunk_key, biome, sample_count FROM legacy_frontier_chunk_biomes WHERE chunk_key IN (SELECT value FROM json_each(?))", keysJson)) {
    const key = String(row.chunk_key);
    biomes.set(key, [...(biomes.get(key) ?? []), [String(row.biome), Number(row.sample_count)] as const]);
  }
  return { chunks, materials, biomes, keysJson };
}

/** Inserts each chunk, or replaces its row only when this scan is newer; materials and biomes follow the rows that changed. */
function upsertScans(database: DatabaseSync, batch: LegacyBatch): void {
  const upsert = database.prepare(
    `INSERT INTO frontier_chunks (chunk_key, dimension, chunk_x, chunk_z, first_observed_at, scanned_at, surface_water_fraction)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (chunk_key) DO UPDATE SET scanned_at = excluded.scanned_at, surface_water_fraction = excluded.surface_water_fraction
     WHERE excluded.scanned_at > frontier_chunks.scanned_at
     RETURNING chunk_key`,
  );
  const clearMaterials = database.prepare("DELETE FROM frontier_chunk_materials WHERE chunk_key = ?");
  const clearBiomes = database.prepare("DELETE FROM frontier_chunk_biomes WHERE chunk_key = ?");
  const insertMaterial = database.prepare("INSERT INTO frontier_chunk_materials (chunk_key, material) VALUES (?, ?)");
  const insertBiome = database.prepare("INSERT INTO frontier_chunk_biomes (chunk_key, biome, sample_count) VALUES (?, ?, ?)");
  for (const chunk of batch.chunks) {
    const changed = upsert.all(chunk.chunk_key, chunk.dimension, chunk.chunk_x, chunk.chunk_z, chunk.first_observed_at, chunk.scanned_at, chunk.surface_water_fraction);
    if (changed.length === 0) continue;
    clearMaterials.run(chunk.chunk_key);
    clearBiomes.run(chunk.chunk_key);
    for (const material of batch.materials.get(chunk.chunk_key) ?? []) insertMaterial.run(chunk.chunk_key, material);
    for (const [biome, sampleCount] of batch.biomes.get(chunk.chunk_key) ?? []) insertBiome.run(chunk.chunk_key, biome, sampleCount);
  }
}

function dropLegacyTables(data: SqlBotData): void {
  data.transaction((database) => {
    for (const table of ["legacy_frontier_chunk_materials", "legacy_frontier_chunk_biomes", "legacy_frontier_chunks"]) {
      database.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  }, { name: "legacyFrontierImportEnd" });
}

// A bot file as the runtime before the world file left it (user_version 2): the frontier in three tables of the bot's own
// file, with the two views over them. Tests migrate it with the new code (migrations step 3, the legacy import).
import { DatabaseSync } from "node:sqlite";

export interface LegacyChunk {
  readonly dimension?: string;
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly firstObservedAt?: string;
  readonly scannedAt?: string;
  readonly waterFraction?: number;
  readonly materials?: readonly string[];
  readonly biomes?: ReadonlyArray<readonly [biome: string, sampleCount: number]>;
}

const LEGACY_FRONTIER_SCHEMA = `
  DROP TABLE IF EXISTS frontier_seen;
  CREATE TABLE frontier_chunks (
    chunk_key TEXT PRIMARY KEY,
    dimension TEXT NOT NULL,
    chunk_x INTEGER NOT NULL,
    chunk_z INTEGER NOT NULL,
    first_observed_at TEXT NOT NULL,
    scanned_at TEXT NOT NULL,
    surface_water_fraction REAL NOT NULL CHECK (surface_water_fraction BETWEEN 0.0 AND 1.0),
    is_frontier INTEGER NOT NULL DEFAULT 1 CHECK (is_frontier IN (0, 1)),
    CHECK (chunk_key = dimension || '|' || chunk_x || '|' || chunk_z),
    UNIQUE (dimension, chunk_x, chunk_z)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE frontier_chunk_materials (
    chunk_key TEXT NOT NULL,
    material TEXT NOT NULL,
    PRIMARY KEY (chunk_key, material),
    FOREIGN KEY (chunk_key) REFERENCES frontier_chunks (chunk_key) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX frontier_chunk_materials_by_material ON frontier_chunk_materials (material);
  CREATE TABLE frontier_chunk_biomes (
    chunk_key TEXT NOT NULL,
    biome TEXT NOT NULL,
    sample_count INTEGER NOT NULL CHECK (sample_count > 0),
    PRIMARY KEY (chunk_key, biome),
    FOREIGN KEY (chunk_key) REFERENCES frontier_chunks (chunk_key) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX frontier_chunk_biomes_by_biome ON frontier_chunk_biomes (biome);
  CREATE VIEW frontier_map_chunks AS
  SELECT c.dimension, c.chunk_x, c.chunk_z, c.surface_water_fraction, c.is_frontier,
    (SELECT b.biome FROM frontier_chunk_biomes AS b WHERE b.chunk_key = c.chunk_key ORDER BY b.sample_count DESC, b.biome LIMIT 1) AS dominant_biome
  FROM frontier_chunks AS c;
  CREATE VIEW frontier_navigation AS
  SELECT s.bot_id, c.dimension, c.chunk_x, c.chunk_z, c.dominant_biome, c.surface_water_fraction, c.is_frontier,
    round(sqrt(pow((c.chunk_x * 16 + 8) - s.x, 2) + pow((c.chunk_z * 16 + 8) - s.z, 2)), 1) AS distance_blocks,
    0.0 AS heading_degrees
  FROM frontier_map_chunks AS c JOIN bot_status AS s ON s.dimension = c.dimension;`;

/**
 * Turns a closed bot file (made by the current code) into one of version 2 with its frontier in the old tables, holding
 * `chunks`. The file must not be open elsewhere.
 */
export function makeLegacyFrontierFile(file: string, chunks: readonly LegacyChunk[]): void {
  const database = new DatabaseSync(file);
  try {
    database.exec("DROP VIEW IF EXISTS frontier_map_chunks; DROP VIEW IF EXISTS frontier_navigation;");
    database.exec(LEGACY_FRONTIER_SCHEMA);
    database.exec("BEGIN");
    const insertChunk = database.prepare(
      "INSERT INTO frontier_chunks (chunk_key, dimension, chunk_x, chunk_z, first_observed_at, scanned_at, surface_water_fraction, is_frontier) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
    );
    const insertMaterial = database.prepare("INSERT INTO frontier_chunk_materials (chunk_key, material) VALUES (?, ?)");
    const insertBiome = database.prepare("INSERT INTO frontier_chunk_biomes (chunk_key, biome, sample_count) VALUES (?, ?, ?)");
    for (const chunk of chunks) {
      const dimension = chunk.dimension ?? "overworld";
      const key = `${dimension}|${chunk.chunkX}|${chunk.chunkZ}`;
      insertChunk.run(
        key,
        dimension,
        chunk.chunkX,
        chunk.chunkZ,
        chunk.firstObservedAt ?? "2026-08-20T00:00:00.000Z",
        chunk.scannedAt ?? "2026-08-20T00:00:01.000Z",
        chunk.waterFraction ?? 0,
      );
      for (const material of chunk.materials ?? []) insertMaterial.run(key, material);
      for (const [biome, samples] of chunk.biomes ?? []) insertBiome.run(key, biome, samples);
    }
    database.exec("COMMIT");
    database.exec("PRAGMA user_version = 2");
  } finally {
    database.close();
  }
}

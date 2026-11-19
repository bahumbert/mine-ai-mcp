-- The world file: what every bot of one world learns the same way (the chunk scans), once per world.
-- Latest shape only; a change of an existing table is a step in migrations.ts (WORLD_DATA_STEPS).
CREATE TABLE IF NOT EXISTS sql_bot_data_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS frontier_chunks (
  chunk_key TEXT PRIMARY KEY,
  dimension TEXT NOT NULL,
  chunk_x INTEGER NOT NULL,
  chunk_z INTEGER NOT NULL,
  first_observed_at TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  surface_water_fraction REAL NOT NULL CHECK (surface_water_fraction BETWEEN 0.0 AND 1.0),
  CHECK (chunk_key = dimension || '|' || chunk_x || '|' || chunk_z),
  UNIQUE (dimension, chunk_x, chunk_z)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS frontier_chunk_materials (
  chunk_key TEXT NOT NULL,
  material TEXT NOT NULL,
  PRIMARY KEY (chunk_key, material),
  FOREIGN KEY (chunk_key)
    REFERENCES frontier_chunks (chunk_key)
    ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS frontier_chunk_materials_by_material
  ON frontier_chunk_materials (material);

CREATE TABLE IF NOT EXISTS frontier_chunk_biomes (
  chunk_key TEXT NOT NULL,
  biome TEXT NOT NULL,
  sample_count INTEGER NOT NULL CHECK (sample_count > 0),
  PRIMARY KEY (chunk_key, biome),
  FOREIGN KEY (chunk_key)
    REFERENCES frontier_chunks (chunk_key)
    ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS frontier_chunk_biomes_by_biome
  ON frontier_chunk_biomes (biome);

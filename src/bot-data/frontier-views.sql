-- The frontier names a bot reads, as TEMP views over this bot file's sightings (main.frontier_seen) and the world file
-- (attached read-only as `world`): each bot sees the chunks it saw, with the world's scan of them. A main view over
-- an attached file is refused, so they are TEMP, created on every open; unqualified names find them before any table.
CREATE TEMP VIEW frontier_chunks AS
SELECT
  w.chunk_key,
  w.dimension,
  w.chunk_x,
  w.chunk_z,
  (SELECT MIN(s.first_seen_at) FROM main.frontier_seen AS s WHERE s.chunk_key = w.chunk_key) AS first_observed_at,
  w.scanned_at,
  w.surface_water_fraction,
  CASE WHEN
    EXISTS (SELECT 1 FROM main.frontier_seen AS n WHERE n.dimension = w.dimension AND n.chunk_x = w.chunk_x + 1 AND n.chunk_z = w.chunk_z)
    AND EXISTS (SELECT 1 FROM main.frontier_seen AS n WHERE n.dimension = w.dimension AND n.chunk_x = w.chunk_x - 1 AND n.chunk_z = w.chunk_z)
    AND EXISTS (SELECT 1 FROM main.frontier_seen AS n WHERE n.dimension = w.dimension AND n.chunk_x = w.chunk_x AND n.chunk_z = w.chunk_z - 1)
    AND EXISTS (SELECT 1 FROM main.frontier_seen AS n WHERE n.dimension = w.dimension AND n.chunk_x = w.chunk_x AND n.chunk_z = w.chunk_z + 1)
  THEN 0 ELSE 1 END AS is_frontier
FROM world.frontier_chunks AS w
WHERE EXISTS (SELECT 1 FROM main.frontier_seen AS s WHERE s.chunk_key = w.chunk_key);

CREATE TEMP VIEW frontier_chunk_materials AS
SELECT m.chunk_key, m.material
FROM world.frontier_chunk_materials AS m
WHERE m.chunk_key IN (SELECT chunk_key FROM main.frontier_seen);

CREATE TEMP VIEW frontier_chunk_biomes AS
SELECT b.chunk_key, b.biome, b.sample_count
FROM world.frontier_chunk_biomes AS b
WHERE b.chunk_key IN (SELECT chunk_key FROM main.frontier_seen);

CREATE TEMP VIEW frontier_map_chunks AS
SELECT
  c.dimension,
  c.chunk_x,
  c.chunk_z,
  c.surface_water_fraction,
  c.is_frontier,
  (
    SELECT b.biome
    FROM frontier_chunk_biomes AS b
    WHERE b.chunk_key = c.chunk_key
    ORDER BY b.sample_count DESC, b.biome
    LIMIT 1
  ) AS dominant_biome,
  (
    SELECT group_concat(biome, ', ')
    FROM (
      SELECT biome
      FROM frontier_chunk_biomes
      WHERE chunk_key = c.chunk_key
      ORDER BY biome
    )
  ) AS biomes,
  (
    SELECT group_concat(material, ', ')
    FROM (
      SELECT material
      FROM frontier_chunk_materials
      WHERE chunk_key = c.chunk_key
      ORDER BY material
    )
  ) AS materials
FROM frontier_chunks AS c;

CREATE TEMP VIEW frontier_navigation AS
SELECT
  s.bot_id,
  c.dimension,
  c.chunk_x,
  c.chunk_z,
  c.dominant_biome,
  c.surface_water_fraction,
  c.is_frontier,
  round(sqrt(pow((c.chunk_x * 16 + 8) - s.x, 2) + pow((c.chunk_z * 16 + 8) - s.z, 2)), 1) AS distance_blocks,
  round(mod(mod(degrees(atan2((c.chunk_x * 16 + 8) - s.x, -((c.chunk_z * 16 + 8) - s.z))), 360) + 360, 360), 1) AS heading_degrees
FROM frontier_map_chunks AS c
JOIN main.bot_status AS s ON s.dimension = c.dimension;

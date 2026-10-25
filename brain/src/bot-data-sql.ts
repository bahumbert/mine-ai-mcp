// SQL the brain asks of the bot's own data: the dimension condition, its own containers, and the explored-chunk map by dimension.
import type { Position } from "./runtime-client.ts";

/**
 * A SQL condition true for rows of `column` in `dimension`, whichever spelling the server stored (`overworld` or
 * `minecraft:overworld`: `use_container` stores `bot.game.dimension`); null for a value that could break the literal.
 */
export function sameDimensionSql(column: string, dimension: string): string | null {
  if (!/^[a-z0-9_.:/-]{1,64}$/u.test(dimension)) return null;
  return `replace(${column}, 'minecraft:', '') = '${dimension.replace(/^minecraft:/u, "")}'`;
}

/**
 * The statement listing `owner`'s own containers in `dimension` within `within` blocks of `near` (horizontally), nearest
 * first, as rows `x, y, z, block name, slot count, used slots`: the ones it placed (`placed_containers`, the slots from
 * its last opening, null when never opened) and the ones it opened inside a protected region it owns. Null for an owner
 * or a dimension that could break the SQL literals (only the characters of a Minecraft username and a dimension id).
 */
export function ownContainersSql(owner: string, near: Position, within: number, dimension: string): string | null {
  const placedHere = sameDimensionSql("p.dimension", dimension);
  const openedHere = sameDimensionSql("c.dimension", dimension);
  const regionHere = sameDimensionSql("r.dimension", dimension);
  if (!/^\w{1,16}$/u.test(owner) || placedHere === null || openedHere === null || regionHere === null) return null;
  const [x, z, reach] = [Math.floor(near.x), Math.floor(near.z), Math.floor(within)];
  const squared = `((x - (${x})) * (x - (${x})) + (z - (${z})) * (z - (${z})))`;
  return "SELECT x, y, z, name, slots, used FROM (" +
    "SELECT p.block_x AS x, p.block_y AS y, p.block_z AS z, p.block_name AS name, c.slot_count AS slots, json_array_length(c.contents_json) AS used " +
    `FROM placed_containers p LEFT JOIN observed_containers c ON c.container_key = p.container_key WHERE p.placed_by_bot_id = '${owner}' AND ${placedHere} ` +
    "UNION " +
    "SELECT c.block_x, c.block_y, c.block_z, c.block_name, c.slot_count, json_array_length(c.contents_json) " +
    `FROM observed_containers c JOIN protected_regions r ON ${regionHere} AND lower(r.owner) = lower('${owner}') ` +
    "AND c.block_x BETWEEN r.min_x AND r.max_x AND c.block_y BETWEEN r.min_y AND r.max_y AND c.block_z BETWEEN r.min_z AND r.max_z " +
    `WHERE ${openedHere}) WHERE ${squared} <= ${reach * reach} ORDER BY ${squared}`;
}

/** `(chunk_x - cx)² + (chunk_z - cz)²` of the chunk middles, for the table aliased `prefix` ("c." or ""). */
const chunkDistanceSql = (prefix: string, x: number, z: number) =>
  `((${prefix}chunk_x * 16 + 8 - (${Math.floor(x)})) * (${prefix}chunk_x * 16 + 8 - (${Math.floor(x)})) + (${prefix}chunk_z * 16 + 8 - (${Math.floor(z)})) * (${prefix}chunk_z * 16 + 8 - (${Math.floor(z)})))`;

/** True for a Minecraft id, safe inside an SQL literal (the step schemas check it too). */
const isBlockId = (block: string) => /^[a-z0-9_]+$/u.test(block);

/**
 * The explored chunk of `block` nearest to `from`, as `dimension, middle x, middle z`: one in this dimension beyond
 * `beyond` blocks first; none, one in another dimension (named by its stored dimension). Null for a value that could
 * break the literals.
 */
export function seenAtSql(block: string, from: Position, beyond: number, dimension: string): string | null {
  const here = sameDimensionSql("c.dimension", dimension);
  if (!isBlockId(block) || here === null) return null;
  const squared = chunkDistanceSql("c.", from.x, from.z);
  const far = Math.floor(beyond);
  return "SELECT c.dimension, c.chunk_x * 16 + 8, c.chunk_z * 16 + 8 FROM frontier_chunk_materials m JOIN frontier_chunks c ON c.chunk_key = m.chunk_key " +
    `WHERE m.material = '${block}' AND (NOT (${here}) OR ${squared} > ${far * far}) ORDER BY (NOT (${here})), ${squared} LIMIT 1`;
}

/** The chunk middles (`x, z`) of this dimension where `block` was seen, farther than `beyond`, nearest first, at most `limit`. */
export function seenPlacesSql(block: string, from: Position, beyond: number, limit: number, dimension: string): string | null {
  const here = sameDimensionSql("c.dimension", dimension);
  if (!isBlockId(block) || here === null) return null;
  const squared = chunkDistanceSql("c.", from.x, from.z);
  const far = Math.floor(beyond);
  return "SELECT c.chunk_x * 16 + 8, c.chunk_z * 16 + 8 FROM frontier_chunk_materials m JOIN frontier_chunks c ON c.chunk_key = m.chunk_key " +
    `WHERE m.material = '${block}' AND ${here} AND ${squared} > ${far * far} ORDER BY ${squared} LIMIT ${Math.max(1, Math.floor(limit))}`;
}

const chunkListSql = (chunks: readonly (readonly [number, number])[]) => chunks.map(([x, z]) => `(chunk_x = ${Math.floor(x)} AND chunk_z = ${Math.floor(z)})`).join(" OR ");

/** How many of these chunks of `dimension` were explored, and their mean surface water share (`COUNT, AVG`). */
export function waterShareSql(chunks: readonly (readonly [number, number])[], dimension: string): string | null {
  const here = sameDimensionSql("dimension", dimension);
  return here === null ? null : `SELECT COUNT(*), AVG(surface_water_fraction) FROM frontier_chunks WHERE ${here} AND (${chunkListSql(chunks)})`;
}

/** The explored ones (`chunk_x, chunk_z`) of these chunks of `dimension`. */
export function exploredChunksSql(chunks: readonly (readonly [number, number])[], dimension: string): string | null {
  const here = sameDimensionSql("dimension", dimension);
  return here === null ? null : `SELECT chunk_x, chunk_z FROM frontier_chunks WHERE ${here} AND (${chunkListSql(chunks)})`;
}

/** The middle (`x, z`) of the explored chunk of `dimension` nearest to `from` whose surface is mostly land. */
export function nearestLandSql(from: Position, dimension: string): string | null {
  const here = sameDimensionSql("dimension", dimension);
  return here === null ? null : `SELECT chunk_x * 16 + 8, chunk_z * 16 + 8 FROM frontier_chunks WHERE ${here} AND surface_water_fraction < 0.5 ORDER BY ${chunkDistanceSql("", from.x, from.z)} LIMIT 1`;
}

/** Whether two dimension names are the same dimension, whichever spelling (`overworld`, `minecraft:overworld`). */
export const sameDimension = (a: string, b: string) => a.replace(/^minecraft:/u, "") === b.replace(/^minecraft:/u, "");

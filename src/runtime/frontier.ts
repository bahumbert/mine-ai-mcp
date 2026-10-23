import type { Bot } from "mineflayer";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Vec3 } from "vec3";
import { findLoadedBlockPositions } from "../world/loaded-block-scan.js";
import { SqlBotData } from "../bot-data/index.js";
import { ExecutionScope } from "../execution/execution-scope.js";
import { sourcesOf } from "../world/block-drops.js";
import { CHUNK_WIDTH, chunkPosition, loadedColumns } from "../world/chunks.js";

export interface SessionFrontierStatus {
  observedChunks: number;
  pendingChunks: number;
  error: string | null;
}

export interface FrontierChunk {
  readonly dimension: string;
  readonly chunkX: number;
  readonly chunkZ: number;
}

export interface SessionFrontier extends Disposable {
  status(): SessionFrontierStatus;
  idle(): Promise<void>;
  boundary(dimension: string, direction: { readonly x: number; readonly z: number }): number | null;
  /**
   * How many recorded chunks of the bot's dimension hold this block. The scan leaves out the blocks found nearly
   * everywhere (stone, dirt, water...): none are recorded, so they count 0.
   */
  chunksWithMaterial(material: string): number;
  onRecorded(listener: (chunk: FrontierChunk) => void): () => void;
  close(): void;
}

interface PaletteContainer {
  palette?: number[];
  value?: number;
  get(index: number): number;
}

interface LoadedColumn {
  sections: Array<{ data: PaletteContainer }>;
  biomes: Array<{ data: PaletteContainer }>;
}

interface PendingChunk extends FrontierChunk {
  firstObservedAt: string;
  column: LoadedColumn;
  /** Already recorded: its materials, biomes and water are scanned again and replace the old ones. */
  rescan?: boolean;
}

/**
 * A recorded chunk loaded again after this long is scanned again: the world changes (trees cut, houses built), and a
 * material list kept from the first sight sent bots to logs long gone (live 2026-10-04).
 */
export const RESCAN_AFTER_MS = 10 * 60_000;

type SurfaceKind = "air" | "water" | "other";

const SECTION_HEIGHT = 16;
const CHUNK_SURFACE_CELLS = CHUNK_WIDTH * CHUNK_WIDTH;
const AIR_BLOCKS = new Set(["air", "cave_air", "void_air"]);
const SURFACE_WATER_BLOCKS = new Set(["water", "bubble_column"]);

const ROUTINE_MATERIALS = new Set([
  "air",
  "cave_air",
  "void_air",
  "stone",
  "granite",
  "diorite",
  "andesite",
  "tuff",
  "deepslate",
  "cobbled_deepslate",
  "dirt",
  "grass_block",
  "bedrock",
  "water",
  "cobblestone",
  "coal_ore",
  "deepslate_coal_ore",
  "iron_ore",
  "deepslate_iron_ore",
  "gravel",
  "copper_ore",
  "deepslate_copper_ore",
  "gold_ore",
  "deepslate_gold_ore",
  "redstone_ore",
  "deepslate_redstone_ore",
  "lapis_ore",
  "deepslate_lapis_ore",
  "deepslate_diamond_ore",
]);

/** How far around the bot loaded blocks count as seen for the crafting planner (run 10: Mira, at the surface). */
export const SEEN_RADIUS = 32;
/** Loaded blocks of one kind counted at most: enough to tell near from none, cheap to ask. */
export const SEEN_CAP = 64;
/** The answers of {@link seenInWorld} are kept this long, and until the bot moves {@link SEEN_MOVED} blocks. */
export const SEEN_TTL_MS = 20_000;
export const SEEN_MOVED = 8;

/**
 * How much of an item the explored world has, for the crafting planner's ties: over the blocks it is gathered from,
 * the most of the loaded blocks of that kind within {@link SEEN_RADIUS} of the bot (up to {@link SEEN_CAP}) or the
 * recorded chunks that hold it (the frontier leaves out stone, deepslate and the like, so those count by what is
 * near). Run 10: a stone pickaxe planned cobbled_deepslate at the surface, Mira dug toward it for 18 minutes, with
 * stone underfoot. Each block kind is scanned once per {@link SEEN_TTL_MS}.
 */
export function seenInWorld(
  bot: Bot,
  frontier: Pick<SessionFrontier, "chunksWithMaterial">,
  now: () => number = Date.now,
): (item: string) => number {
  let byBlock = new Map<string, number>();
  let askedAt = Number.NEGATIVE_INFINITY;
  let askedFrom: Vec3 | null = null;
  // The planner asks for every wood kind of every recipe, and the brain asks again within seconds: the answers are
  // kept while the bot stays about where it was (run 12: 70 of 86 runtime stalls were this scan, 0.4-0.5 s a call).
  const refresh = (): Vec3 | null => {
    const position = bot.entity?.position ?? null;
    const moved = position !== null && askedFrom !== null && position.distanceTo(askedFrom) > SEEN_MOVED;
    if (moved || now() - askedAt > SEEN_TTL_MS) {
      byBlock = new Map();
      askedAt = now();
      askedFrom = position?.clone() ?? null;
    }
    return position;
  };
  const blockSeen = (block: string, position: Vec3 | null): number => {
    let seen = byBlock.get(block);
    if (seen === undefined) {
      const definition = bot.registry.blocksByName[block];
      let near = 0;
      if (definition !== undefined && position !== null) {
        const stateIds = new Set<number>();
        for (let stateId = definition.minStateId!; stateId <= definition.maxStateId!; stateId += 1) stateIds.add(stateId);
        near = findLoadedBlockPositions(bot, { center: position, radius: SEEN_RADIUS, stateIds, limit: SEEN_CAP }).length;
      }
      byBlock.set(block, (seen = Math.max(near, frontier.chunksWithMaterial(block))));
    }
    return seen;
  };
  return (item) => {
    const position = refresh();
    return Math.max(0, ...sourcesOf(item, bot.version).map(({ block }) => blockSeen(block, position)));
  };
}

/**
 * The queue behind a session frontier: chunks wait here, are scanned one at a time off the packet path, and the ones
 * that commit are told to the listeners. One recorder per session.
 */
class ChunkRecorder {
  observedChunks: number;
  private storageError: string | null = null;
  /** Why the spawn ring was not read at attach: kept until close, since no later chunk records it. */
  private attachError: string | null = null;
  private readonly pending = new Map<string, PendingChunk>();
  private readonly listeners = new Set<(chunk: FrontierChunk) => void>();
  private closed = false;
  private processing: Promise<void> | undefined;
  private readonly scanErrors = new Map<string, string>();
  private readonly bot: Bot;
  private readonly data: SqlBotData;

  constructor(bot: Bot, data: SqlBotData) {
    this.bot = bot;
    this.data = data;
    this.observedChunks = Number(data.read("SELECT COUNT(*) AS count FROM frontier_chunks")[0]?.count ?? 0);
  }

  /** Queue the chunk when it is new, or recorded long enough ago to be scanned again. */
  remember(chunk: FrontierChunk, column: LoadedColumn | undefined): void {
    if (this.closed || !column) return;
    try {
      const recorded = this.data.read("SELECT scanned_at FROM frontier_chunks WHERE chunk_key = ?", chunkKey(chunk))[0];
      if (recorded === undefined) this.queue({ ...chunk, firstObservedAt: new Date().toISOString(), column });
      else if (Date.now() - Date.parse(String(recorded.scanned_at)) >= RESCAN_AFTER_MS) {
        this.queue({ ...chunk, firstObservedAt: new Date().toISOString(), column, rescan: true });
      }
      this.storageError = null;
    } catch (cause) {
      this.storageError = message(cause);
    }
  }

  recordAttachError(cause: unknown): void {
    this.attachError = `Spawn-ring chunks are not recorded: ${message(cause)}`;
  }

  onRecorded(listener: (chunk: FrontierChunk) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  idle(): Promise<void> {
    return this.processing ?? Promise.resolve();
  }

  status(): SessionFrontierStatus {
    return {
      observedChunks: this.observedChunks,
      pendingChunks: this.pending.size,
      error: this.storageError ?? this.attachError ?? this.scanErrors.values().next().value ?? null,
    };
  }

  close(): void {
    this.closed = true;
    this.pending.clear();
    this.listeners.clear();
  }

  private queue(chunk: PendingChunk): void {
    const key = chunkKey(chunk);
    if (!this.pending.has(key)) this.pending.set(key, chunk);
    this.processing ??= this.processPending();
  }

  private async processPending(): Promise<void> {
    await yieldToEventLoop();
    while (!this.closed && this.pending.size > 0) {
      const [key, chunk] = this.pending.entries().next().value!;
      this.pending.delete(key);
      using execution = new ExecutionScope({ bot: this.bot.username, operation: "frontier", targetId: null });
      try {
        if (execution.runSync(`scan_and_record:${key}`, () => scanAndRecord(this.bot, this.data, chunk))) {
          this.observedChunks += 1;
          this.notifyRecorded({ dimension: chunk.dimension, chunkX: chunk.chunkX, chunkZ: chunk.chunkZ });
        }
        this.scanErrors.delete(key);
      } catch (cause) {
        this.scanErrors.set(key, `Chunk ${key}: ${message(cause)}`);
      }
      await yieldToEventLoop();
    }
    this.processing = undefined;
  }

  /**
   * The transaction has committed. Consumers can therefore treat this notification as persisted evidence from this
   * bot, rather than a chunk-load packet or a write made by another process.
   */
  private notifyRecorded(recorded: FrontierChunk): void {
    for (const listener of this.listeners) {
      try {
        listener(recorded);
      } catch {
        // A consumer cannot turn an already committed chunk into a scan
        // failure or prevent the remaining consumers from seeing it.
      }
    }
  }
}

/** How many recorded chunks of `dimension` hold `material`. */
function countChunksWithMaterial(data: SqlBotData, dimension: string, material: string): number {
  const row = data.read(
    `SELECT COUNT(*) AS count FROM frontier_chunk_materials AS m JOIN frontier_chunks AS c USING (chunk_key)
     WHERE m.material = ? AND c.dimension = ?`,
    material,
    dimension,
  )[0];
  return Number(row?.count ?? 0);
}

/** The farthest recorded chunk of `dimension` along `direction`, or null when none is recorded. */
function recordedBoundary(data: SqlBotData, dimension: string, direction: { readonly x: number; readonly z: number }): number | null {
  const row = data.read(
    `
    SELECT MAX(chunk_x * ? + chunk_z * ?) AS boundary
    FROM frontier_chunks
    WHERE dimension = ?
  `,
    direction.x,
    direction.z,
    dimension,
  )[0];
  return row?.boundary === null || row?.boundary === undefined ? null : Number(row.boundary);
}

/**
 * Records loaded chunks, useful material sets, and counted biome samples.
 * Work is queued so packet delivery never performs a scan.
 */
export function attachSessionFrontier(bot: Bot, data: SqlBotData): SessionFrontier {
  const recorder = new ChunkRecorder(bot, data);

  const loaded = (corner: Vec3) => {
    const { chunkX, chunkZ } = chunkPosition(corner);
    recorder.remember(
      {
        dimension: bot.game.dimension,
        chunkX,
        chunkZ,
      },
      bot.world.getColumn(chunkX, chunkZ) as unknown as LoadedColumn | undefined,
    );
  };
  bot.on("chunkColumnLoad", loaded);

  // The bot is already spawned when the session is built, so its spawn ring may
  // have arrived before this listener existed.
  try {
    for (const { chunkX, chunkZ, column } of loadedColumns<LoadedColumn>(bot.world)) {
      recorder.remember({ dimension: bot.game.dimension, chunkX, chunkZ }, column);
    }
  } catch (cause) {
    // A column list Prismarine changed under us (a coordinate that is no integer) must not stop the session from
    // starting: no spawn-ring chunk is recorded, health says why, and the chunk-load events go on.
    recorder.recordAttachError(cause);
  }

  const close = (): void => {
    recorder.close();
    bot.off("chunkColumnLoad", loaded);
  };

  return {
    status: () => recorder.status(),
    idle: () => recorder.idle(),
    chunksWithMaterial: (material) => countChunksWithMaterial(data, bot.game.dimension, material),
    boundary: (dimension, direction) => recordedBoundary(data, dimension, direction),
    onRecorded: (listener) => recorder.onRecorded(listener),
    close,
    [Symbol.dispose]: close,
  };
}

function scanAndRecord(bot: Bot, data: SqlBotData, chunk: PendingChunk): boolean {
  const key = chunkKey(chunk);
  const blockNameFor = (stateId: number) => bot.registry.blocksByStateId[stateId]?.name;
  const materials = namesFromPalettes(chunk.column.sections, 4096, blockNameFor, ROUTINE_MATERIALS);
  const biomes = countNamesFromPalettes(chunk.column.biomes, 64, (biomeId) => bot.registry.biomes[biomeId]?.name);
  const surfaceWaterFraction = measureSurfaceWaterFraction(chunk.column.sections, blockNameFor);
  const scannedAt = new Date().toISOString();

  if (chunk.rescan) {
    data.transaction((database) => {
      database.prepare("UPDATE frontier_chunks SET scanned_at = ?, surface_water_fraction = ? WHERE chunk_key = ?").run(scannedAt, surfaceWaterFraction, key);
      database.prepare("DELETE FROM frontier_chunk_materials WHERE chunk_key = ?").run(key);
      database.prepare("DELETE FROM frontier_chunk_biomes WHERE chunk_key = ?").run(key);
      const insertMaterial = database.prepare("INSERT INTO frontier_chunk_materials (chunk_key, material) VALUES (?, ?)");
      for (const material of materials) insertMaterial.run(key, material);
      const insertBiome = database.prepare("INSERT INTO frontier_chunk_biomes (chunk_key, biome, sample_count) VALUES (?, ?, ?)");
      for (const [biome, sampleCount] of biomes) insertBiome.run(key, biome, sampleCount);
    }, { name: "rescanChunk" });
    // Not a new chunk: no count, no frontier change, no listener.
    return false;
  }

  return data.transaction((database) => {
    const inserted = database
      .prepare(
        `
        INSERT INTO frontier_chunks (
          chunk_key, dimension, chunk_x, chunk_z,
          first_observed_at, scanned_at, surface_water_fraction
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (chunk_key) DO NOTHING
      `,
      )
      .run(
        key,
        chunk.dimension,
        chunk.chunkX,
        chunk.chunkZ,
        chunk.firstObservedAt,
        scannedAt,
        surfaceWaterFraction,
      ).changes;
    if (!inserted) return false;

    updateFrontierFlags(database, chunk);

    const insertMaterial = database.prepare(`
      INSERT INTO frontier_chunk_materials (chunk_key, material)
      VALUES (?, ?)
    `);
    for (const material of materials) insertMaterial.run(key, material);
    const insertBiome = database.prepare(`
      INSERT INTO frontier_chunk_biomes (chunk_key, biome, sample_count)
      VALUES (?, ?, ?)
    `);
    for (const [biome, sampleCount] of biomes) insertBiome.run(key, biome, sampleCount);
    return true;
  }, { name: "scanAndRecord" });
}

/** Recheck only the new chunk and the four chunks whose frontier state it can change. */
function updateFrontierFlags(database: DatabaseSync, chunk: FrontierChunk): void {
  database
    .prepare(
      `
      WITH direction (delta_x, delta_z) AS (
        VALUES (0, -1), (1, 0), (0, 1), (-1, 0)
      )
      UPDATE frontier_chunks AS candidate
      SET is_frontier = EXISTS (
        SELECT 1 FROM direction
        WHERE NOT EXISTS (
          SELECT 1
          FROM frontier_chunks AS neighbour
          WHERE neighbour.dimension = candidate.dimension
            AND neighbour.chunk_x = candidate.chunk_x + direction.delta_x
            AND neighbour.chunk_z = candidate.chunk_z + direction.delta_z
        )
      )
      WHERE chunk_key IN (?, ?, ?, ?, ?)
    `,
    )
    // Seek the five primary keys. A correlated WHERE EXISTS scans every
    // historical chunk, making each newly streamed column cost more forever.
    .run(
      chunkKey(chunk),
      chunkKey({ ...chunk, chunkZ: chunk.chunkZ - 1 }),
      chunkKey({ ...chunk, chunkX: chunk.chunkX + 1 }),
      chunkKey({ ...chunk, chunkZ: chunk.chunkZ + 1 }),
      chunkKey({ ...chunk, chunkX: chunk.chunkX - 1 }),
    );
}

function chunkKey(chunk: FrontierChunk): string {
  return `${chunk.dimension}|${chunk.chunkX}|${chunk.chunkZ}`;
}

function measureSurfaceWaterFraction(
  sections: Array<{ data: PaletteContainer }>,
  nameFor: (stateId: number) => string | undefined,
): number {
  const resolved = new Uint8Array(CHUNK_SURFACE_CELLS);
  const kinds = new Map<number, SurfaceKind>();
  let unresolvedCells = CHUNK_SURFACE_CELLS;
  let waterCells = 0;

  const kindFor = (stateId: number): SurfaceKind => {
    const known = kinds.get(stateId);
    if (known !== undefined) return known;
    const name = nameFor(stateId);
    let kind: SurfaceKind = "other";
    if (name !== undefined && AIR_BLOCKS.has(name)) kind = "air";
    else if (name !== undefined && SURFACE_WATER_BLOCKS.has(name)) kind = "water";
    kinds.set(stateId, kind);
    return kind;
  };

  for (let sectionIndex = sections.length - 1; sectionIndex >= 0 && unresolvedCells > 0; sectionIndex -= 1) {
    const { data } = sections[sectionIndex]!;
    if (typeof data.value === "number") {
      const kind = kindFor(data.value);
      if (kind === "air") continue;
      if (kind === "water") waterCells += unresolvedCells;
      break;
    }
    if (data.palette?.every((stateId) => kindFor(stateId) === "air")) continue;

    for (let y = SECTION_HEIGHT - 1; y >= 0 && unresolvedCells > 0; y -= 1) {
      for (let horizontalIndex = 0; horizontalIndex < CHUNK_SURFACE_CELLS; horizontalIndex += 1) {
        if (resolved[horizontalIndex]) continue;
        const kind = kindFor(data.get((y << 8) | horizontalIndex));
        if (kind === "air") continue;
        resolved[horizontalIndex] = 1;
        unresolvedCells -= 1;
        if (kind === "water") waterCells += 1;
      }
    }
  }

  return waterCells / CHUNK_SURFACE_CELLS;
}

function namesFromPalettes(
  sections: Array<{ data: PaletteContainer }>,
  capacity: number,
  nameFor: (id: number) => string | undefined,
  excluded: ReadonlySet<string> = new Set(),
): string[] {
  const ids = new Set<number>();
  for (const { data } of sections) {
    if (typeof data.value === "number") {
      ids.add(data.value);
    } else if (data.palette) {
      for (const id of data.palette) ids.add(id);
    } else {
      for (let index = 0; index < capacity; index += 1) ids.add(data.get(index));
    }
  }
  const names = new Set<string>();
  for (const id of ids) {
    const name = nameFor(id);
    if (name !== undefined && !excluded.has(name)) names.add(name);
  }
  return [...names].sort();
}

function countNamesFromPalettes(
  sections: Array<{ data: PaletteContainer }>,
  capacity: number,
  nameFor: (id: number) => string | undefined,
): Array<readonly [name: string, count: number]> {
  const counts = new Map<string, number>();
  for (const { data } of sections) {
    if (typeof data.value === "number") {
      const name = nameFor(data.value);
      if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + capacity);
      continue;
    }

    for (let index = 0; index < capacity; index += 1) {
      const name = nameFor(data.get(index));
      if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right));
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

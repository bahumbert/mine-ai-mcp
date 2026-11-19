import type { Bot } from "mineflayer";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop, setTimeout as sleep } from "node:timers/promises";
import type { Vec3 } from "vec3";
import { monotonicNow } from "../utils/monotonic-clock.js";
import { findLoadedBlockPositions } from "../world/loaded-block-scan.js";
import { SqlBotData, worldWriteRetryDelayMs } from "../bot-data/index.js";
import { ExecutionScope } from "../execution/execution-scope.js";
import { sourcesOf } from "../world/block-drops.js";
import { CHUNK_WIDTH, chunkPosition, loadedColumns } from "../world/chunks.js";
import { startLegacyFrontierImport, type LegacyFrontierImport } from "./legacy-frontier-import.js";

export interface SessionFrontierStatus {
  observedChunks: number;
  pendingChunks: number;
  error: string | null;
  /** Chunks of the old per-bot frontier not yet moved into the world file (0 when none): the map lacks them until then. */
  legacyLeft: number;
  /**
   * Why the move of the old frontier stopped (the next start resumes it), or null. Not part of `error`: exploring stops
   * on any `error`, and the chunks it records do not depend on the old ones.
   */
  legacyImportError: string | null;
}

export interface FrontierChunk {
  readonly dimension: string;
  readonly chunkX: number;
  readonly chunkZ: number;
}

export interface SessionFrontier extends Disposable {
  status(): SessionFrontierStatus;
  idle(): Promise<void>;
  /** Settles when the move of the old per-bot frontier into the world file ended (at once when there is none). */
  whenLegacyImported(): Promise<void>;
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

/** What one scan of a chunk column found: kept across the retries of a busy world write. */
interface ChunkScan {
  readonly scannedAt: string;
  readonly surfaceWaterFraction: number;
  readonly materials: readonly string[];
  readonly biomes: ReadonlyArray<readonly [name: string, count: number]>;
}

interface PendingChunk extends FrontierChunk {
  firstObservedAt: string;
  column: LoadedColumn;
  /** The monotonic time before which a busy world write is not tried again; 0 for a chunk not yet tried. */
  retryAt: number;
  busyTries: number;
  scan?: ChunkScan;
}

/** A world write another connection holds is tried again at most this many times, then the chunk reports an error. */
const WORLD_WRITE_TRIES = 20;

/** Clocks and waits of the recorder; tests give their own so a retry wait costs no real time. */
export interface FrontierTiming {
  /** Monotonic milliseconds: deadlines and retry times. */
  readonly now?: () => number;
  readonly random?: () => number;
  /** Waits `ms` and rejects when the signal aborts (the session closed). */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
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
  now: () => number = monotonicNow,
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
  /** Why the spawn ring was not read at attach: kept until close. */
  private readonly attachErrors: string[] = [];
  private readonly pending = new Map<string, PendingChunk>();
  private readonly listeners = new Set<(chunk: FrontierChunk) => void>();
  private closed = false;
  private processing: Promise<void> | undefined;
  private readonly scanErrors = new Map<string, string>();
  private readonly bot: Bot;
  private readonly data: SqlBotData;
  private readonly abort = new AbortController();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(bot: Bot, data: SqlBotData, private readonly legacyImport: LegacyFrontierImport, timing: FrontierTiming) {
    this.bot = bot;
    this.data = data;
    this.now = timing.now ?? monotonicNow;
    this.random = timing.random ?? Math.random;
    this.wait = timing.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }));
    this.observedChunks = Number(data.read("SELECT COUNT(*) AS count FROM frontier_chunks")[0]?.count ?? 0);
  }

  /**
   * Queue the chunk when the world has no scan of it, or one older than {@link RESCAN_AFTER_MS} (by any bot of the
   * world), or when this bot has no sighting of it. Two reads by key; the scan and the writes run off the packet path.
   */
  remember(chunk: FrontierChunk, column: LoadedColumn | undefined): void {
    if (this.closed || !column) return;
    try {
      const key = chunkKey(chunk);
      if (this.worldScanIsStale(key) || !this.hasSighting(key)) {
        this.queue({ ...chunk, firstObservedAt: new Date().toISOString(), column, retryAt: 0, busyTries: 0 });
      }
      this.storageError = null;
    } catch (cause) {
      this.storageError = message(cause);
    }
  }

  /** True when the world file has no scan of the chunk, or one old enough to scan again. */
  private worldScanIsStale(key: string): boolean {
    const scanned = this.data.read("SELECT scanned_at FROM world.frontier_chunks WHERE chunk_key = ?", key)[0];
    return scanned === undefined || Date.now() - Date.parse(String(scanned.scanned_at)) >= RESCAN_AFTER_MS;
  }

  private hasSighting(key: string): boolean {
    return this.data.read("SELECT 1 AS seen FROM main.frontier_seen WHERE bot_id = ? AND chunk_key = ?", this.bot.username, key).length > 0;
  }

  /** Counts the chunks on this bot's map again: the legacy import added to it after the constructor counted. */
  recountObservedChunks(): void {
    if (this.closed) return;
    try {
      this.observedChunks = Number(this.data.read("SELECT COUNT(*) AS count FROM frontier_chunks")[0]?.count ?? 0);
    } catch (cause) {
      this.storageError = message(cause);
    }
  }

  /** What failed at attach, and why: kept until close, since nothing retries it. */
  recordAttachError(what: string, cause: unknown): void {
    this.attachErrors.push(`${what}: ${message(cause)}`);
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
      error: this.storageError ?? (this.attachErrors.join("; ") || null) ?? this.scanErrors.values().next().value ?? null,
      legacyLeft: this.legacyImport.left(),
      legacyImportError: this.legacyImport.error(),
    };
  }

  close(): void {
    this.closed = true;
    this.abort.abort();
    this.legacyImport.stop();
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
      const due = this.nextDue();
      if (due === null) {
        await this.waitForEarliestRetry();
        continue;
      }
      this.processOne(...due);
      await yieldToEventLoop();
    }
    this.processing = undefined;
  }

  /** Records one due chunk: done (told to the listeners when it is a new sighting), back in the queue when busy, or an error. */
  private processOne(key: string, chunk: PendingChunk): void {
    using execution = new ExecutionScope({ bot: this.bot.username, operation: "frontier", targetId: null });
    try {
      const outcome = execution.runSync(`scan_and_record:${key}`, () => this.record(chunk));
      if (outcome === "busy") return this.retryLater(key, chunk);
      this.pending.delete(key);
      this.scanErrors.delete(key);
      if (outcome !== "new sighting") return;
      this.observedChunks += 1;
      this.notifyRecorded({ dimension: chunk.dimension, chunkX: chunk.chunkX, chunkZ: chunk.chunkZ });
    } catch (cause) {
      this.pending.delete(key);
      this.scanErrors.set(key, `Chunk ${key}: ${message(cause)}`);
    }
  }

  /** The first queued chunk whose retry time has come, or null when every one is waiting out a busy world write. */
  private nextDue(): [string, PendingChunk] | null {
    const now = this.now();
    for (const entry of this.pending) if (entry[1].retryAt <= now) return entry;
    return null;
  }

  private async waitForEarliestRetry(): Promise<void> {
    const earliest = Math.min(...Array.from(this.pending.values(), (chunk) => chunk.retryAt));
    // Closing aborts the wait: the loop then ends on `closed`.
    await this.wait(Math.max(0, earliest - this.now()), this.abort.signal).catch(() => {});
  }

  /** A world write another connection held: the chunk goes back with a retry time, or reports the error after the last try. */
  private retryLater(key: string, chunk: PendingChunk): void {
    chunk.busyTries += 1;
    if (chunk.busyTries >= WORLD_WRITE_TRIES) {
      this.pending.delete(key);
      this.scanErrors.set(key, `Chunk ${key}: world data busy for ${WORLD_WRITE_TRIES} tries`);
      return;
    }
    chunk.retryAt = this.now() + worldWriteRetryDelayMs(this.random);
  }

  /**
   * Scans the chunk into the world file unless another bot's scan is fresh (it may have landed while this waited), then
   * records this bot's sighting. Only a sighting this bot did not have is a new chunk (a rescan is not).
   */
  private record(chunk: PendingChunk): "busy" | "new sighting" | "known" {
    const key = chunkKey(chunk);
    if (this.worldScanIsStale(key)) {
      chunk.scan ??= scanChunk(this.bot, chunk);
      const written = this.data.world.write((database) => writeWorldScan(database, chunk, chunk.scan!), { name: "scanAndRecord" });
      if (written.status === "busy") return "busy";
    }
    const inserted = this.data.transaction(
      (database) =>
        database
          .prepare(
            `INSERT OR IGNORE INTO frontier_seen (bot_id, chunk_key, dimension, chunk_x, chunk_z, first_seen_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(this.bot.username, key, chunk.dimension, chunk.chunkX, chunk.chunkZ, chunk.firstObservedAt).changes > 0,
      { name: "recordSighting" },
    );
    return inserted ? "new sighting" : "known";
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
export function countChunksWithMaterial(data: SqlBotData, dimension: string, material: string): number {
  const row = data.read(
    `SELECT COUNT(*) AS count FROM frontier_chunk_materials AS m JOIN frontier_chunks AS c USING (chunk_key)
     WHERE m.material = ? AND c.dimension = ?`,
    material,
    dimension,
  )[0];
  return Number(row?.count ?? 0);
}

/** The farthest recorded chunk of `dimension` along `direction`, or null when none is recorded. */
export function recordedBoundary(data: SqlBotData, dimension: string, direction: { readonly x: number; readonly z: number }): number | null {
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
export function attachSessionFrontier(bot: Bot, data: SqlBotData, timing: FrontierTiming = {}): SessionFrontier {
  // A bot file that still holds the frontier of the old per-bot shape moves it into the world file in the background.
  const legacyImport = startLegacyFrontierImport(data, bot.username);
  let recorder: ChunkRecorder;
  try {
    recorder = new ChunkRecorder(bot, data, legacyImport, timing);
  } catch (error) {
    legacyImport.stop(); // nobody owns the import yet: a failed attach must not leave it running
    throw error;
  }
  void legacyImport.done.then(() => recorder.recountObservedChunks());

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
    recorder.recordAttachError("Spawn-ring chunks are not recorded", cause);
  }

  const close = (): void => {
    recorder.close();
    bot.off("chunkColumnLoad", loaded);
  };

  return {
    status: () => recorder.status(),
    idle: () => recorder.idle(),
    whenLegacyImported: () => legacyImport.done,
    chunksWithMaterial: (material) => countChunksWithMaterial(data, bot.game.dimension, material),
    boundary: (dimension, direction) => recordedBoundary(data, dimension, direction),
    onRecorded: (listener) => recorder.onRecorded(listener),
    close,
    [Symbol.dispose]: close,
  };
}

/** Reads the chunk column's palettes: materials, biome samples and surface water. Nothing is written. */
function scanChunk(bot: Bot, chunk: PendingChunk): ChunkScan {
  const blockNameFor = (stateId: number) => bot.registry.blocksByStateId[stateId]?.name;
  return {
    materials: namesFromPalettes(chunk.column.sections, 4096, blockNameFor, ROUTINE_MATERIALS),
    biomes: countNamesFromPalettes(chunk.column.biomes, 64, (biomeId) => bot.registry.biomes[biomeId]?.name),
    surfaceWaterFraction: measureSurfaceWaterFraction(chunk.column.sections, blockNameFor),
    scannedAt: new Date().toISOString(),
  };
}

/** One chunk's scan in the world file: the row (the later scan replaces an earlier one) with its materials and biomes. */
function writeWorldScan(database: DatabaseSync, chunk: PendingChunk, scan: ChunkScan): void {
  const key = chunkKey(chunk);
  database
    .prepare(
      `INSERT INTO frontier_chunks (chunk_key, dimension, chunk_x, chunk_z, first_observed_at, scanned_at, surface_water_fraction)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (chunk_key) DO UPDATE SET scanned_at = excluded.scanned_at, surface_water_fraction = excluded.surface_water_fraction`,
    )
    .run(key, chunk.dimension, chunk.chunkX, chunk.chunkZ, chunk.firstObservedAt, scan.scannedAt, scan.surfaceWaterFraction);
  database.prepare("DELETE FROM frontier_chunk_materials WHERE chunk_key = ?").run(key);
  database.prepare("DELETE FROM frontier_chunk_biomes WHERE chunk_key = ?").run(key);
  const insertMaterial = database.prepare("INSERT INTO frontier_chunk_materials (chunk_key, material) VALUES (?, ?)");
  for (const material of scan.materials) insertMaterial.run(key, material);
  const insertBiome = database.prepare("INSERT INTO frontier_chunk_biomes (chunk_key, biome, sample_count) VALUES (?, ?, ?)");
  for (const [biome, sampleCount] of scan.biomes) insertBiome.run(key, biome, sampleCount);
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

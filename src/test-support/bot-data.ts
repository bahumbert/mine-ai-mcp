/** Bot-data stores for tests: in memory by default, or persistent under a temp root that outlives a reopen. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BotDataScope } from "../bot-data/bot-data-identity.js";
import { SqlBotData } from "../bot-data/sql-bot-data.js";

export interface TemporaryBotDataOptions {
  readonly botId?: string;
  /** Close the store when this test finishes, for stores created inline in an expression. */
  readonly closeAfter?: { after(fn: () => void): void };
}

export function temporaryBotData({ botId, closeAfter }: TemporaryBotDataOptions = {}): SqlBotData {
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "test-world", scope: botId ? { kind: "bot", botId } : { kind: "shared" } },
  });
  closeAfter?.after(() => data.close());
  return data;
}

export interface RecordedChunk {
  readonly dimension?: string;
  readonly chunkX: number;
  readonly chunkZ: number;
  /** The bot whose sighting is written (default: "test-bot"); null: only the world scan, no bot of this file saw it. */
  readonly seenBy?: string | null;
  readonly waterFraction?: number;
  readonly materials?: readonly string[];
  readonly biomes?: ReadonlyArray<readonly [biome: string, sampleCount: number]>;
  readonly scannedAt?: string;
  readonly firstSeenAt?: string;
}

/** A chunk as the recorder leaves it: the scan in the world file (replacing an older one), this bot's sighting in the bot file. */
export function recordChunk(data: SqlBotData, chunk: RecordedChunk): void {
  const dimension = chunk.dimension ?? "overworld";
  const key = `${dimension}|${chunk.chunkX}|${chunk.chunkZ}`;
  const scannedAt = chunk.scannedAt ?? "2026-08-20T00:00:01.000Z";
  const firstSeenAt = chunk.firstSeenAt ?? "2026-08-20T00:00:00.000Z";
  const written = data.world.write((database) => {
    database
      .prepare(
        `INSERT INTO frontier_chunks (chunk_key, dimension, chunk_x, chunk_z, first_observed_at, scanned_at, surface_water_fraction)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (chunk_key) DO UPDATE SET scanned_at = excluded.scanned_at, surface_water_fraction = excluded.surface_water_fraction`,
      )
      .run(key, dimension, chunk.chunkX, chunk.chunkZ, firstSeenAt, scannedAt, chunk.waterFraction ?? 0);
    database.prepare("DELETE FROM frontier_chunk_materials WHERE chunk_key = ?").run(key);
    database.prepare("DELETE FROM frontier_chunk_biomes WHERE chunk_key = ?").run(key);
    for (const material of chunk.materials ?? []) {
      database.prepare("INSERT INTO frontier_chunk_materials (chunk_key, material) VALUES (?, ?)").run(key, material);
    }
    for (const [biome, samples] of chunk.biomes ?? []) {
      database.prepare("INSERT INTO frontier_chunk_biomes (chunk_key, biome, sample_count) VALUES (?, ?, ?)").run(key, biome, samples);
    }
  }, { name: "recordChunk" });
  if (written.status !== "written") throw new Error("The world file was busy while a test recorded a chunk.");
  if (chunk.seenBy === null) return;
  data.transaction((database) => {
    database
      .prepare("INSERT OR IGNORE INTO frontier_seen (bot_id, chunk_key, dimension, chunk_x, chunk_z, first_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(chunk.seenBy ?? "test-bot", key, dimension, chunk.chunkX, chunk.chunkZ, firstSeenAt);
  }, { name: "recordChunk" });
}

/** The file of a persistent store, for tests that open it with a raw connection. */
export function persistentFile(data: SqlBotData): string {
  if (data.location.kind !== "persistent") throw new Error("Expected persistent SQL bot data.");
  return data.location.file;
}

/**
 * A temp root for persistent stores, removed when the test ends. Every store
 * opened here, and anything registered with `alsoClose`, is closed first:
 * Windows refuses to remove a directory while a database still holds a file.
 */
export function persistentBotData(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), "mine-ai-bot-data-"));
  const closers: (() => void)[] = [];
  t.after(() => {
    for (const close of closers) close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    alsoClose(close: () => void) {
      closers.push(close);
    },
    open(worldId: string, scope: BotDataScope = { kind: "shared" }): SqlBotData {
      const data = SqlBotData.create({ storage: { kind: "persistent", root }, identity: { worldId, scope } });
      closers.push(() => data.close());
      return data;
    },
  };
}

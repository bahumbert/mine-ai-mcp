// The world file of one world (`<world folder>/world/world-data.sqlite`): what every bot of the world learns the same way,
// in its own SQLite file with its own connection, so no bot's write transaction ever locks it.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { installAndValidateMetadata, validateExistingMetadata } from "./file-metadata.js";
import { migrationContextFor, runMigrations, WORLD_DATA_STEPS } from "./migrations.js";
import { worldDataFileFor } from "./bot-data-paths.js";
import { closeSqlDatabase } from "./close-sql-database.js";
import type { BotDataStorage } from "./sql-bot-data.js";
import { sqliteLock } from "./storage-diagnostics.js";
import { restoreAutomaticCheckpoints, startWalCheckpointer, WAL_JOURNAL_SIZE_LIMIT_BYTES } from "./wal-checkpointer.js";

export interface SqlWorldDataOptions {
  readonly storage: BotDataStorage;
  readonly worldId: string;
  /** Replaces the checkpoint worker of a persistent world file, for tests that need to see it started or stopped. */
  readonly startWalCheckpointer?: typeof startWalCheckpointer;
}

/** A write is either committed, or another connection held the file and nothing was written: the caller decides when to retry. */
export type WorldWrite<T> = { readonly status: "written"; readonly value: T } | { readonly status: "busy" };

const BUSY: WorldWrite<never> = Object.freeze({ status: "busy" });

/** How long a writer waits before trying a busy world again: 20 ms plus up to 180 ms of jitter (the 15-process probe committed after 5-25 ms). */
export function worldWriteRetryDelayMs(random: () => number): number {
  return 20 + random() * 180;
}

/** Temporary world directories this process made and did not close: removed when the process exits. */
const unclosedTemporaryDirectories = new Set<string>();
let exitSweepRegistered = false;

/** Removes every temporary world directory still open (stores tests never closed); runs once at process exit. */
export function removeUnclosedTemporaryWorlds(): void {
  for (const directory of unclosedTemporaryDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A connection nobody closed can still hold its file (Windows refuses the removal); the OS cleans the temp folder.
    }
  }
  unclosedTemporaryDirectories.clear();
}

/** Owns the connection to one world file; the bot connections only attach it read-only. */
export class SqlWorldData implements Disposable {
  readonly file: string;

  private closed = false;
  private walCheckpointer: Disposable | null = null;

  private constructor(
    file: string,
    private readonly database: DatabaseSync,
    private readonly temporaryDirectory: string | null,
  ) {
    this.file = file;
  }

  /** Opens (creating, migrating) the world file of `worldId`; a temporary world is a file in a fresh temp folder. */
  static open(options: SqlWorldDataOptions): SqlWorldData {
    const temporaryDirectory = options.storage.kind === "temporary" ? makeTemporaryDirectory() : null;
    const file = temporaryDirectory === null ? persistentWorldFile(options.storage, options.worldId) : path.join(temporaryDirectory, "world-data.sqlite");
    const kind = options.storage.kind;
    const database = new DatabaseSync(file, { allowExtension: false, defensive: true, enableDoubleQuotedStringLiterals: false });
    try {
      configureWorldDatabase(database, kind);
      validateExistingMetadata(database, worldMetadata(options.worldId));
      runMigrations(database, WORLD_DATA_STEPS, migrationContextFor(kind), file);
      installAndValidateMetadata(database, worldMetadata(options.worldId));
      // Startup may wait for a transient journal lock; once the bot is attached a synchronous wait would starve physics,
      // so contention is answered at once ("busy") from here on.
      database.exec("PRAGMA busy_timeout = 0");
    } catch (error) {
      closeSqlDatabase(database);
      removeTemporaryDirectory(temporaryDirectory);
      throw error;
    }
    const world = new SqlWorldData(file, database, temporaryDirectory);
    if (kind === "persistent") {
      const start = options.startWalCheckpointer ?? startWalCheckpointer;
      try {
        world.walCheckpointer = start(file, { fellBack: (cause) => world.restoreAutomaticCheckpoints(cause) });
      } catch (error) {
        world.close();
        throw error;
      }
    }
    return world;
  }

  /**
   * One synchronous write transaction. `busy_timeout` is 0: a world another connection is writing answers `busy` at
   * once (at the begin or at the commit, rolled back), never a wait on the bot's thread. Any other error is rethrown.
   */
  write<T>(operation: (database: DatabaseSync) => T, context: { readonly name: string }): WorldWrite<T> {
    this.assertOpen();
    if (this.database.isTransaction) throw new Error(`SqlWorldData ${context.name}: writes cannot be nested.`);
    try {
      this.database.exec("BEGIN IMMEDIATE");
    } catch (cause) {
      if (sqliteLock(cause) !== null) return BUSY;
      throw cause;
    }
    let value: T;
    try {
      value = operation(this.database);
      if (isThenable(value)) throw new TypeError(`SqlWorldData ${context.name}: writes must be synchronous.`);
    } catch (cause) {
      this.rollback();
      throw cause;
    }
    try {
      this.database.exec("COMMIT");
    } catch (cause) {
      this.rollback();
      if (sqliteLock(cause) !== null) return BUSY;
      throw cause;
    }
    return { status: "written", value };
  }

  /** The address a bot connection attaches this file by, read-only (an unencoded `#` or `?` would attach another, empty file). */
  readOnlyAttachUri(): string {
    const absolute = path.resolve(this.file).replaceAll("\\", "/");
    const rooted = absolute.startsWith("/") ? absolute : `/${absolute}`;
    return `file:${rooted.replace(/[%?# ]/g, encodeURIComponent)}?mode=ro`;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.walCheckpointer?.[Symbol.dispose]();
    this.walCheckpointer = null;
    closeSqlDatabase(this.database);
    removeTemporaryDirectory(this.temporaryDirectory);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private restoreAutomaticCheckpoints(cause: string): void {
    if (this.closed || this.walCheckpointer === null) return;
    this.walCheckpointer = null;
    restoreAutomaticCheckpoints(this.database, "World WAL checkpointer", cause);
  }

  private rollback(): void {
    if (this.database.isTransaction) this.database.exec("ROLLBACK");
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SqlWorldData is closed.");
  }
}

function worldMetadata(worldId: string): ReadonlyMap<string, string> {
  return new Map([["world_id", worldId]]);
}

function persistentWorldFile(storage: BotDataStorage, worldId: string): string {
  if (storage.kind !== "persistent") throw new Error("A persistent world file needs a data root.");
  const file = worldDataFileFor(storage.root, worldId);
  mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "mine-ai-world-"));
  unclosedTemporaryDirectories.add(directory);
  if (!exitSweepRegistered) {
    exitSweepRegistered = true;
    process.on("exit", removeUnclosedTemporaryWorlds);
  }
  return directory;
}

function removeTemporaryDirectory(directory: string | null): void {
  if (directory === null) return;
  unclosedTemporaryDirectories.delete(directory);
  rmSync(directory, { recursive: true, force: true });
}

function configureWorldDatabase(database: DatabaseSync, storage: BotDataStorage["kind"]): void {
  // Journal initialization can meet another connection's transient lock during a restart.
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = WAL");
  if (storage === "persistent") {
    // A worker thread checkpoints (wal-checkpointer.ts): SQLite's own checkpoint would run inside this connection's COMMIT.
    database.exec("PRAGMA wal_autocheckpoint = 0");
    database.exec(`PRAGMA journal_size_limit = ${WAL_JOURNAL_SIZE_LIMIT_BYTES}`);
  }
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA foreign_keys = ON");
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return ((typeof value === "object" && value !== null) || typeof value === "function") && "then" in value;
}

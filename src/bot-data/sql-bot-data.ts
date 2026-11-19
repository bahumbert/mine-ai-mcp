import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { botDataDirectoryFor } from "./bot-data-paths.js";
import { resolveBotDataIdentity, type BotDataIdentity, type BotDataScope } from "./bot-data-identity.js";
import { BOT_DATA_SCHEMA } from "./bot-data-schema.js";
import { closeSqlDatabase } from "./close-sql-database.js";
import { installAndValidateMetadata, validateExistingMetadata } from "./file-metadata.js";
import { BOT_DATA_STEPS, migrationContextFor, newestVersion, runMigrations } from "./migrations.js";
import { SqlWorldData } from "./sql-world-data.js";
import { FRONTIER_VIEWS } from "./world-data-schema.js";
import {
  BotDataLockError,
  sqliteLock,
  storageConnection,
  type StorageLockFailure,
  type StorageOperation,
  type StoragePhase,
} from "./storage-diagnostics.js";
import { restoreAutomaticCheckpoints, startWalCheckpointer, WAL_JOURNAL_SIZE_LIMIT_BYTES } from "./wal-checkpointer.js";

export { BOT_DATA_SCHEMA, closeSqlDatabase };
export const SQL_BOT_DATA_SCHEMA_VERSION = newestVersion(BOT_DATA_STEPS);

export type SqlBotDataRow = Record<string, SQLOutputValue>;

export type BotDataStorage =
  | {
      readonly kind: "persistent";
      readonly root: string;
    }
  | {
      readonly kind: "temporary";
    };

export type SqlBotDataLocation =
  { readonly kind: "persistent"; readonly file: string } | { readonly kind: "temporary" };

export interface SqlBotDataOptions {
  readonly storage: BotDataStorage;
  readonly identity: BotDataIdentity;
  /** Replaces the checkpoint worker, for tests that need to see it started, fall back or be disposed. */
  readonly startWalCheckpointer?: typeof startWalCheckpointer;
  /** The same for the world file's checkpoint worker. */
  readonly startWorldWalCheckpointer?: typeof startWalCheckpointer;
}

/** Owns the SQLite representation and connection for one bot-data identity. */
export class SqlBotData {
  readonly location: SqlBotDataLocation;
  /** The world file of this identity's world (chunk scans every bot of the world shares); opened and closed with this store. */
  readonly world: SqlWorldData;

  private closed = false;
  private readonly database: DatabaseSync;
  private readonly connection;
  private lockFailures = 0;
  private lastLockFailure: StorageLockFailure | null = null;
  private walCheckpointer: Disposable | null = null;

  private constructor(
    location: SqlBotDataLocation,
    metadata: ReadonlyMap<string, string>,
    startCheckpointer: typeof startWalCheckpointer,
    world: SqlWorldData,
  ) {
    this.location = location;
    this.world = world;
    this.connection = storageConnection(location.kind === "persistent" ? location.file : ":memory:");

    const database = new DatabaseSync(location.kind === "persistent" ? location.file : ":memory:", {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
    });
    this.database = database;

    try {
      this.at({ name: "open-bot-data" }, "configure", () => {
        configureDatabase(database, location.kind);
        validateExistingMetadata(database, metadata);
        runMigrations(database, BOT_DATA_STEPS, migrationContextFor(location.kind), this.connection.file);
        // Views and the data dictionary are rebuilt on every open; the steps own every table's shape.
        database.exec(BOT_DATA_SCHEMA);
        installAndValidateMetadata(database, metadata);
        // Read-only: a plain attach would make this connection's write transactions lock the world file too (probe 2026-11-18).
        database.prepare("ATTACH DATABASE ? AS world").run(world.readOnlyAttachUri());
        database.exec(FRONTIER_VIEWS);
        // Startup may wait for a transient migration/journal lock. Once attached
        // to the bot, a synchronous five-second wait would starve physics and
        // trip the runtime watchdog. Report contention to the caller immediately.
        database.exec("PRAGMA busy_timeout = 0");
        database.exec("PRAGMA query_only = ON");
      });
    } catch (error) {
      closeSqlDatabase(database);
      throw error;
    }
    if (location.kind === "persistent") {
      this.walCheckpointer = startCheckpointer(location.file, { fellBack: (cause) => this.restoreAutomaticCheckpoints(cause) });
    }
    // Cross-process contention cannot be attributed from the victim's SQLite error alone.
    // Lifecycle records let operators correlate other runtime connections to this exact file.
    if (location.kind === "persistent")
      process.stderr.write(
        `[minecraft-bot-data] ${JSON.stringify({ event: "opened", ...this.connection, observedAt: new Date().toISOString() })}\n`,
      );
  }

  /** Creates the selected durable or session-only representation of one bot-data identity. */
  static create(options: SqlBotDataOptions): SqlBotData {
    const identity = resolveBotDataIdentity(options.identity);
    const metadata = metadataFor(identity.worldId, identity.scope);
    const location = resolveSqlBotDataLocation(options.storage, identity);
    const world = SqlWorldData.open({
      storage: options.storage,
      worldId: identity.worldId,
      ...(options.startWorldWalCheckpointer && { startWalCheckpointer: options.startWorldWalCheckpointer }),
    });
    try {
      return new SqlBotData(location, metadata, options.startWalCheckpointer ?? startWalCheckpointer, world);
    } catch (error) {
      world.close();
      throw error;
    }
  }

  /** Runs a trusted, synchronous read on the host thread. */
  read(sql: string, ...parameters: SQLInputValue[]): SqlBotDataRow[] {
    this.assertOpen();
    return this.readOnly(() => rows(this.database, sql, parameters), { name: "read-bot-data" });
  }

  /** Give trusted setup code synchronous writable access without imposing a transaction. */
  withWritableDatabase<T>(
    operation: (database: DatabaseSync) => T,
    context: StorageOperation = { name: "writable-setup" },
  ): T {
    this.assertOpen();
    if (this.database.isTransaction) {
      throw new Error("SqlBotData cannot enter writable setup while a transaction is active.");
    }

    using _cleanup = this.writeCleanup(context);
    this.at(context, "enable-write", () => this.database.exec("PRAGMA query_only = OFF"));
    const result = this.at(context, "operation", () => operation(this.database));
    if (isThenable(result)) {
      throw new TypeError("SqlBotData writable setup must be synchronous.");
    }
    if (this.database.isTransaction) {
      throw new Error("SqlBotData writable setup must settle its transaction before returning.");
    }
    return result;
  }

  /** Gives trusted package code temporary read-only access to the underlying connection. */
  withReadOnlyDatabase<T>(
    operation: (database: DatabaseSync) => T,
    context: StorageOperation = { name: "read-bot-data" },
  ): T {
    this.assertOpen();
    return this.readOnly(() => operation(this.database), context);
  }

  /** Runs one trusted host write atomically. Nested and asynchronous work is rejected. */
  transaction<T>(operation: (database: DatabaseSync) => T, context: StorageOperation = { name: "transaction" }): T {
    this.assertOpen();
    if (this.database.isTransaction) {
      throw new Error("SqlBotData transactions cannot be nested.");
    }

    using _cleanup = this.writeCleanup(context);
    this.at(context, "enable-write", () => this.database.exec("PRAGMA query_only = OFF"));
    this.at(context, "begin", () => this.database.exec("BEGIN IMMEDIATE"));
    const result = this.at(context, "operation", () => operation(this.database));
    if (isThenable(result)) {
      throw new TypeError("SqlBotData transactions must be synchronous.");
    }
    this.at(context, "commit", () => this.database.exec("COMMIT"));
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.walCheckpointer?.[Symbol.dispose]();
    this.walCheckpointer = null;
    closeSqlDatabase(this.database);
    // After the bot connection: it has the world file attached.
    this.world.close();
    if (this.location.kind === "persistent")
      process.stderr.write(
        `[minecraft-bot-data] ${JSON.stringify({ event: "closed", ...this.connection, observedAt: new Date().toISOString() })}\n`,
      );
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private restoreAutomaticCheckpoints(cause: string): void {
    if (this.closed || this.walCheckpointer === null) return;
    this.walCheckpointer = null;
    restoreAutomaticCheckpoints(this.database, "WAL checkpointer", cause);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("SqlBotData is closed.");
    }
  }

  /** No SQLite reads: health stays available during contention, and retains evidence after recovery. */
  diagnostics() {
    return { ...this.connection, lockFailures: this.lockFailures, lastLockFailure: this.lastLockFailure };
  }

  private at<T>(operation: StorageOperation, phase: StoragePhase, work: () => T): T {
    const started = performance.now();
    try {
      return work();
    } catch (cause) {
      const native = sqliteLock(cause);
      if (!native) throw cause;
      const details: StorageLockFailure = Object.freeze({
        ...this.connection,
        ...native,
        operation: Object.freeze({ ...operation }),
        phase,
        observedAt: new Date().toISOString(),
        elapsedMs: performance.now() - started,
        transactionActive: this.database.isTransaction,
      });
      this.lockFailures += 1;
      this.lastLockFailure = details;
      // The database itself is unavailable. Do not try to persist this through events or receipts.
      process.stderr.write(`[minecraft-bot-data] ${JSON.stringify(details)}\n`);
      throw new BotDataLockError(details, cause);
    }
  }

  /** Dispose in reverse order; SuppressedError preserves both the original and any cleanup failure. */
  private writeCleanup(context: StorageOperation): DisposableStack {
    const cleanup = new DisposableStack();
    cleanup.defer(() => this.at(context, "restore-read-only", () => this.database.exec("PRAGMA query_only = ON")));
    cleanup.defer(() => {
      if (this.database.isTransaction) this.at(context, "rollback", () => this.database.exec("ROLLBACK"));
    });
    return cleanup;
  }

  private readOnly<T>(operation: () => T, context: StorageOperation): T {
    if (this.database.isTransaction) {
      throw new Error("SqlBotData cannot read while a transaction is active.");
    }

    this.database.exec("PRAGMA query_only = ON");
    try {
      return this.at(context, "operation", operation);
    } finally {
      this.database.exec("PRAGMA query_only = ON");
    }
  }
}

function resolveSqlBotDataLocation(storage: BotDataStorage, identity: BotDataIdentity): SqlBotDataLocation {
  if (storage.kind === "temporary") return Object.freeze({ kind: "temporary" });

  const directory = botDataDirectoryFor(storage.root, identity.worldId, identity.scope);
  mkdirSync(directory, { recursive: true });
  return Object.freeze({ kind: "persistent", file: path.join(directory, "bot-data.sqlite") });
}

function configureDatabase(database: DatabaseSync, location: SqlBotDataLocation["kind"]): void {
  // Journal initialization can also meet a reader's transient lock during restart.
  database.exec("PRAGMA busy_timeout = 5000");
  if (location === "persistent") {
    database.exec("PRAGMA journal_mode = WAL");
    // A worker thread checkpoints (wal-checkpointer.ts): SQLite's own checkpoint would run inside this connection's COMMIT.
    database.exec("PRAGMA wal_autocheckpoint = 0");
    database.exec(`PRAGMA journal_size_limit = ${WAL_JOURNAL_SIZE_LIMIT_BYTES}`);
  }
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA foreign_keys = ON");
}

function metadataFor(worldId: string, scope: BotDataScope): ReadonlyMap<string, string> {
  return new Map([
    ["world_id", worldId],
    ["scope_kind", scope.kind],
    ["bot_id", scope.kind === "bot" ? scope.botId : ""],
  ]);
}

function rows(database: DatabaseSync, sql: string, parameters: SQLInputValue[]): SqlBotDataRow[] {
  return database
    .prepare(sql)
    .all(...parameters)
    .map((row) => ({ ...row }));
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return ((typeof value === "object" && value !== null) || typeof value === "function") && "then" in value;
}

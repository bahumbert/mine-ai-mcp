// Versioned steps of a bot-data file: `PRAGMA user_version` says which steps the file has had.
//
// Two rules every step obeys:
// 1. Idempotent against the latest shape. Step 1 runs the latest `bot-data.sql`, so a new file already has the
//    latest tables when the later steps run: a step uses IF NOT EXISTS, adds a column only when `pragma_table_info`
//    lacks it, and moves data only when its source table exists.
// 2. Bounded by the file's own rows. Steps run at open, after the bot is connected (a long block starves physics and
//    trips the watchdog): nothing that grows with the world runs here (a copy of the frontier is an asynchronous
//    import, never a step).
import type { DatabaseSync } from "node:sqlite";
import { BOT_DATA_SCHEMA } from "./bot-data-schema.js";
import { WORLD_DATA_SCHEMA } from "./world-data-schema.js";

export interface MigrationContext {
  /** Receives one line per step run (production: stderr). */
  readonly log: (line: string) => void;
}

/** A durable file reports each step on stderr, like its `opened` line; a session-only store has nothing to correlate. */
export function migrationContextFor(storage: "persistent" | "temporary"): MigrationContext {
  return { log: storage === "persistent" ? (line) => void process.stderr.write(`${line}\n`) : () => {} };
}

export interface MigrationStep {
  readonly version: number;
  readonly name: string;
  /** What it returns (counts of what it moved or left) goes into the step's `migrated` log line. */
  up(database: DatabaseSync, context: MigrationContext): void | Readonly<Record<string, number>>;
}

/** Preserve the cursor created before event reading was separated from notification policy. */
function migrateEventReadState(database: DatabaseSync): void {
  const oldTable = database
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'notification_state'")
    .get();
  const currentTable = database
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'event_read_state'")
    .get();
  if (oldTable !== undefined && currentTable === undefined) {
    database.exec("ALTER TABLE notification_state RENAME TO event_read_state");
  }
}

/**
 * The live-status and inventory rows are rewritten on every refresh, so an outdated shape is dropped rather than
 * altered: bot_status without `time_of_day` or `item_families_json`, bot_inventory without `families`, bot_tools without
 * `rank` (it had `tier`, a material label read from the item name). The schema script
 * that follows re-creates them; the runtime rewrites them within a second (status heartbeat), so nothing is lost.
 */
function migrateBotStatus(database: DatabaseSync): void {
  dropWhenMissingColumn(database, "bot_status", "time_of_day");
  dropWhenMissingColumn(database, "bot_status", "item_families_json");
  dropWhenMissingColumn(database, "bot_inventory", "families");
  dropWhenMissingColumn(database, "bot_tools", "rank");
}

function dropWhenMissingColumn(database: DatabaseSync, table: string, column: string): void {
  const columns = database.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[];
  if (columns.length > 0 && !columns.some((existing) => existing.name === column)) {
    database.exec(`DROP TABLE ${table}`);
  }
}

/** Extend call statuses without rewriting any historical response payload. */
function migrateActionResponses(database: DatabaseSync): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'action_responses'").get() as
    | { sql: string }
    | undefined;
  if (!row || row.sql.includes("'accepted'")) return;
  database.exec(`CREATE TABLE action_responses_async (
      request_id INTEGER PRIMARY KEY, responded_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
      status TEXT NOT NULL CHECK(status IN ('succeeded','partial','failed','cancelled','accepted','refused','pending','storage_failed','cancellation_requested')),
      response_json TEXT NOT NULL CHECK(json_valid(response_json)),
      FOREIGN KEY(request_id) REFERENCES action_requests(request_id) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO action_responses_async SELECT * FROM action_responses;
    DROP TABLE action_responses;
    ALTER TABLE action_responses_async RENAME TO action_responses;`);
}

/**
 * ALTER TABLE ... RENAME re-checks every view, and a view over a table the probes below dropped or reshaped fails
 * it; the views are derived and `bot-data.sql` creates them again at the end of the step.
 */
function dropViews(database: DatabaseSync): void {
  const views = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'view'").all() as { name: string }[];
  for (const view of views) database.exec(`DROP VIEW "${view.name.replaceAll('"', '""')}"`);
}

/** Every bot file reaches the three old shapes' successors and the latest tables through this step. */
const baselineStep: MigrationStep = {
  version: 1,
  name: "baseline",
  up(database) {
    dropViews(database);
    migrateEventReadState(database);
    migrateBotStatus(database);
    migrateActionResponses(database);
    database.exec(BOT_DATA_SCHEMA);
  },
};

/** The prefix the brain gave a memory's note context before memories had a table (brain/src/memory.ts, 2026-11). */
const MEMORY_NOTE_PREFIX = "brain memory: ";

/**
 * Moves the notes that hold a typed memory into `memories`, in note order, with no list of kinds: the word after the
 * prefix up to the first space is the kind (`relation:Theo` is kind `relation`, subject `theo`), the JSON object from
 * the first `{` is the data without its own `kind`. A note that does not parse, or whose kind is not a valid kind,
 * stays a note and is counted.
 */
function moveMemoryNotes(database: DatabaseSync): Readonly<Record<string, number>> {
  // The latest `memories` table: a file written by the runtime of version 1 has none, a new file got it in step 1.
  const hasMemories = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'memories'").get();
  if (hasMemories === undefined) database.exec(BOT_DATA_SCHEMA);
  database.exec(`
    CREATE TEMP TABLE memory_notes_moving AS
    WITH candidate AS (
      SELECT note_id, bot_id, note, remembered_at, dimension, x, y, z, world_age_ticks,
             substr(context, ${MEMORY_NOTE_PREFIX.length + 1}) AS rest,
             substr(context, instr(context, '{')) AS body
      FROM notes
      WHERE substr(context, 1, ${MEMORY_NOTE_PREFIX.length}) = '${MEMORY_NOTE_PREFIX}' AND instr(context, '{') > 0
    ), tokened AS (
      SELECT *, substr(rest, 1, instr(rest || ' ', ' ') - 1) AS token FROM candidate
    ), split AS (
      SELECT *,
             CASE WHEN instr(token, ':') > 0 THEN substr(token, 1, instr(token, ':') - 1) ELSE token END AS kind,
             CASE WHEN instr(token, ':') > 0 THEN lower(substr(token, instr(token, ':') + 1)) ELSE '' END AS subject
      FROM tokened
    )
    SELECT * FROM split
    WHERE json_valid(body) AND json_type(body) = 'object'
      AND kind GLOB '[a-z]*' AND kind NOT GLOB '*[^a-z0-9_]*' AND length(kind) <= 64 AND length(subject) <= 200;
    INSERT INTO memories (bot_id, kind, subject, version, data_json, note, saved_at, dimension, x, y, z, world_age_ticks)
      SELECT bot_id, kind, subject, 1, json_remove(body, '$.kind'), note, remembered_at, dimension, x, y, z, world_age_ticks
      FROM memory_notes_moving ORDER BY note_id;
    DELETE FROM notes WHERE note_id IN (SELECT note_id FROM memory_notes_moving);`);
  const counts = database
    .prepare(
      `SELECT (SELECT count(*) FROM memory_notes_moving) AS moved,
              (SELECT count(*) FROM notes WHERE substr(context, 1, ${MEMORY_NOTE_PREFIX.length}) = '${MEMORY_NOTE_PREFIX}') AS "left"`,
    )
    .get() as { moved: number; left: number };
  database.exec("DROP TABLE memory_notes_moving");
  return counts;
}

const typedMemoriesStep: MigrationStep = { version: 2, name: "typed-memories", up: moveMemoryNotes };

const LEGACY_FRONTIER_TABLES = ["frontier_chunks", "frontier_chunk_materials", "frontier_chunk_biomes"] as const;

/**
 * The frontier's tables leave the bot file for the world file. Only the O(1) part runs here: the old views are
 * dropped and the three tables renamed `legacy_<name>`; the copy into the world file is the asynchronous import
 * (src/runtime/legacy-frontier-import.ts, started by the session frontier), since it grows with the world.
 */
function renameLegacyFrontier(database: DatabaseSync): Readonly<Record<string, number>> {
  const tableExists = (name: string) =>
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !== undefined;
  // A file made by the latest `bot-data.sql` has no such table; one that already ran this step has the legacy ones.
  if (!tableExists("frontier_chunks") || tableExists("legacy_frontier_chunks")) return { renamedTables: 0 };
  database.exec("DROP VIEW IF EXISTS frontier_navigation; DROP VIEW IF EXISTS frontier_map_chunks;");
  for (const table of LEGACY_FRONTIER_TABLES) database.exec(`ALTER TABLE ${table} RENAME TO legacy_${table}`);
  return { renamedTables: LEGACY_FRONTIER_TABLES.length };
}

const worldFrontierStep: MigrationStep = { version: 3, name: "world-frontier", up: renameLegacyFrontier };

/**
 * Files that ran step 1 before the item families (view_status stacks, `bot_tools.rank`) hold the old snapshot tables:
 * they are dropped and re-created, as step 1 does for a file of version 0 (idempotent: a current table is kept).
 */
const itemFamiliesStep: MigrationStep = {
  version: 4,
  name: "item-families",
  up(database) {
    dropViews(database);
    migrateBotStatus(database);
    database.exec(BOT_DATA_SCHEMA);
  },
};

export const BOT_DATA_STEPS: readonly MigrationStep[] = [baselineStep, typedMemoriesStep, worldFrontierStep, itemFamiliesStep];

/** The world file's own steps (same two rules as the bot file's): step 1 is the latest `world-data.sql`. */
export const WORLD_DATA_STEPS: readonly MigrationStep[] = [
  { version: 1, name: "baseline", up: (database) => void database.exec(WORLD_DATA_SCHEMA) },
];

/** The version a file has after every step of `steps` ran. */
export function newestVersion(steps: readonly MigrationStep[]): number {
  return steps.at(-1)?.version ?? 0;
}

function readUserVersion(database: DatabaseSync): number {
  return Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

/**
 * Runs the steps above the file's `user_version`, each in its own transaction. A file newer than the steps is
 * refused before anything is written; a throwing step rolls back and names itself, so the next open retries it.
 */
export function runMigrations(
  database: DatabaseSync,
  steps: readonly MigrationStep[],
  context: MigrationContext,
  file: string,
): void {
  const newest = newestVersion(steps);
  const found = readUserVersion(database);
  if (found > newest) {
    throw new Error(
      `[BOT_DATA_TOO_NEW] ${file} is bot-data version ${found}; this runtime knows up to ${newest}: update the runtime.`,
    );
  }
  for (const step of steps) {
    if (step.version > found) runStep(database, step, context, file);
  }
}

/** One step under the write lock: a second host may have run it since the version was read, then it is skipped. */
function runStep(database: DatabaseSync, step: MigrationStep, context: MigrationContext, file: string): void {
  const started = performance.now();
  let counts: Readonly<Record<string, number>> = {};
  database.exec("BEGIN IMMEDIATE");
  try {
    if (readUserVersion(database) >= step.version) {
      database.exec("COMMIT");
      return;
    }
    counts = step.up(database, context) ?? {};
    database.exec(`PRAGMA user_version = ${step.version}`);
    database.exec("COMMIT");
  } catch (cause) {
    if (database.isTransaction) database.exec("ROLLBACK");
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`[BOT_DATA_MIGRATION_FAILED] step ${step.version} ${step.name}: ${reason}`, { cause });
  }
  context.log(
    `[minecraft-bot-data] ${JSON.stringify({ event: "migrated", file, step: step.version, name: step.name, ...counts, ms: Math.round(performance.now() - started) })}`,
  );
}

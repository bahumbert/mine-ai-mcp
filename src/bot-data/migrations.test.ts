import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createNoteReadAction } from "../actions/note-read/index.js";
import { persistentBotData, persistentFile } from "../test-support/bot-data.js";
import { runMigrations, type MigrationStep } from "./migrations.js";
import { closeSqlDatabase, SQL_BOT_DATA_SCHEMA_VERSION } from "./sql-bot-data.js";

function userVersion(database: DatabaseSync): number {
  return Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

/** A raw connection to a bot file, closed with the test's storage. */
function rawConnection(storage: ReturnType<typeof persistentBotData>, file: string): DatabaseSync {
  const database = new DatabaseSync(file);
  storage.alsoClose(() => {
    if (database.isOpen) closeSqlDatabase(database);
  });
  return database;
}

const migratedLines = (lines: string[]) => lines.filter((line) => line.includes('"event":"migrated"'));

/** Collects what the store writes to stderr until the test ends. */
function captureStderr(t: TestContext, lines: string[]): void {
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
}

const silent = { log: () => {} };

test("a new file reaches the newest version", (t) => {
  const storage = persistentBotData(t);
  const data = storage.open("fresh-world");

  assert.deepEqual(data.read("PRAGMA user_version"), [{ user_version: SQL_BOT_DATA_SCHEMA_VERSION }]);
  assert.deepEqual(data.read("SELECT value FROM sql_bot_data_metadata WHERE key = 'schema_version'"), [
    { value: String(SQL_BOT_DATA_SCHEMA_VERSION) },
  ]);
});

test("a file of today (user_version 0, old table shapes) migrates to version 1 then on, keeping its rows", (t) => {
  const storage = persistentBotData(t);
  const original = storage.open("legacy-world");
  const file = persistentFile(original);
  original.close();
  const legacy = rawConnection(storage, file);
  legacy.exec(`
    DROP TABLE event_read_state;
    CREATE TABLE notification_state (
      bot_id TEXT PRIMARY KEY,
      read_through_event_id INTEGER NOT NULL DEFAULT 0 CHECK (read_through_event_id >= 0),
      updated_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO notification_state VALUES ('Ayla', 7, '2026-09-12T00:00:00Z');
    DROP TABLE bot_status;
    CREATE TABLE bot_status (
      bot_id TEXT PRIMARY KEY, dimension TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL
    ) STRICT;
    DROP TABLE action_responses;
    CREATE TABLE action_responses (
      request_id INTEGER PRIMARY KEY, responded_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
      status TEXT NOT NULL CHECK(status IN ('succeeded','partial','failed','cancelled')),
      response_json TEXT NOT NULL CHECK(json_valid(response_json)),
      FOREIGN KEY(request_id) REFERENCES action_requests(request_id) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO action_requests VALUES (1, 'Ayla', 'navigate', 'Intent', '2026-09-12T00:00:00Z', '{}');
    INSERT INTO action_responses VALUES (1, '2026-09-12T00:00:01Z', 12, 'succeeded', '{}');
    PRAGMA user_version = 0;`);
  legacy.close();

  const migrated = storage.open("legacy-world");

  assert.deepEqual(migrated.read("PRAGMA user_version"), [{ user_version: SQL_BOT_DATA_SCHEMA_VERSION }]);
  assert.deepEqual(migrated.read("SELECT bot_id, read_through_event_id FROM event_read_state"), [
    { bot_id: "Ayla", read_through_event_id: 7 },
  ]);
  assert.deepEqual(migrated.read("SELECT request_id, duration_ms FROM action_responses"), [{ request_id: 1, duration_ms: 12 }]);
  assert.ok(migrated.read("SELECT sql FROM sqlite_master WHERE name = 'action_responses'")[0]?.sql?.toString().includes("'accepted'"));
  assert.ok(migrated.read("SELECT name FROM pragma_table_info('bot_status')").some((column) => column.name === "time_of_day"));
  assert.equal(migrated.read("SELECT name FROM sqlite_master WHERE name = 'notification_state'").length, 0);
});

test("a file newer than the runtime is refused untouched", (t) => {
  const storage = persistentBotData(t);
  const original = storage.open("future-world");
  const file = persistentFile(original);
  original.close();
  const future = rawConnection(storage, file);
  future.exec("PRAGMA user_version = 99");
  future.close();
  const sha = () => createHash("sha256").update(readFileSync(file)).digest("hex");
  const before = sha();

  assert.throws(
    () => storage.open("future-world"),
    (error) =>
      error instanceof Error &&
      error.message.startsWith("[BOT_DATA_TOO_NEW]") &&
      error.message.includes("version 99") &&
      error.message.includes(`up to ${SQL_BOT_DATA_SCHEMA_VERSION}`),
  );
  assert.equal(sha(), before);
});

test("a failing step rolls back and the next open retries it", (t) => {
  const storage = persistentBotData(t);
  const database = rawConnection(storage, `${storage.root}/steps.sqlite`);
  const first: MigrationStep = { version: 1, name: "first", up: (db) => db.exec("CREATE TABLE a (x INTEGER)") };
  const failing: MigrationStep = {
    version: 2,
    name: "second",
    up: (db) => {
      db.exec("CREATE TABLE b (x INTEGER)");
      throw new Error("disk said no");
    },
  };
  assert.throws(
    () => runMigrations(database, [first, failing], silent, "steps.sqlite"),
    /^Error: \[BOT_DATA_MIGRATION_FAILED\] step 2 second: disk said no$/,
  );
  assert.equal(userVersion(database), 1);
  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").all().length, 0);

  const fixed: MigrationStep = { version: 2, name: "second", up: (db) => db.exec("CREATE TABLE b (x INTEGER)") };
  runMigrations(database, [first, fixed], silent, "steps.sqlite");
  assert.equal(userVersion(database), 2);
  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").all().length, 1);
});

test("a step another connection already ran is skipped", (t) => {
  const storage = persistentBotData(t);
  const file = `${storage.root}/shared-steps.sqlite`;
  const first: MigrationStep = { version: 1, name: "first", up: (db) => db.exec("CREATE TABLE a (x INTEGER)") };
  const ran: string[] = [];
  const second = (who: string): MigrationStep => ({ version: 2, name: "second", up: () => void ran.push(who) });
  const winner = rawConnection(storage, file);
  const loser = rawConnection(storage, file);
  runMigrations(loser, [first], silent, file);

  // The loser has read user_version 1 when the winner runs step 2 between its read and its lock.
  let interleaved = false;
  const loserSeenByRunner = new Proxy(loser, {
    get(target, property) {
      if (property === "exec") {
        return (sql: string) => {
          if (sql === "BEGIN IMMEDIATE" && !interleaved) {
            interleaved = true;
            runMigrations(winner, [first, second("winner")], silent, file);
          }
          return target.exec(sql);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  runMigrations(loserSeenByRunner, [first, second("loser")], silent, file);

  assert.ok(interleaved);
  assert.deepEqual(ran, ["winner"]);
  assert.equal(userVersion(loser), 2);
});

test("reopening a migrated file runs no step", (t) => {
  const storage = persistentBotData(t);
  const lines: string[] = [];
  captureStderr(t, lines);
  storage.open("reopen-world").close();
  assert.ok(migratedLines(lines).length >= 1, "the first open runs the baseline step");

  lines.length = 0;
  storage.open("reopen-world");

  assert.deepEqual(migratedLines(lines), []);
});

const NOTE_TIME = "2026-11-10T10:00:00.000Z";
const placeNote = { note: "I know a place: Home (d).", context: 'brain memory: place {"kind":"place","place":{"name":"Home","detail":"d"}}' };
const relationNote = {
  note: "My relationship record with Theo.",
  context: 'brain memory: relation:Theo {"kind":"relation","relation":{"partner":"Theo","v":2}}',
};
const brokenFarmNote = { note: "My wheat farm.", context: "brain memory: farm {broken" };
const plainNote = { note: "Remember the lava lake.", context: "found while mining" };

/** A bot file as the runtime of version 1 left it: notes only, no memories table. */
function versionOneFileWithNotes(storage: ReturnType<typeof persistentBotData>, world: string, notes: readonly { note: string; context: string }[]) {
  const original = storage.open(world);
  const file = persistentFile(original);
  original.close();
  const raw = rawConnection(storage, file);
  raw.exec("DROP TABLE memories; PRAGMA user_version = 1");
  const insert = raw.prepare("INSERT INTO notes (bot_id, note, context, remembered_at, dimension, x, y, z, world_age_ticks) VALUES ('Ayla', ?, ?, ?, 'overworld', 1.5, 64, -2.5, 4800)");
  for (const { note, context } of notes) insert.run(note, context, NOTE_TIME);
  raw.close();
}

test("memory notes become rows in note order", (t) => {
  const storage = persistentBotData(t);
  versionOneFileWithNotes(storage, "memory-world", [placeNote, relationNote, brokenFarmNote, plainNote]);

  const data = storage.open("memory-world");

  assert.deepEqual(data.read("PRAGMA user_version"), [{ user_version: SQL_BOT_DATA_SCHEMA_VERSION }]);
  assert.deepEqual(data.read("SELECT bot_id, kind, subject, version, data_json, note, saved_at, dimension, x, y, z, world_age_ticks FROM memories ORDER BY memory_id"), [
    {
      bot_id: "Ayla", kind: "place", subject: "", version: 1, data_json: '{"place":{"name":"Home","detail":"d"}}',
      note: placeNote.note, saved_at: NOTE_TIME, dimension: "overworld", x: 1.5, y: 64, z: -2.5, world_age_ticks: 4800,
    },
    {
      bot_id: "Ayla", kind: "relation", subject: "theo", version: 1, data_json: '{"relation":{"partner":"Theo","v":2}}',
      note: relationNote.note, saved_at: NOTE_TIME, dimension: "overworld", x: 1.5, y: 64, z: -2.5, world_age_ticks: 4800,
    },
  ]);
});

test("an unparsable memory note stays a note and the step counts it", (t) => {
  const storage = persistentBotData(t);
  versionOneFileWithNotes(storage, "broken-memory-world", [placeNote, brokenFarmNote, plainNote]);
  const lines: string[] = [];
  captureStderr(t, lines);

  const data = storage.open("broken-memory-world");

  assert.deepEqual(data.read("SELECT note FROM notes ORDER BY note_id").map((row) => row.note), [brokenFarmNote.note, plainNote.note]);
  const step = migratedLines(lines).find((line) => line.includes('"step":2'));
  assert.ok(step?.includes('"name":"typed-memories"'));
  assert.ok(step?.includes('"left":1'), `the step 2 line was: ${step}`);
});

test("a memory note whose kind is not a valid kind stays a note", (t) => {
  const storage = persistentBotData(t);
  const capital = { note: "x", context: 'brain memory: Farm {"kind":"Farm"}' };
  const empty = { note: "y", context: 'brain memory: {"kind":"x"}' };
  versionOneFileWithNotes(storage, "bad-kind-world", [capital, empty]);

  const data = storage.open("bad-kind-world");

  assert.deepEqual(data.read("SELECT count(*) AS n FROM memories"), [{ n: 0 }]);
  assert.equal(data.read("SELECT count(*) AS n FROM notes")[0]?.n, 2);
});

test("step 2 on a file with no notes does nothing", (t) => {
  const storage = persistentBotData(t);
  versionOneFileWithNotes(storage, "no-notes-world", []);

  const data = storage.open("no-notes-world");

  assert.deepEqual(data.read("SELECT count(*) AS n FROM memories"), [{ n: 0 }]);
  assert.deepEqual(data.read("PRAGMA user_version"), [{ user_version: SQL_BOT_DATA_SCHEMA_VERSION }]);
});

test("note_read after step 2 lists only the notes left", async (t) => {
  const storage = persistentBotData(t);
  versionOneFileWithNotes(storage, "note-read-world", [placeNote, relationNote, brokenFarmNote, plainNote]);
  const read = createNoteReadAction(storage.open("note-read-world"), "Ayla");

  const result = await read.execute(read.parse({}), {});

  assert.deepEqual(result.notes.map((note) => note.note), [plainNote.note, brokenFarmNote.note]);
});

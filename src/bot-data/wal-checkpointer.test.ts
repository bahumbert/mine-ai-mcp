import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { persistentBotData } from "../test-support/bot-data.js";
import { createCheckpointRunner, startWalCheckpointer, WAL_CHECKPOINT_INTERVAL_MS, WAL_JOURNAL_SIZE_LIMIT_BYTES } from "./wal-checkpointer.js";

const BOUND_MS = 5_000;
const MEGABYTE = 1024 * 1024;

/** Polls `done` until it holds or the wall-clock bound passes; never an unbounded wait. */
async function until(done: () => boolean, boundMs = BOUND_MS): Promise<boolean> {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    if (done()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return done();
}

/** A WAL-mode database written the way the store's bot connection is: no automatic checkpoint, no busy wait. */
function writerOn(t: TestContext, file: string): DatabaseSync {
  const database = new DatabaseSync(file);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA wal_autocheckpoint = 0");
  database.exec("CREATE TABLE IF NOT EXISTS replies (id INTEGER PRIMARY KEY, body BLOB NOT NULL) STRICT");
  database.exec("PRAGMA busy_timeout = 0");
  t.after(() => database.close());
  return database;
}

function tempDatabaseFile(t: TestContext, name = "wal.sqlite"): string {
  const directory = mkdtempSync(path.join(tmpdir(), "mine-ai-wal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, name);
}

/** Writes `megabytes` of reply-sized rows, one transaction per megabyte. */
function writeMegabytes(database: DatabaseSync, megabytes: number): void {
  const body = new Uint8Array(MEGABYTE).fill(7);
  for (let index = 0; index < megabytes; index += 1) {
    database.exec("BEGIN IMMEDIATE");
    database.prepare("INSERT INTO replies (body) VALUES (?)").run(body);
    database.exec("COMMIT");
  }
}

/** The main file only grows when frames are copied into it: it shows a checkpoint without performing one. */
function mainFileBytes(file: string): number {
  return statSync(file).size;
}

function walFileBytes(file: string): number {
  try {
    return statSync(`${file}-wal`).size;
  } catch {
    return 0;
  }
}

test("the checkpoint interval and journal limit are the plan's constants", () => {
  assert.equal(WAL_CHECKPOINT_INTERVAL_MS, 2_000);
  assert.equal(WAL_JOURNAL_SIZE_LIMIT_BYTES, 64 * MEGABYTE);
});

test("frames written by the bot connection are checkpointed within the interval", async (t) => {
  const file = tempDatabaseFile(t);
  const writer = writerOn(t, file);
  writeMegabytes(writer, 8);
  assert.ok(mainFileBytes(file) < 4 * MEGABYTE, "with automatic checkpoints off nothing reaches the main file");
  using _checkpointer = startWalCheckpointer(file, { intervalMs: 100, fellBack: (cause) => assert.fail(cause) });
  assert.ok(await until(() => mainFileBytes(file) >= 7 * MEGABYTE), "the worker copied the frames into the main file");
});

test("the WAL file is truncated to the size limit once it resets", async (t) => {
  const file = tempDatabaseFile(t);
  const writer = writerOn(t, file);
  writer.exec(`PRAGMA journal_size_limit = ${MEGABYTE}`);
  using _checkpointer = startWalCheckpointer(file, { intervalMs: 100, fellBack: (cause) => assert.fail(cause) });
  writeMegabytes(writer, 8);
  assert.ok(await until(() => mainFileBytes(file) >= 8 * MEGABYTE), "every frame is in the main file");
  // The log restarts, and is cut back, at the first write after a complete checkpoint.
  const small = new Uint8Array(100);
  const reset = await until(() => {
    writer.prepare("INSERT INTO replies (body) VALUES (?)").run(small);
    return walFileBytes(file) <= 2 * MEGABYTE;
  });
  assert.ok(reset, `WAL is ${walFileBytes(file)} bytes`);
});

test("a checkpoint while a reader holds a snapshot is retried, not an error", async (t) => {
  const file = tempDatabaseFile(t);
  const writer = writerOn(t, file);
  writeMegabytes(writer, 1);
  const reader = new DatabaseSync(file);
  t.after(() => reader.close());
  reader.exec("BEGIN");
  reader.prepare("SELECT count(*) FROM replies").get();
  const failures: string[] = [];
  using _checkpointer = startWalCheckpointer(file, { intervalMs: 50, fellBack: (cause) => failures.push(cause) });
  writeMegabytes(writer, 7);
  await new Promise((resolve) => setTimeout(resolve, 300));
  reader.exec("COMMIT");
  assert.ok(await until(() => mainFileBytes(file) >= 7 * MEGABYTE), "checkpointed after the reader let go");
  assert.deepEqual(failures, []);
});

test("a worker that cannot open its connection calls fellBack once with the cause", async (t) => {
  const missing = path.join(tempDatabaseFile(t, "gone"), "no-such-directory", "bot-data.sqlite");
  const causes: string[] = [];
  const checkpointer = startWalCheckpointer(missing, { intervalMs: 50, fellBack: (cause) => causes.push(cause) });
  assert.ok(await until(() => causes.length > 0));
  await new Promise((resolve) => setTimeout(resolve, 200));
  checkpointer[Symbol.dispose]();
  assert.equal(causes.length, 1);
  assert.match(causes[0]!, /unable to open|cannot open/i);
});

test("closing the checkpointer stops the worker without calling fellBack", async (t) => {
  const file = tempDatabaseFile(t);
  const writer = writerOn(t, file);
  const causes: string[] = [];
  const checkpointer = startWalCheckpointer(file, { intervalMs: 50, fellBack: (cause) => causes.push(cause) });
  const started = Date.now();
  checkpointer[Symbol.dispose]();
  writeMegabytes(writer, 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(causes, []);
  assert.ok(Date.now() - started < 2_000);
  const later = new DatabaseSync(file);
  later.exec("INSERT INTO replies (body) VALUES (x'00')");
  later.close();
});

test("disposing the checkpointer has released its connection when it returns", async (t) => {
  // Closing a store and at once taking the file exclusively (a restart, a journal-mode change) must not meet the worker's connection.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const file = tempDatabaseFile(t, `release-${attempt}.sqlite`);
    const seed = new DatabaseSync(file);
    seed.exec("PRAGMA journal_mode = WAL; CREATE TABLE replies (id INTEGER PRIMARY KEY)");
    seed.close();
    const checkpointer = startWalCheckpointer(file, { intervalMs: 20, fellBack: (cause) => assert.fail(cause) });
    await new Promise((resolve) => setTimeout(resolve, 60));
    checkpointer[Symbol.dispose]();
    const exclusive = new DatabaseSync(file);
    exclusive.exec("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE");
    exclusive.exec("COMMIT");
    exclusive.close();
  }
});

test("the bot connection's writes are never refused while the worker checkpoints", async (t) => {
  const file = tempDatabaseFile(t);
  const writer = writerOn(t, file);
  const body = new Uint8Array(20 * 1024).fill(3);
  using _checkpointer = startWalCheckpointer(file, { intervalMs: 50, fellBack: (cause) => assert.fail(cause) });
  const refused: unknown[] = [];
  for (let index = 0; index < 500; index += 1) {
    try {
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("INSERT INTO replies (body) VALUES (?)").run(body);
      writer.exec("COMMIT");
    } catch (error) {
      refused.push(error);
      if (writer.isTransaction) writer.exec("ROLLBACK");
    }
    if (index % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(refused, []);
});

test("two stores on two files are each checkpointed", async (t) => {
  const first = tempDatabaseFile(t, "first.sqlite");
  const second = tempDatabaseFile(t, "second.sqlite");
  const firstWriter = writerOn(t, first);
  const secondWriter = writerOn(t, second);
  using _one = startWalCheckpointer(first, { intervalMs: 100, fellBack: (cause) => assert.fail(cause) });
  using _two = startWalCheckpointer(second, { intervalMs: 100, fellBack: (cause) => assert.fail(cause) });
  writeMegabytes(firstWriter, 6);
  writeMegabytes(secondWriter, 6);
  assert.ok(await until(() => mainFileBytes(first) >= 5 * MEGABYTE && mainFileBytes(second) >= 5 * MEGABYTE));
});

test("two checkpointers on one file both run and a busy answer is not an error", async (t) => {
  const file = tempDatabaseFile(t);
  const writer = writerOn(t, file);
  const failures: string[] = [];
  using _one = startWalCheckpointer(file, { intervalMs: 30, fellBack: (cause) => failures.push(cause) });
  using _two = startWalCheckpointer(file, { intervalMs: 30, fellBack: (cause) => failures.push(cause) });
  writeMegabytes(writer, 6);
  assert.ok(await until(() => mainFileBytes(file) >= 5 * MEGABYTE));
  assert.deepEqual(failures, []);
});

test("a checkpoint error is retried at the next interval and reported once per distinct message", () => {
  const reports: string[] = [];
  let failure: string | null = "disk I/O error";
  let attempts = 0;
  const run = createCheckpointRunner(
    {
      checkpoint: () => {
        attempts += 1;
        if (failure) throw new Error(failure);
      },
    },
    (message) => reports.push(message),
  );
  for (let index = 0; index < 100; index += 1) run();
  assert.equal(attempts, 100, "every interval retries");
  assert.deepEqual(reports, ["disk I/O error"]);
  failure = "database or disk is full";
  run();
  run();
  assert.deepEqual(reports, ["disk I/O error", "database or disk is full"]);
  failure = null;
  run();
  failure = "disk I/O error";
  run();
  assert.deepEqual(reports, ["disk I/O error", "database or disk is full", "disk I/O error"], "a recovered error is reported again");
});

test("a persistent store checkpoints through the worker", async (t) => {
  // The store-level wiring is tested in sql-bot-data.test.ts; this keeps the helper honest on a real store file.
  const storage = persistentBotData(t);
  const store = storage.open("checkpoint-wiring");
  const file = store.location.kind === "persistent" ? store.location.file : assert.fail("persistent expected");
  store.withWritableDatabase((database) => database.exec("CREATE TABLE replies (id INTEGER PRIMARY KEY, body BLOB NOT NULL) STRICT"));
  const body = new Uint8Array(MEGABYTE).fill(5);
  for (let index = 0; index < 8; index += 1) {
    store.transaction((database) => database.prepare("INSERT INTO replies (body) VALUES (?)").run(body));
  }
  assert.ok(await until(() => mainFileBytes(file) >= 7 * MEGABYTE, 8_000), "the worker's interval ran and copied the frames");
});

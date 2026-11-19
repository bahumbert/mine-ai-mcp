import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { closeSqlDatabase } from "./sql-bot-data.js";
import { SqlWorldData, removeUnclosedTemporaryWorlds } from "./sql-world-data.js";

/** A persistent root removed with the test; worlds and raw connections opened in it are closed first. */
function persistentRoot(t: TestContext): { root: string; closeAtEnd: (close: () => void) => void } {
  const root = mkdtempSync(path.join(tmpdir(), "mine-ai-world-test-"));
  const closers: (() => void)[] = [];
  t.after(() => {
    for (const close of closers) close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, closeAtEnd: (close) => void closers.push(close) };
}

function openPersistent(t: TestContext, worldId = "world-a") {
  const { root, closeAtEnd } = persistentRoot(t);
  const world = SqlWorldData.open({ storage: { kind: "persistent", root }, worldId });
  closeAtEnd(() => world.close());
  return { root, world, closeAtEnd };
}

const insertChunk = (database: DatabaseSync, key: string) =>
  database
    .prepare(
      "INSERT INTO frontier_chunks (chunk_key, dimension, chunk_x, chunk_z, first_observed_at, scanned_at, surface_water_fraction) VALUES (?, 'overworld', 0, 0, 'now', 'now', 0)",
    )
    .run(key);

test("two connections, one busy: write answers busy, then written", (t) => {
  const { world, closeAtEnd } = openPersistent(t);
  const other = new DatabaseSync(world.file);
  closeAtEnd(() => {
    if (other.isOpen) closeSqlDatabase(other);
  });
  other.exec("BEGIN IMMEDIATE");

  const began = performance.now();
  assert.deepEqual(world.write(() => "never", { name: "test" }), { status: "busy" });
  assert.ok(performance.now() - began < 1000, "a busy world must answer at once, not after a wait");

  other.exec("ROLLBACK");
  assert.deepEqual(world.write((database) => insertChunk(database, "overworld|0|0").changes, { name: "test" }), {
    status: "written",
    value: 1,
  });
});

test("opening a world file that is ready does not wait for another host's write lock", (t) => {
  const { root, world, closeAtEnd } = openPersistent(t);
  const other = new DatabaseSync(world.file);
  closeAtEnd(() => {
    if (other.isOpen) closeSqlDatabase(other);
  });
  other.exec("BEGIN IMMEDIATE");

  // Same thread: an open that tried to write would wait out busy_timeout (5 s) and then throw.
  const began = performance.now();
  const second = SqlWorldData.open({ storage: { kind: "persistent", root }, worldId: "world-a" });
  closeAtEnd(() => second.close());
  assert.ok(performance.now() - began < 1000, "a host connecting while another writes must not stall its thread");
});

test("a write that throws rolls back and rethrows, and the next write works", (t) => {
  const { world } = openPersistent(t);

  assert.throws(
    () =>
      world.write((database) => {
        insertChunk(database, "overworld|0|0");
        throw new Error("scan failed");
      }, { name: "test" }),
    /scan failed/,
  );

  assert.deepEqual(world.write((database) => insertChunk(database, "overworld|0|0").changes, { name: "test" }), {
    status: "written",
    value: 1,
  });
});

test("a newer world file is refused untouched", (t) => {
  const { root, world, closeAtEnd } = openPersistent(t, "world-new");
  const file = world.file;
  world.close();
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA user_version = 99");
  raw.close();
  const sha = () => createHash("sha256").update(readFileSync(file)).digest("hex");
  const before = sha();

  assert.throws(
    () => SqlWorldData.open({ storage: { kind: "persistent", root }, worldId: "world-new" }),
    (error) => error instanceof Error && error.message.startsWith("[BOT_DATA_TOO_NEW]") && error.message.includes("version 99"),
  );
  assert.equal(sha(), before);
  closeAtEnd(() => {});
});

test("a world file of another world id is refused", (t) => {
  const { root, world } = openPersistent(t, "world-one");
  const file = world.file;
  world.close();
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE sql_bot_data_metadata SET value = 'world-two' WHERE key = 'world_id'").run();
  raw.close();

  assert.throws(
    () => SqlWorldData.open({ storage: { kind: "persistent", root }, worldId: "world-one" }),
    /identity mismatch for world_id/,
  );
});

test("the world file sits in a world folder beside bots and shared", (t) => {
  const { root, world } = openPersistent(t, "world-path");

  assert.equal(path.basename(world.file), "world-data.sqlite");
  assert.equal(path.basename(path.dirname(world.file)), "world");
  assert.equal(path.dirname(path.dirname(path.dirname(world.file))), root);
});

test("a temporary world directory is removed at close", () => {
  const world = SqlWorldData.open({ storage: { kind: "temporary" }, worldId: "temporary-world" });
  const directory = path.dirname(world.file);
  assert.ok(existsSync(world.file));
  assert.ok(path.basename(directory).startsWith("mine-ai-world-"));

  world.close();
  world.close();

  assert.equal(existsSync(directory), false);
});

test("a temporary world nobody closed is removed by the exit sweep", () => {
  const world = SqlWorldData.open({ storage: { kind: "temporary" }, worldId: "forgotten-world" });
  const directory = path.dirname(world.file);

  removeUnclosedTemporaryWorlds();

  assert.equal(existsSync(directory), false);
  world.close();
});

test("a persistent world starts a checkpointer and stops it at close, a temporary world starts none", (t) => {
  const { root } = persistentRoot(t);
  const events: string[] = [];
  const start = (file: string) => {
    events.push(`start ${path.basename(file)}`);
    return { [Symbol.dispose]: () => void events.push("stop") };
  };
  const world = SqlWorldData.open({ storage: { kind: "persistent", root }, worldId: "checkpointed", startWalCheckpointer: start });
  world.close();
  world.close();
  SqlWorldData.open({ storage: { kind: "temporary" }, worldId: "none", startWalCheckpointer: start }).close();

  assert.deepEqual(events, ["start world-data.sqlite", "stop"]);
});

test("a read-only attach address survives a space, a hash, a question mark and a percent sign in the path", (t) => {
  const { root } = persistentRoot(t);
  const odd = path.join(root, "a b#c?d%e");
  const world = SqlWorldData.open({ storage: { kind: "persistent", root: odd }, worldId: "odd-path" });
  t.after(() => world.close());
  world.write((database) => insertChunk(database, "overworld|0|0"), { name: "test" });

  const reader = new DatabaseSync(":memory:");
  t.after(() => reader.close());
  reader.prepare("ATTACH DATABASE ? AS world").run(world.readOnlyAttachUri());

  assert.deepEqual(
    reader.prepare("SELECT chunk_key FROM world.frontier_chunks").all().map((row) => ({ ...row })),
    [{ chunk_key: "overworld|0|0" }],
  );
  assert.throws(() => reader.exec("DELETE FROM world.frontier_chunks"), /readonly|read-only/i);
});

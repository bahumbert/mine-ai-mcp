import assert from "node:assert/strict";
import { chmodSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { persistentBotData } from "../test-support/bot-data.js";
import { PeerRegionReader, readPeerRegionFile } from "./peer-regions.js";
import { ProtectedRegionStore, type RegionRequest } from "./protected-regions.js";
import type { SqlBotData } from "./sql-bot-data.js";

const WORLD = "peer-world";

function request(owner: string, createdBy: string, x: number, label = `${createdBy}'s ${x}`): RegionRequest {
  return {
    dimension: "overworld", min: { x, y: 63, z: 0 }, max: { x: x + 5, y: 70, z: 5 },
    owner, label, reason: "test", createdBy,
  };
}

/** One bot's real bot-data file in the shared temp root, with its store. */
function botOf(storage: ReturnType<typeof persistentBotData>, name: string) {
  const data: SqlBotData = storage.open(WORLD, { kind: "bot", botId: name });
  const store = new ProtectedRegionStore(data, name);
  const file = data.location.kind === "persistent" ? data.location.file : "";
  return { name, data, store, file };
}

function readerFor(file: string, extra: Partial<{ open: typeof readPeerRegionFile }> = {}) {
  const lines: string[] = [];
  return { reader: new PeerRegionReader(file, (line) => lines.push(line), extra.open), lines };
}

test("reads the regions of the other bots of the world, not its own, and keeps two peers' equal ids apart", (t) => {
  const storage = persistentBotData(t);
  const a = botOf(storage, "Ayla");
  const b = botOf(storage, "Tom");
  const c = botOf(storage, "Vex");
  a.store.protect(request("Ayla", "Ayla", 0));
  a.store.protect(request("Ayla", "Ayla", 100));
  b.store.protect(request("Tom", "Tom", 200));
  c.store.protect(request("Vex", "Vex", 300));
  const { reader } = readerFor(a.file);
  const regions = reader.read();
  assert.deepEqual(regions.map((region) => [region.heldBy, region.peer, region.owner, region.min.x, region.regionId]), [
    ["Tom", true, "Tom", 200, 1],
    ["Vex", true, "Vex", 300, 1],
  ]);
});

test("a bot that appears after start is read at the next read", (t) => {
  const storage = persistentBotData(t);
  const a = botOf(storage, "Ayla");
  const { reader } = readerFor(a.file);
  assert.deepEqual(reader.read(), []);
  const late = botOf(storage, "Vex");
  late.store.protect(request("Vex", "Vex", 50));
  assert.deepEqual(reader.read().map((region) => region.heldBy), ["Vex"]);
});

test("a peer without the protected_regions table reads as none and logs once", (t) => {
  const storage = persistentBotData(t);
  const a = botOf(storage, "Ayla");
  const b = botOf(storage, "Tom");
  b.data.withWritableDatabase((database) => database.exec("DROP TABLE protected_regions"));
  const { reader, lines } = readerFor(a.file);
  assert.deepEqual(reader.read(), []);
  assert.deepEqual(reader.read(), []);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /Tom/);
});

test("a busy peer keeps its last list", (t) => {
  const storage = persistentBotData(t);
  const a = botOf(storage, "Ayla");
  const b = botOf(storage, "Tom");
  b.store.protect(request("Tom", "Tom", 200));
  let opens = 0;
  const { reader, lines } = readerFor(a.file, {
    open: (file) => {
      opens += 1;
      // node:sqlite reports a locked database with errcode 5 (SQLITE_BUSY); a WAL writer's BEGIN EXCLUSIVE does not block readers, so a real lock cannot be made this way.
      if (opens === 2) throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
      return readPeerRegionFile(file);
    },
  });
  assert.equal(reader.read().length, 1);
  b.store.protect(request("Tom", "Tom", 300));
  assert.equal(reader.read().length, 1, "the busy read keeps the earlier list");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /busy|locked/i);
  assert.equal(reader.read().length, 2, "a busy file is read again at the next read, not forgotten");
  assert.equal(lines.length, 1);
});

test("an unchanged peer file is not opened again", (t) => {
  const storage = persistentBotData(t);
  const a = botOf(storage, "Ayla");
  const b = botOf(storage, "Tom");
  b.store.protect(request("Tom", "Tom", 200));
  let opens = 0;
  const { reader } = readerFor(a.file, { open: (file) => { opens += 1; return readPeerRegionFile(file); } });
  const first = reader.read();
  reader.read();
  assert.equal(opens, 1);
  assert.equal(reader.read(), first, "the same array while nothing changed");
  b.store.protect(request("Tom", "Tom", 300));
  assert.equal(reader.read().length, 2);
  assert.equal(opens, 2);
});

/** Takes every permission off a path for the body, so a stat or a listing of it fails; not meaningful for root. */
function withoutAccess(target: string, body: () => void): void {
  chmodSync(target, 0o000);
  try {
    body();
  } finally {
    chmodSync(target, 0o755);
  }
}
const canLoseAccess = process.getuid?.() !== 0 && process.platform !== "win32";

test("an unreadable sibling folder keeps its list, never throws, and does not hide the other peers", { skip: !canLoseAccess }, (t) => {
  const storage = persistentBotData(t);
  const a = botOf(storage, "Ayla");
  const b = botOf(storage, "Tom");
  b.store.protect(request("Tom", "Tom", 200));
  const { reader, lines } = readerFor(a.file);
  assert.equal(reader.read().length, 1);
  withoutAccess(path.dirname(b.file), () => {
    assert.equal(reader.read().length, 1, "the unreadable folder keeps its last list");
    const late = botOf(storage, "Vex");
    late.store.protect(request("Vex", "Vex", 300));
    assert.deepEqual(reader.read().map((region) => region.heldBy).sort(), ["Tom", "Vex"], "a new peer is still seen");
    assert.equal(readerFor(a.file).reader.read().length, 1, "a reader starting now does not throw either (only Vex is readable)");
  });
  assert.equal(lines.length, 1, "said once");
  assert.equal(reader.read().length, 2);
});

test("a bots folder that cannot be listed keeps every peer's list", { skip: !canLoseAccess }, (t) => {
  const storage = persistentBotData(t);
  const a = botOf(storage, "Ayla");
  botOf(storage, "Tom").store.protect(request("Tom", "Tom", 200));
  const { reader } = readerFor(a.file);
  assert.equal(reader.read().length, 1);
  withoutAccess(path.dirname(path.dirname(a.file)), () => {
    assert.equal(reader.read().length, 1, "a listing error is not a deleted peer");
  });
});

test("a deleted peer file drops its regions", (t) => {
  const storage = persistentBotData(t);
  const a = botOf(storage, "Ayla");
  const b = botOf(storage, "Tom");
  b.store.protect(request("Tom", "Tom", 200));
  const { reader } = readerFor(a.file);
  assert.equal(reader.read().length, 1);
  b.data.close();
  rmSync(path.dirname(b.file), { recursive: true, force: true });
  assert.deepEqual(reader.read(), []);
});

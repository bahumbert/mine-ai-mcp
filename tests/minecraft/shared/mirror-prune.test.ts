import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeMirror, makeSourceRoot, rootDirOf, withTemp, write } from "./mirror-fixtures.ts";
import type { MirrorPorts } from "./mirror.ts";

/** A complete (or, with `modulesHash` null, incomplete) snapshot directory as a daemon left it on disk. */
function leaveSnapshot(mirrorDir: string, daemon: string, root: string, generation: number, modulesHash: string | null = "hash-1", finishedAt = "2026-10-31T10:00:01.000Z"): string {
  const dir = join(rootDirOf(mirrorDir, root, daemon), `g${generation}`);
  mkdirSync(dir, { recursive: true });
  if (modulesHash !== null) {
    write(join(dir, ".snapshot.json"), JSON.stringify({ root, startedAt: "2026-10-31T10:00:00.000Z", finishedAt, modulesHash }));
  }
  return dir;
}

const LIVE_PID = 1000;
const DEAD_PID = 999;
/** Only `LIVE_PID` lives: not this test process, so a prune that did not skip its own directory would delete it. */
const pidAlive = (pid: number): boolean => pid === LIVE_PID;

/** The record a daemon keeps of its own process in its snapshot directory (`.daemon-pid`), as a daemon of this version leaves it. */
function leaveDaemonPid(mirrorDir: string, daemon: string, pid: number): void {
  write(join(mirrorDir, daemon, ".daemon-pid"), String(pid));
}

function generationNames(mirrorDir: string, daemon: string, root: string): string[] {
  const rootDir = rootDirOf(mirrorDir, root, daemon);
  return existsSync(rootDir) ? readdirSync(rootDir).sort() : [];
}

test("prune deletes an unheld old snapshot and an incomplete g, keeps the newest complete one", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { mirror, mirrorDir } = makeMirror(dir);
  leaveSnapshot(mirrorDir, "daemon-a", root, 1);
  leaveSnapshot(mirrorDir, "daemon-a", root, 2);
  leaveSnapshot(mirrorDir, "daemon-a", root, 3, null);
  await mirror.prune();
  assert.deepEqual(generationNames(mirrorDir, "daemon-a", root), ["g2"]);
}));

test("prune deletes the directory of a root that no longer exists (a removed worktree)", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const gone = join(dir, "removed-worktree");
  const { mirror, mirrorDir } = makeMirror(dir);
  leaveSnapshot(mirrorDir, "daemon-a", root, 1);
  leaveSnapshot(mirrorDir, "daemon-a", gone, 1);
  await mirror.prune();
  assert.equal(existsSync(rootDirOf(mirrorDir, gone, "daemon-a")), false);
  assert.deepEqual(generationNames(mirrorDir, "daemon-a", root), ["g1"]);
}));

test("prune treats a snapshot whose .snapshot.json is not valid JSON as incomplete", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { mirror, mirrorDir } = makeMirror(dir);
  leaveSnapshot(mirrorDir, "daemon-a", root, 1);
  const torn = leaveSnapshot(mirrorDir, "daemon-a", root, 2, null);
  write(join(torn, ".snapshot.json"), '{"root": "tru');
  await mirror.prune();
  assert.deepEqual(generationNames(mirrorDir, "daemon-a", root), ["g1"]);
}));

test("prune keeps a held snapshot that is not the newest", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { mirror } = makeMirror(dir);
  const first = await mirror.acquire(root);
  const second = await mirror.acquire(root);
  assert.ok(first.kind === "snapshot" && second.kind === "snapshot");
  if (first.kind !== "snapshot" || second.kind !== "snapshot") return;
  await mirror.prune();
  assert.equal(existsSync(first.dir), true, "g1 is held by a running submission");
  assert.equal(existsSync(second.dir), true);
}));

test("a snapshot directory that cannot be deleted is logged and left for the next prune: prune resolves, the other directories still go", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { mirror, mirrorDir, lines } = makeMirror(dir);
  const stuck = leaveSnapshot(mirrorDir, "daemon-a", root, 1);
  write(join(stuck, "locked", "f"), "x");
  chmodSync(join(stuck, "locked"), 0o500);
  const incomplete = leaveSnapshot(mirrorDir, "daemon-a", root, 2, null);
  leaveSnapshot(mirrorDir, "daemon-a", root, 3);
  try {
    await mirror.prune();
    assert.equal(existsSync(stuck), true, "g1 could not be deleted");
    assert.equal(existsSync(incomplete), false, "the next directory was still pruned");
    assert.match(lines.join("\n"), /could not delete .*g1.*next prune/u);
  } finally {
    chmodSync(join(stuck, "locked"), 0o700);
  }
}));

test("prune keeps a g whose sync is still running (it has no .snapshot.json yet)", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [];
  const run: MirrorPorts["run"] = async (_command, args) => {
    seen.push(String(args.at(-1)));
    await gate;
    return { code: 0, stderrTail: "" };
  };
  const { mirror, mirrorDir } = makeMirror(dir, { run });
  const pending = mirror.acquire(root);
  while (seen.length < 3) await new Promise(resolve => setTimeout(resolve, 5));
  await mirror.prune();
  assert.deepEqual(generationNames(mirrorDir, "daemon-a", root), ["g1"], "the g of a running sync has no .snapshot.json yet and stays");
  release();
  const result = await pending;
  assert.equal(result.kind, "snapshot");
}));

test("prune of daemon A leaves the directory of a live daemon B untouched", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { mirror, mirrorDir } = makeMirror(dir, { pidAlive }, { daemonSlug: "daemon-a" });
  leaveDaemonPid(mirrorDir, "daemon-b", LIVE_PID);
  leaveSnapshot(mirrorDir, "daemon-a", root, 1);
  leaveSnapshot(mirrorDir, "daemon-a", root, 2);
  leaveSnapshot(mirrorDir, "daemon-b", root, 1);
  leaveSnapshot(mirrorDir, "daemon-b", root, 2);
  leaveSnapshot(mirrorDir, "daemon-b", root, 3, null);
  await mirror.prune();
  assert.deepEqual(generationNames(mirrorDir, "daemon-a", root), ["g2"]);
  assert.deepEqual(generationNames(mirrorDir, "daemon-b", root), ["g1", "g2", "g3"]);
}));

test("prune hands pruneModules the lockfile hashes of daemons A and B, not those of snapshots it just deleted, and skips the modules directory", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { mirror, mirrorDir, pruned } = makeMirror(dir, { pidAlive }, { daemonSlug: "daemon-a" });
  leaveDaemonPid(mirrorDir, "daemon-b", LIVE_PID);
  leaveSnapshot(mirrorDir, "daemon-a", root, 1, "old-hash");
  leaveSnapshot(mirrorDir, "daemon-a", root, 2, "hash-a");
  leaveSnapshot(mirrorDir, "daemon-b", root, 1, "hash-b");
  mkdirSync(join(mirrorDir, "modules", "hash-a", "node_modules"), { recursive: true });
  await mirror.prune();
  assert.equal(pruned.length, 1);
  assert.deepEqual([...pruned[0]!].sort(), ["hash-a", "hash-b"]);
}));

test("prune with no mirror directory yet is no error and still asks pruneModules with an empty set", async () => withTemp(async dir => {
  const { mirror, pruned } = makeMirror(dir);
  await mirror.prune();
  assert.deepEqual(pruned.map(linked => [...linked]), [[]]);
}));

test("a dead daemon's snapshots are pruned, a live one's kept, and the dead one's modules tree is no longer linked", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { mirror, mirrorDir, pruned } = makeMirror(dir, { pidAlive }, { daemonSlug: "daemon-a" });
  leaveSnapshot(mirrorDir, "daemon-a", root, 1, "hash-a");
  leaveDaemonPid(mirrorDir, "daemon-dead", DEAD_PID);
  leaveSnapshot(mirrorDir, "daemon-dead", root, 4, "hash-dead");
  leaveDaemonPid(mirrorDir, "daemon-live", LIVE_PID);
  leaveSnapshot(mirrorDir, "daemon-live", root, 4, "hash-live");
  await mirror.prune();
  assert.equal(existsSync(join(mirrorDir, "daemon-dead")), false, "the whole directory of the dead daemon is gone");
  assert.deepEqual(generationNames(mirrorDir, "daemon-live", root), ["g4"]);
  assert.deepEqual([...pruned[0]!].sort(), ["hash-a", "hash-live"]);
}));

test("prune records this daemon's pid in its own directory, which the same prune does not delete", async () => withTemp(async dir => {
  const { mirror, mirrorDir } = makeMirror(dir, { pidAlive });
  await mirror.prune();
  assert.equal(readFileSync(join(mirrorDir, "daemon-a", ".daemon-pid"), "utf8"), String(process.pid));
}));

test("a mirror that is off records no pid", async () => withTemp(async dir => {
  const { mirror, mirrorDir } = makeMirror(dir, { pidAlive }, { enabled: false });
  await mirror.prune();
  assert.equal(existsSync(join(mirrorDir, "daemon-a", ".daemon-pid")), false);
}));

test("a daemon directory with no pid record is pruned once its newest snapshot is a day old, kept before", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const now = Date.parse("2026-11-01T12:00:00.000Z");
  const { mirror, mirrorDir } = makeMirror(dir, { pidAlive, now: () => now }, { daemonSlug: "daemon-a" });
  leaveSnapshot(mirrorDir, "daemon-old", root, 1, "hash-1", "2026-10-31T11:59:00.000Z");
  leaveSnapshot(mirrorDir, "daemon-recent", root, 1, "hash-1", "2026-10-31T12:30:00.000Z");
  await mirror.prune();
  assert.equal(existsSync(join(mirrorDir, "daemon-old")), false);
  assert.deepEqual(generationNames(mirrorDir, "daemon-recent", root), ["g1"]);
}));

test("a dead daemon's directory that cannot be deleted is logged and left for the next prune: prune resolves", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { mirror, mirrorDir, lines } = makeMirror(dir, { pidAlive }, { daemonSlug: "daemon-a" });
  leaveDaemonPid(mirrorDir, "daemon-stuck", DEAD_PID);
  const stuck = leaveSnapshot(mirrorDir, "daemon-stuck", root, 1);
  write(join(stuck, "locked", "f"), "x");
  chmodSync(join(stuck, "locked"), 0o500);
  try {
    await mirror.prune();
    assert.equal(existsSync(stuck), true);
    assert.match(lines.join("\n"), /could not delete .*daemon-stuck.*next prune/u);
  } finally {
    chmodSync(join(stuck, "locked"), 0o700);
  }
}));

// The daemon's directory of RAM roots (spec 2026-11-15-scenario-disk-stalls 3.1): its name, its owner file, and the sweep of dirs whose daemon is dead.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenarioServerConfig } from "./config.ts";
import { prepareWorldRamDir, worldRamDirName } from "./world-ram-dir.ts";

const SOCKET = "/tmp/mine-tsan-test.sock";
const DEAD_PID = 2_147_483_000;
const LIVE_PID = 4_321;

async function withRamDir(body: (ramDir: string, lines: string[]) => Promise<void>): Promise<void> {
  const ramDir = mkdtempSync(join(tmpdir(), "world-ram-dir-"));
  try {
    await body(ramDir, []);
  } finally {
    rmSync(ramDir, { recursive: true, force: true });
  }
}

function prepare(ramDir: string, lines: string[], socketPath = SOCKET, live: readonly number[] = []) {
  return prepareWorldRamDir({
    config: loadScenarioServerConfig({ MINE_AI_SCENARIO_WORLD_RAM_DIR: ramDir }), socketPath, log: line => lines.push(line), isLive: async pid => live.includes(pid),
  });
}

/** A directory another daemon left: `owner.json` of `pid` (none: no file) and one world file in it. */
function otherDaemonDir(ramDir: string, name: string, pid: number | null): string {
  const dir = join(ramDir, name);
  mkdirSync(join(dir, "s1-1", "world"), { recursive: true });
  writeFileSync(join(dir, "s1-1", "world", "level.dat"), "x");
  if (pid !== null) writeFileSync(join(dir, "owner.json"), JSON.stringify({ socketPath: "/tmp/other.sock", pid }));
  return dir;
}

test("the dir is named by the socket (the first 8 hex of its sha1) and holds an owner file with the socket and the daemon's pid", async () => {
  await withRamDir(async (ramDir, lines) => {
    const world = await prepare(ramDir, lines);
    const hash = createHash("sha1").update(SOCKET).digest("hex").slice(0, 8);
    assert.equal(worldRamDirName(SOCKET), `mine-ai-worlds-${hash}`);
    assert.equal(world?.dir, join(ramDir, `mine-ai-worlds-${hash}`));
    assert.deepEqual(JSON.parse(readFileSync(join(world!.dir, "owner.json"), "utf8")), { socketPath: SOCKET, pid: process.pid });
    assert.notEqual(worldRamDirName("/tmp/another.sock"), worldRamDirName(SOCKET), "two daemons on two sockets have two dirs");
  });
});

test("the sweep removes the dirs of dead owners (this socket's own from an earlier run included, and a dir with no readable owner file), keeps a living owner's dir and touches no other name", async () => {
  await withRamDir(async (ramDir, lines) => {
    const earlierRun = otherDaemonDir(ramDir, worldRamDirName(SOCKET), DEAD_PID);
    const dead = otherDaemonDir(ramDir, "mine-ai-worlds-dead00aa", DEAD_PID);
    const ownerless = otherDaemonDir(ramDir, "mine-ai-worlds-nofile00", null);
    const live = otherDaemonDir(ramDir, "mine-ai-worlds-live00bb", LIVE_PID);
    const foreign = join(ramDir, "something-else");
    mkdirSync(foreign);
    const world = await prepare(ramDir, lines, SOCKET, [LIVE_PID]);
    assert.deepEqual([dead, ownerless, live, foreign].map(existsSync), [false, false, true, true]);
    assert.equal(world?.dir, earlierRun);
    assert.equal(existsSync(join(earlierRun, "s1-1")), false, "the dead daemon's server is gone from the dir this daemon now owns");
    assert.equal(JSON.parse(readFileSync(join(earlierRun, "owner.json"), "utf8")).pid, process.pid);
    assert.match(lines.join("\n"), /removed 2 RAM world dirs? of dead daemons/u);
  });
});

test("a dir with this socket's name and a living owner other than this daemon is left alone: no RAM worlds for this daemon, and the log says why", async () => {
  await withRamDir(async (ramDir, lines) => {
    const held = otherDaemonDir(ramDir, worldRamDirName(SOCKET), LIVE_PID);
    assert.equal(await prepare(ramDir, lines, SOCKET, [LIVE_PID]), null);
    assert.equal(existsSync(join(held, "s1-1")), true);
    assert.match(lines.join("\n"), /worlds on disk: .* is held by a living daemon \(pid 4321\)/u);
  });
});

/** The staging dir name a daemon of `pid` makes its RAM dir under before it renames it into place (starts with a dot: the sweep's name filter of finished dirs ignores it). */
const stagingName = (socketPath: string, pid: number): string => `.${worldRamDirName(socketPath)}.${pid}.tmp`;

test("the dir appears with its owner file in one step: no `mine-ai-worlds-*` dir without an owner file, no staging dir left", async () => {
  await withRamDir(async (ramDir, lines) => {
    await prepare(ramDir, lines);
    const entries = readdirSync(ramDir);
    assert.deepEqual(entries.filter(name => name.endsWith(".tmp")), []);
    for (const name of entries) assert.ok(existsSync(join(ramDir, name, "owner.json")), `${name} holds its owner file`);
  });
});

test("a RAM dir that fails half-made leaves no `mine-ai-worlds-*` dir at all (a starting daemon's dir is never seen without its owner by another daemon's sweep)", async () => {
  await withRamDir(async (ramDir, lines) => {
    writeFileSync(join(ramDir, stagingName(SOCKET, process.pid)), "x"); // a file where the staging dir goes: the daemon cannot stage
    assert.equal(await prepare(ramDir, lines, SOCKET, [process.pid]), null, "the staging name is a living pid's, so the sweep keeps it");
    assert.deepEqual(readdirSync(ramDir).filter(name => name.startsWith("mine-ai-worlds-")), []);
    assert.match(lines.join("\n"), /worlds on disk: the RAM dir .* could not be made/u);
  });
});

test("the sweep keeps the staging dir of a living daemon that is starting and removes a dead one's", async () => {
  await withRamDir(async (ramDir, lines) => {
    const alive = join(ramDir, stagingName("/tmp/other-a.sock", LIVE_PID));
    const dead = join(ramDir, stagingName("/tmp/other-b.sock", DEAD_PID));
    mkdirSync(alive);
    mkdirSync(dead);
    await prepare(ramDir, lines, SOCKET, [LIVE_PID]);
    assert.deepEqual([alive, dead].map(existsSync), [true, false]);
  });
});

test("remove deletes the whole dir, owner file included, and a second call fails nothing", async () => {
  await withRamDir(async (ramDir, lines) => {
    const world = await prepare(ramDir, lines);
    mkdirSync(join(world!.dir, "s1-1"));
    await world!.remove();
    assert.equal(existsSync(world!.dir), false);
    await world!.remove();
  });
});

test("a RAM dir that cannot be made gives no RAM worlds, never an error that stops the daemon", async () => {
  await withRamDir(async (ramDir, lines) => {
    writeFileSync(join(ramDir, "file"), "x"); // a file where the RAM dir should be
    const world = await prepareWorldRamDir({
      config: loadScenarioServerConfig({ MINE_AI_SCENARIO_WORLD_RAM_DIR: join(ramDir, "file", "inside") }), socketPath: SOCKET, log: line => lines.push(line), isLive: async () => false,
    });
    assert.equal(world, null);
    assert.match(lines.join("\n"), /worlds on disk: the RAM dir .* could not be made: /u);
  });
});


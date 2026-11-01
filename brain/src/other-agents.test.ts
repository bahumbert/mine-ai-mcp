import assert from "node:assert/strict";
import test from "node:test";
import { OtherAgents } from "./other-agents.ts";
import { steppedClocks } from "./testing.ts";

/** A clock, a file and a log the test moves by hand: `file` null is a missing file. `write` is a temp-file + rename (new inode), as the launcher does. */
function fakeWorld(file: string | null) {
  const world = { file, mtimeMs: 1, ino: 1, now: 10_000, logs: [] as string[] };
  const deps = {
    stat: () => {
      if (world.file === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { mtimeMs: world.mtimeMs, ino: world.ino, size: world.file.length };
    },
    read: () => {
      if (world.file === null) throw new Error("ENOENT");
      return world.file;
    },
    now: () => world.now,
    log: (line: string) => world.logs.push(line),
  };
  const write = (usernames: unknown, mtimeMs: number) => {
    world.file = JSON.stringify({ usernames });
    world.mtimeMs = mtimeMs;
    world.ino++;
  };
  return { world, deps, write };
}

test("without a file option the names are the fixed ones but the agent's own (today's behaviour)", () => {
  const { deps, world } = fakeWorld(null);
  const others = new OtherAgents("Ayla", ["Ayla", "Brea"], null, deps);
  assert.deepEqual(others.names(), ["Brea"]);
  world.now += 5_000;
  assert.deepEqual(others.names(), ["Brea"]);
  assert.deepEqual(world.logs, [], "a missing file is no problem when no file was asked for");
});

test("the file's names join the fixed ones, the agent's own name and repeats dropped without case", () => {
  const { deps, write } = fakeWorld(null);
  write(["ayla", "Cato", "BREA"], 5);
  const others = new OtherAgents("Ayla", ["Ayla", "Brea"], "run/other-agents.json", deps);
  assert.deepEqual(others.names(), ["Brea", "Cato"]);
});

test("file change is seen without a restart, a second after the last look and not before", () => {
  const { deps, write, world } = fakeWorld(null);
  write(["Brea"], 5);
  const others = new OtherAgents("Ayla", [], "f.json", deps);
  assert.deepEqual(others.names(), ["Brea"]);
  write(["Brea", "Cato"], 6);
  world.now += 999;
  assert.deepEqual(others.names(), ["Brea"], "looked less than 1000 ms ago");
  world.now += 1;
  assert.deepEqual(others.names(), ["Brea", "Cato"]);
});

test("a rewrite inside one mtime tick is still seen (the clock of ext4 is coarse; the launcher's rename gives a new inode)", () => {
  const { deps, write, world } = fakeWorld(null);
  write(["Brea"], 5);
  const others = new OtherAgents("Ayla", [], "f.json", deps);
  assert.deepEqual(others.names(), ["Brea"]);
  write(["Cato"], 5);
  world.now += 1_000;
  assert.deepEqual(others.names(), ["Cato"]);
});

test("invalid JSON or a wrong shape keeps the previous names and logs once for the bad state", () => {
  const { deps, write, world } = fakeWorld(null);
  write(["Brea"], 5);
  const others = new OtherAgents("Ayla", ["Vex"], "f.json", deps);
  assert.deepEqual(others.names(), ["Vex", "Brea"]);
  world.file = "{not json";
  world.mtimeMs = 6;
  world.now += 1_000;
  assert.deepEqual(others.names(), ["Vex", "Brea"]);
  assert.equal(world.logs.length, 1);
  world.now += 1_000;
  others.names();
  assert.equal(world.logs.length, 1, "same bad file: no second line");
  write("Brea", 7);
  world.now += 1_000;
  assert.deepEqual(others.names(), ["Vex", "Brea"], "wrong shape also keeps the names");
  assert.equal(world.logs.length, 2);
  write(["Cato"], 8);
  world.now += 1_000;
  assert.deepEqual(others.names(), ["Vex", "Cato"], "a good file after a bad one is read");
});

test("by default the throttle reads the monotonic clock: a wall clock step back does not freeze the re-read", (t) => {
  const { deps, write } = fakeWorld(null);
  const { now: _injected, ...withoutClock } = deps;
  write(["Brea"], 5);
  const clocks = steppedClocks(t);
  const others = new OtherAgents("Ayla", [], "f.json", withoutClock);
  assert.deepEqual(others.names(), ["Brea"]);
  write(["Brea", "Cato"], 6);
  clocks.wall(-5_000);
  clocks.monotonic(1_000);
  assert.deepEqual(others.names(), ["Brea", "Cato"], "a second of real time passed, whatever the wall clock says");
});

test("a missing file keeps the last good names, logs once, and is read when it appears", () => {
  const { deps, write, world } = fakeWorld(null);
  const others = new OtherAgents("Ayla", ["Vex"], "f.json", deps);
  assert.deepEqual(others.names(), ["Vex"]);
  world.now += 1_000;
  others.names();
  assert.equal(world.logs.length, 1);
  write(["Brea"], 3);
  world.now += 1_000;
  assert.deepEqual(others.names(), ["Vex", "Brea"]);
  world.file = null;
  world.now += 1_000;
  assert.deepEqual(others.names(), ["Vex", "Brea"], "the file vanished: last good names");
});

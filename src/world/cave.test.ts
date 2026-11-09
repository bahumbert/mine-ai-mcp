import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { liveBlockReader } from "../navigation/index.js";
import { createFakeBot, type FakeBotOptions } from "../test-support/fake-bot/index.js";
import { CAVE_READS_PER_SCAN, caveReader } from "./cave.js";

type Cells = NonNullable<FakeBotOptions["cells"]>;
const point = (x: number, y: number, z: number) => ({ x, y, z });
const opening = (x = 0, z = 0): Cells => ({ [`${x},64,${z}`]: "air", [`${x},65,${z}`]: "air" });

function fixture(cells: Cells, groundY = 70) {
  const harness = createFakeBot({ cells, groundY });
  return { ...harness, reader: caveReader(harness.bot, { readsPerScan: 100_000 }) };
}

test("two dry air cells with a roof five above the head form a cave", () => {
  assert.equal(fixture(opening()).reader.inCave(point(0, 64, 0)), true);
});

test("one-high air and air with only three blocks above the head are not caves", () => {
  assert.equal(fixture({ "0,64,0": "air" }).reader.inCave(point(0, 64, 0)), false);
  assert.equal(fixture(opening(), 68).reader.inCave(point(0, 64, 0)), false);
});

test("a canopy is passed and a lake bed is the surface", () => {
  const canopy = fixture({ "0,70,0": "oak_log", "0,71,0": "oak_leaves" }, 63);
  assert.equal(canopy.reader.inCave(point(0, 64, 0)), false);
  const lake = fixture({ "0,64,0": "water", "0,65,0": "water", "0,59,0": "air", "0,60,0": "air" }, 63);
  assert.equal(lake.reader.inCave(point(0, 64, 0)), false);
  assert.equal(lake.reader.inCave(point(0, 59, 0)), false);
});

test("an overhang two above the head is open and one five above is a cave", () => {
  assert.equal(fixture({ "0,67,0": "stone" }, 63).reader.inCave(point(0, 64, 0)), false);
  assert.equal(fixture({ "0,70,0": "stone" }, 63).reader.inCave(point(0, 64, 0)), true);
});

test("a cave roof and wall top are cave targets", () => {
  const { reader } = fixture(opening());
  assert.equal(reader.caveTarget(point(0, 66, 0)), true);
  assert.equal(reader.caveTarget(point(1, 66, 0)), true);
});

test("open ground, an open cliff and a block two under grass are not cave targets", () => {
  const { reader } = fixture({ "1,64,0": "stone", "1,65,0": "stone", "1,66,0": "stone", "1,67,0": "stone", "1,68,0": "stone", "1,69,0": "stone", "1,70,0": "stone" }, 63);
  assert.equal(reader.caveTarget(point(0, 63, 0)), false);
  assert.equal(reader.caveTarget(point(1, 65, 0)), false);
  assert.equal(reader.caveTarget(point(0, 61, 0)), false);
});

test("an unloaded column stays unknown rather than becoming an open surface", () => {
  const { bot } = createFakeBot({ groundY: 63, loadedColumns: [] });
  const reader = caveReader(bot);
  assert.equal(reader.inCave(point(0, 64, 0)), null);
  assert.equal(reader.caveTarget(point(0, 64, 0)), null);
});

test("a changed or unloaded column invalidates a reader's cached answer", () => {
  const { bot, world } = createFakeBot({ groundY: 70, cells: opening() });
  const reader = caveReader(bot);
  assert.equal(reader.inCave(point(0, 64, 0)), true);
  world.setCell(new Vec3(0, 64, 0), "void");
  reader.beginScan();
  assert.equal(reader.inCave(point(0, 64, 0)), null);
  world.setCell(new Vec3(0, 64, 0), "stone");
  reader.beginScan();
  assert.equal(reader.inCave(point(0, 64, 0)), false);
});

test("a new roof invalidates an existing open-column memo", () => {
  const { bot, world } = createFakeBot({ groundY: 63 });
  const reader = caveReader(bot);
  assert.equal(reader.inCave(point(0, 64, 0)), false);
  world.setCell(new Vec3(0, 70, 0), "stone");
  reader.beginScan();
  assert.equal(reader.inCave(point(0, 64, 0)), true);
});

test("a column already read is reused and a dug stale hint still finds the surface", () => {
  const { bot } = createFakeBot({ cells: opening(), groundY: 70 });
  const base = liveBlockReader(bot);
  let reads = 0;
  const reader = caveReader(bot, { read: (x, y, z) => { reads++; return base(x, y, z); }, heightHint: () => 80 });
  assert.equal(reader.inCave(point(0, 64, 0)), true);
  const first = reads;
  assert.equal(reader.inCave(point(0, 64, 0)), true);
  assert.equal(reads, first);
});

test("a scan stays within its read budget and later scans resume", () => {
  const { bot } = createFakeBot({ groundY: 70 });
  const base = liveBlockReader(bot);
  let reads = 0;
  const reader = caveReader(bot, { read: (x, y, z) => { reads++; return base(x, y, z); }, readsPerScan: 10 });
  reader.beginScan();
  assert.equal(reader.inCave(point(0, 64, 0)), null);
  assert.ok(reads <= 10);
  let answer: boolean | null = null;
  for (let i = 0; i < 100 && answer === null; i++) { reader.beginScan(); answer = reader.inCave(point(0, 64, 0)); }
  assert.equal(answer, false);
  assert.ok(CAVE_READS_PER_SCAN > 0);
});

test("a cached cave still wins over unknown cells when the budget is exhausted", () => {
  const { bot } = createFakeBot({ groundY: 70, cells: opening() });
  const reader = caveReader(bot, { readsPerScan: 20, heightHint: () => 71 });
  assert.equal(reader.inCave(point(0, 64, 0)), true);
  for (let x = 10; x < 20; x++) reader.inCave(point(x, 64, 0));
  assert.equal(reader.caveTarget(point(1, 65, 0)), true);
});

test("1024 targets respect the scan budget and a later scan finishes an unread target", () => {
  const { bot } = createFakeBot({ groundY: 63 });
  const base = liveBlockReader(bot);
  let reads = 0;
  const reader = caveReader(bot, { read: (x, y, z) => { reads++; return base(x, y, z); }, heightHint: () => 320 });
  reader.beginScan();
  const answers = Array.from({ length: 1024 }, (_, i) => reader.caveTarget(point(i % 32, 64, Math.floor(i / 32))));
  assert.ok(reads <= CAVE_READS_PER_SCAN, `${reads} reads`);
  assert.ok(answers.includes(null));
  assert.equal(answers[0], null);
  let answer: boolean | null = null;
  for (let i = 0; i < 30 && answer === null; i++) { reader.beginScan(); answer = reader.caveTarget(point(0, 64, 0)); }
  assert.equal(answer, false);
});

test("twenty full scan budgets each read exactly the budget", () => {
  const { bot } = createFakeBot({ groundY: 63 });
  const base = liveBlockReader(bot);
  base(0, 319, 0); // Prebuild the fake's chunk outside the timed scan.
  const elapsed: number[] = [];
  for (let trial = 0; trial < 20; trial++) {
    let reads = 0;
    const reader = caveReader(bot, { read: (x, y, z) => { reads++; return base(x, y, z); }, heightHint: () => 320 });
    reader.beginScan();
    const started = performance.now();
    for (let x = 0; x < 16; x++) reader.inCave(point(x, 64, 0));
    elapsed.push(performance.now() - started);
    assert.equal(reads, CAVE_READS_PER_SCAN);
  }
  const slowest = Math.max(...elapsed);
  console.log(`MEASURED ${CAVE_READS_PER_SCAN} reads: max ${slowest.toFixed(2)} ms; minimum ${(CAVE_READS_PER_SCAN / slowest).toFixed(0)} reads/ms`);
});

test("a 1024-target scan reuses the columns it has read", () => {
  const { bot } = createFakeBot({ groundY: 63 });
  const base = liveBlockReader(bot);
  for (let x = -16; x <= 32; x += 16) for (let z = -16; z <= 32; z += 16) base(x, 319, z);
  let reads = 0;
  // A hint just above the ground keeps each column walk short; the memo is what this test checks.
  const reader = caveReader(bot, { read: (x, y, z) => { reads++; return base(x, y, z); }, readsPerScan: Infinity, heightHint: () => 70 });
  const targets = Array.from({ length: 1024 }, (_, i) => point(i % 32, 64, Math.floor(i / 32)));
  reader.beginScan();
  const started = performance.now();
  const answers = targets.map((target) => reader.caveTarget(target));
  const elapsed = performance.now() - started;
  const firstPass = reads;
  console.log(`MEASURED 1024 targets: ${elapsed.toFixed(2)} ms`);
  assert.ok(answers.every((answer) => answer !== null), "an unbudgeted scan answers every target");
  assert.ok(firstPass > 0);
  assert.deepEqual(targets.map((target) => reader.caveTarget(target)), answers);
  assert.equal(reads, firstPass);
});

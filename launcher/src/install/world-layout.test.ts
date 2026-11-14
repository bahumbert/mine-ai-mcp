import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { moveDimensionsBack, worldRanOnPaper } from "./world-layout.ts";

/** A server folder as Paper leaves it: the Nether and the End split out of `world`, each file holding its own name. */
function paperWorld(t: TestContext, { withEnd = true }: { withEnd?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "world-layout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "world", "region"), { recursive: true });
  mkdirSync(join(dir, "world_nether", "DIM-1", "region"), { recursive: true });
  writeFileSync(join(dir, "world_nether", "DIM-1", "region", "r.0.0.mca"), "nether");
  if (withEnd) {
    mkdirSync(join(dir, "world_the_end", "DIM1", "region"), { recursive: true });
    writeFileSync(join(dir, "world_the_end", "DIM1", "region", "r.0.0.mca"), "end");
  }
  return dir;
}

const read = (dir: string, ...path: string[]): string => readFileSync(join(dir, ...path), "utf8");

test("moves both dimensions back", async (t) => {
  const dir = paperWorld(t);
  const lines = await moveDimensionsBack(dir);
  assert.equal(read(dir, "world", "DIM-1", "region", "r.0.0.mca"), "nether");
  assert.equal(read(dir, "world", "DIM1", "region", "r.0.0.mca"), "end");
  assert.equal(existsSync(join(dir, "world_nether", "DIM-1")), false);
  assert.equal(existsSync(join(dir, "world_nether.after-vanilla")), true);
  assert.equal(existsSync(join(dir, "world_the_end.after-vanilla")), true);
  assert.match(lines.join("\n"), /world_nether\/DIM-1.*world\/DIM-1/u);
  assert.match(lines.join("\n"), /world_the_end\/DIM1.*world\/DIM1/u);
});

test("keeps the old target aside", async (t) => {
  const dir = paperWorld(t);
  mkdirSync(join(dir, "world", "DIM-1"), { recursive: true });
  writeFileSync(join(dir, "world", "DIM-1", "old.txt"), "a Nether vanilla made");
  const lines = await moveDimensionsBack(dir);
  assert.equal(read(dir, "world", "DIM-1.before-vanilla", "old.txt"), "a Nether vanilla made");
  assert.equal(read(dir, "world", "DIM-1", "region", "r.0.0.mca"), "nether");
  assert.match(lines.join("\n"), /DIM-1\.before-vanilla/u);
});

test("a missing world_the_end moves only the Nether", async (t) => {
  const dir = paperWorld(t, { withEnd: false });
  await moveDimensionsBack(dir);
  assert.equal(read(dir, "world", "DIM-1", "region", "r.0.0.mca"), "nether");
  assert.equal(existsSync(join(dir, "world", "DIM1")), false);
  assert.equal(existsSync(join(dir, "world_nether.after-vanilla")), true);
  assert.equal(existsSync(join(dir, "world_the_end.after-vanilla")), false);
});

test("a dimension folder Paper never filled is renamed without a move", async (t) => {
  const dir = paperWorld(t);
  rmSync(join(dir, "world_the_end", "DIM1"), { recursive: true });
  await moveDimensionsBack(dir);
  assert.equal(existsSync(join(dir, "world", "DIM1")), false);
  assert.equal(existsSync(join(dir, "world_the_end")), false);
  assert.equal(existsSync(join(dir, "world_the_end.after-vanilla")), true);
});

test("a moved-back world reads as not run on Paper", async (t) => {
  const dir = paperWorld(t);
  assert.equal(worldRanOnPaper(dir), true);
  await moveDimensionsBack(dir);
  assert.equal(worldRanOnPaper(dir), false);
});

test("a second round trip keeps the first one's aside folders", async (t) => {
  const dir = paperWorld(t);
  await moveDimensionsBack(dir);
  // Paper again: it moves the dimensions out of `world` and leaves the `.after-vanilla` folders where they are.
  mkdirSync(join(dir, "world_nether"));
  renameSync(join(dir, "world", "DIM-1"), join(dir, "world_nether", "DIM-1"));
  mkdirSync(join(dir, "world_the_end"));
  renameSync(join(dir, "world", "DIM1"), join(dir, "world_the_end", "DIM1"));
  await moveDimensionsBack(dir);
  assert.equal(read(dir, "world", "DIM-1", "region", "r.0.0.mca"), "nether");
  assert.equal(worldRanOnPaper(dir), false);
  assert.equal(existsSync(join(dir, "world_nether.after-vanilla")), true);
  assert.equal(existsSync(join(dir, "world_nether.after-vanilla-2")), true);
});

// The renames in order, without an old target: 1 Nether move, 2 Nether folder, 3 End move, 4 End folder. With an old Nether target: 1 is its set-aside.
const FAILED_RENAMES = [
  { name: "the End's move fails: the Nether's move and folder are undone", oldTarget: false, failsFrom: 3, undoWorks: true, message: /world_the_end\/DIM1.*EBUSY.*were undone/su },
  { name: "the Nether's move fails after the old target was set aside: the old target is put back", oldTarget: true, failsFrom: 2, undoWorks: true, message: /world_nether\/DIM-1.*EBUSY.*were undone/su },
  { name: "the undo fails too: the message names the folders still moved", oldTarget: false, failsFrom: 3, undoWorks: false, message: /world_the_end\/DIM1.*could not all be undone: world_nether\.after-vanilla, world\/DIM-1 still sit/su },
];

for (const { name, oldTarget, failsFrom, undoWorks, message } of FAILED_RENAMES) {
  test(`a failed rename names the folder and undoes what it can: ${name}`, async (t) => {
    const dir = paperWorld(t);
    if (oldTarget) {
      mkdirSync(join(dir, "world", "DIM-1"));
      writeFileSync(join(dir, "world", "DIM-1", "old.txt"), "old");
    }
    let calls = 0;
    const failingRename = async (from: string, to: string): Promise<void> => {
      calls += 1;
      const failing = calls === failsFrom || (!undoWorks && calls > failsFrom);
      if (failing) throw new Error("EBUSY: resource busy");
      renameSync(from, to);
    };
    await assert.rejects(moveDimensionsBack(dir, failingRename), (error: unknown) => error instanceof Error && message.test(error.message));
    assert.equal(worldRanOnPaper(dir), true); // world_the_end is still there: a second run finishes the job
    if (undoWorks) {
      assert.equal(read(dir, "world_nether", "DIM-1", "region", "r.0.0.mca"), "nether");
      assert.equal(read(dir, "world_the_end", "DIM1", "region", "r.0.0.mca"), "end");
      assert.equal(existsSync(join(dir, "world_nether.after-vanilla")), false);
      if (oldTarget) assert.equal(read(dir, "world", "DIM-1", "old.txt"), "old");
      else assert.equal(existsSync(join(dir, "world", "DIM-1")), false);
    }
  });
}

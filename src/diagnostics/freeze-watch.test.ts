import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { markPhase, startFreezeWatch } from "./freeze-watch.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const wedge = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

async function withWatch(run: (dir: string, watch: ReturnType<typeof startFreezeWatch>) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "freeze-watch-"));
  const watch = startFreezeWatch({ dir, botName: "Kenji", stallMs: 1000 });
  try {
    await run(dir, watch);
  } finally {
    watch[Symbol.dispose]();
    await rm(dir, { recursive: true, force: true });
  }
}

test("a wedged main thread leaves one freeze file holding the last marker", async () => {
  await withWatch(async (dir, watch) => {
    markPhase("progress: swim: moving");
    await sleep(300);
    markPhase("physicsTick: swim");
    wedge(2500);
    await sleep(600);
    const files = (await readdir(dir)).filter((name) => name.startsWith("freeze-"));
    assert.equal(files.length, 1);
    const record = JSON.parse(await readFile(path.join(dir, files[0]!), "utf8"));
    assert.equal(record.bot, "Kenji");
    assert.equal(record.markers.at(-1).text, "physicsTick: swim");
    assert.equal(record.markers[0].text, "progress: swim: moving");
    assert.ok(record.stalledForMs >= 1000);
    assert.ok(record.memory.rss > 0);
    assert.equal(typeof record.stack, "string");
    assert.equal(watch.lastRecord(), path.join(dir, files[0]!));
  });
});

test("no freeze file is written without a stall", async () => {
  await withWatch(async (dir) => {
    markPhase("idle");
    await sleep(1500);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("the marker ring wraps and keeps the newest 64 oldest first", async () => {
  await withWatch(async (dir) => {
    for (let index = 0; index < 100; index++) markPhase(`marker ${index} ${"x".repeat(400)}`);
    wedge(2300);
    await sleep(600);
    const [file] = (await readdir(dir)).filter((name) => name.startsWith("freeze-"));
    const record = JSON.parse(await readFile(path.join(dir, file!), "utf8"));
    assert.equal(record.markers.length, 64);
    assert.match(record.markers[0].text, /^marker 36 /);
    assert.match(record.markers.at(-1).text, /^marker 99 /);
    assert.ok(Buffer.byteLength(record.markers[0].text) <= 144);
  });
});

test("identical consecutive markers share one slot and count their repeats", async () => {
  await withWatch(async (dir) => {
    markPhase("before");
    for (let index = 0; index < 100; index++) markPhase("physicsTick: swim s1");
    markPhase("after");
    wedge(2300);
    await sleep(600);
    const [file] = (await readdir(dir)).filter((name) => name.startsWith("freeze-"));
    const record = JSON.parse(await readFile(path.join(dir, file!), "utf8"));
    assert.deepEqual(
      record.markers.map((marker: { text: string; repeats: number }) => [marker.text, marker.repeats]),
      [["before", 1], ["physicsTick: swim s1", 100], ["after", 1]],
    );
  });
});

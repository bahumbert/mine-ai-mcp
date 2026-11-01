// Template world build (plan scenario-clients-ext4 P2): fake ports stand for the Mine Labs server; one gated test builds for real.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadAllScenarios } from "../arena/all-scenarios.ts";
import { chunkCount, templateArea, type ChunkBox } from "../arena/template-area.ts";
import {
  BUILD_SERVER_PROPERTIES, buildTemplate, LogLineWaiters, LogWaitTimeout, realTemplatePorts, savedChunkCount,
  TEMPLATE_FORMAT, templateDir, templateKey, type TemplatePorts,
} from "./world-template.ts";
import { parseBuildArgs, probeServer } from "./world-template-cli.ts";

const VERSION = "1.21.4";
const GENERATOR_LINES = ["level-type=minecraft\\:flat", 'generator-settings={"layers"\\:[]}'];
const BOUND_MS = 180_000;
const FLUSH_MS = 10_800;
const RCON_TIMEOUT_MS = 10_000;
const REGION_FILE_CHUNKS = 1_024;
/** Vanilla 1.21.4 en_us.json `commands.forceload.added.failure`: it holds "marked", so a loose match would let it pass. */
const FORCELOAD_REFUSAL = "No chunks were marked for force loading";
/** The real build's test timeout is the build bound plus a server start (about 10 s) and stop (about 5 s) and the cache copy, rounded up. */
const REAL_BUILD_MARGIN_MS = 60_000;

async function withTemp(body: (cacheDir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "world-template-"));
  try { await body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** A region file with `entries` non-zero location entries in its first 4096 bytes, as the game writes them. */
function writeRegionFile(file: string, entries: number): void {
  const head = Buffer.alloc(8192);
  for (let i = 0; i < entries; i++) head.writeUInt32BE(0x00000201 + i, i * 4);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, head);
}

interface FakeOptions {
  /** Chunks that never answer a probe. */
  readonly silent?: (chunkX: number, chunkZ: number) => boolean;
  /** How many probes a loaded chunk fails before it answers. */
  readonly slowProbes?: number;
  /** The entries the saved region file holds, from the chunks forced. Default: every forced chunk plus 100 proto-chunks. */
  readonly savedEntries?: (forced: number) => number;
  readonly noSavedLine?: boolean;
  readonly startFails?: boolean;
  readonly beforeSave?: (cacheDir: string) => void;
  readonly cacheDir: string;
}

const COORD = "(-?\\d+)";
const FORCELOAD = new RegExp(`^forceload add ${COORD} ${COORD} ${COORD} ${COORD}$`);
const PROBE = new RegExp(`^execute if block ${COORD} -64 ${COORD} minecraft:bedrock$`);

/** Fake ports on a virtual clock; `events` is the order of everything the build did to the server and the disk. */
function fakePorts(options: FakeOptions) {
  const events: string[] = [];
  const forcedBatches: { readonly from: [number, number]; readonly to: [number, number] }[][] = [];
  const startedWith: Readonly<Record<string, string>>[] = [];
  const copies: { readonly from: string; readonly to: string; readonly templateJsonThere: boolean }[] = [];
  let clock = 0;
  const forced = new Set<string>();
  const probeCounts = new Map<string, number>();
  const ports: TemplatePorts = {
    now: () => clock,
    sleep: async ms => { clock += ms; },
    async startServer(version, root, properties) {
      events.push("start");
      if (options.startFails) throw new Error("java would not start");
      startedWith.push(properties);
      assert.equal(version, VERSION);
      writeFileSync(join(root, "server.properties"), ["server-port=1", ...GENERATOR_LINES, "view-distance=8"].join("\n"));
      mkdirSync(join(root, "world"), { recursive: true });
      const waiters = new LogLineWaiters();
      return {
        async rcon(command) {
          const add = FORCELOAD.exec(command);
          if (add) {
            const [fromX, fromZ, toX, toZ] = add.slice(1).map(Number) as [number, number, number, number];
            const chunks = (toX / 16 - fromX / 16 + 1) * (toZ / 16 - fromZ / 16 + 1);
            for (let x = fromX / 16; x <= toX / 16; x++) for (let z = fromZ / 16; z <= toZ / 16; z++) forced.add(`${x},${z}`);
            (forcedBatches.at(-1) ?? forcedBatches[forcedBatches.push([]) - 1]!).push({ from: [fromX / 16, fromZ / 16], to: [toX / 16, toZ / 16] });
            events.push("forceload add");
            return `Marked ${chunks} chunk(s) to be force loaded`;
          }
          const probe = PROBE.exec(command);
          if (probe) {
            const [x, z] = [Number(probe[1]) / 16, Number(probe[2]) / 16];
            const key = `${x},${z}`;
            const seen = (probeCounts.get(key) ?? 0) + 1;
            probeCounts.set(key, seen);
            const answers = forced.has(key) && !options.silent?.(x, z) && seen > (options.slowProbes ?? 0);
            if (answers) events.push("probe passed");
            return answers ? "Test passed" : "That position is not loaded"; // vanilla 1.21.4 en_us.json argument.pos.unloaded
          }
          if (command.startsWith("forceload remove")) {
            events.push("forceload remove");
            forcedBatches.push([]);
            return "Unmarked chunks";
          }
          if (command === "save-all flush") {
            events.push("rcon save-all flush");
            options.beforeSave?.(options.cacheDir);
            if (!options.noSavedLine) setTimeout(() => { clock += FLUSH_MS; events.push("log Saved the game"); waiters.feed("[Server thread/INFO]: Saved the game"); }, 1);
            clock += RCON_TIMEOUT_MS;
            return Promise.reject(new Error("RCON command timed out after 10000 ms"));
          }
          throw new Error(`unexpected command ${command}`);
        },
        waitForLog: (text, boundMs) => {
          if (!options.noSavedLine) return waiters.waitFor(text, boundMs);
          clock += boundMs; // the bound passes on the virtual clock, not on the wall clock
          return Promise.reject(new LogWaitTimeout(text, boundMs));
        },
        async stop() {
          events.push("stop");
          let left = (options.savedEntries ?? (count => count + 100))(forced.size);
          for (let file = 0; left > 0; file++, left -= REGION_FILE_CHUNKS) { // a region file holds at most 32 x 32 chunks
            writeRegionFile(join(root, "world", "region", `r.${file}.0.mca`), Math.min(left, REGION_FILE_CHUNKS));
          }
          mkdirSync(join(root, "world", "poi"), { recursive: true });
        },
      };
    },
    async copyDir(from, to) {
      events.push(`copy ${from.split(/[\\/]/).at(-1)}`);
      copies.push({ from, to, templateJsonThere: existsSync(join(dirname(to), "template.json")) });
      mkdirSync(to, { recursive: true });
      for (const name of readdirSync(from)) writeFileSync(join(to, name), readFileSync(join(from, name)));
    },
  };
  return { ports, events, forcedBatches, startedWith, copies, forced };
}

const SMALL_BOXES: ChunkBox[] = [{ minX: 0, minZ: 0, maxX: 19, maxZ: 19 }, { minX: 40, minZ: 0, maxX: 49, maxZ: 2 }]; // 400 + 30 chunks

function buildOptions(cacheDir: string, boxes: readonly ChunkBox[] = SMALL_BOXES, boundMs = BOUND_MS) {
  return { cacheDir, version: VERSION, boxes, boundMs, log: () => undefined };
}

function chunksOfBatch(batch: { from: [number, number]; to: [number, number] }[]): number {
  return batch.reduce((sum, run) => sum + (run.to[0] - run.from[0] + 1) * (run.to[1] - run.from[1] + 1), 0);
}

test("batches never exceed 256 chunks and cover every box", async () => {
  await withTemp(async cacheDir => {
    const fake = fakePorts({ cacheDir });
    const result = await buildTemplate(buildOptions(cacheDir), fake.ports);
    assert.equal(result.ok, true);
    const batches = fake.forcedBatches.filter(batch => batch.length > 0);
    assert.deepEqual(batches.map(chunksOfBatch), [256, 174]);
    assert.equal(fake.forced.size, chunkCount(SMALL_BOXES));
  });
});

test("each batch waits for its probes before the next", async () => {
  await withTemp(async cacheDir => {
    const fake = fakePorts({ cacheDir, slowProbes: 2 });
    await buildTemplate(buildOptions(cacheDir), fake.ports);
    const adds = fake.events.flatMap((event, index) => (event === "forceload add" ? [index] : []));
    const secondBatchStart = adds.find((index, i) => i > 0 && fake.events[index - 1] === "forceload remove")!;
    const passedBefore = fake.events.slice(0, secondBatchStart).filter(event => event === "probe passed").length;
    assert.equal(passedBefore, 256, "all 256 chunks of the first batch answered before the second batch's first forceload");
    assert.equal(fake.events[secondBatchStart - 1], "forceload remove", "the first batch is released before the next is forced");
  });
});

for (const [name, silent, boundMs] of [
  ["corners answer, an inner chunk does not", (x: number, z: number) => x === 5 && z === 5, 60_000],
  ["no probe ever answers", () => true, 5_000],
] as const) {
  test(`${name}: the build waits, then fails at the bound with bound: true, stops the server and leaves no directory`, async () => {
    await withTemp(async cacheDir => {
      const fake = fakePorts({ cacheDir, silent });
      const result = await buildTemplate(buildOptions(cacheDir, SMALL_BOXES, boundMs), fake.ports);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.bound, true);
      assert.match(result.ok ? "" : result.reason, /chunk/);
      assert.ok(fake.events.includes("stop"), "the server is stopped");
      assert.deepEqual(readdirSync(cacheDir), []);
    });
  });
}

test("savedChunkCount counts non-zero location entries of r.*.mca files: 3 entries give 3, an empty file 0; a short count fails the build", async () => {
  await withTemp(async cacheDir => {
    writeRegionFile(join(cacheDir, "hand", "r.0.0.mca"), 3);
    writeFileSync(join(cacheDir, "hand", "r.1.1.mca"), Buffer.alloc(0));
    writeFileSync(join(cacheDir, "hand", "notes.txt"), "not a region file");
    assert.equal(savedChunkCount(join(cacheDir, "hand")), 3);
    const fake = fakePorts({ cacheDir, savedEntries: () => 3 });
    const result = await buildTemplate(buildOptions(cacheDir), fake.ports);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.bound, false);
    assert.match(result.ok ? "" : result.reason, /only 3 of 430 chunks saved/);
    assert.ok(!readdirSync(cacheDir).some(name => name !== "hand"), "no tmp or build directory is left");
  });
});

test("the saved count may exceed chunkCount(boxes): proto-chunks around the forced ones", async () => {
  await withTemp(async cacheDir => {
    const fake = fakePorts({ cacheDir, savedEntries: forced => forced * 3 });
    const result = await buildTemplate(buildOptions(cacheDir), fake.ports);
    assert.equal(result.ok, true);
    const meta = JSON.parse(readFileSync(join(cacheDir, readdirSync(cacheDir)[0]!, "template.json"), "utf8")) as { chunks: number };
    assert.equal(meta.chunks, 430 * 3, "template.json holds the counted value");
  });
});

test("a <key> that appears during the build: ok, tmp deleted", async () => {
  await withTemp(async cacheDir => {
    const key = templateKey(VERSION, GENERATOR_LINES, SMALL_BOXES);
    const fake = fakePorts({
      cacheDir,
      beforeSave: dir => { mkdirSync(join(dir, key), { recursive: true }); writeFileSync(join(dir, key, "template.json"), "{}"); },
    });
    const result = await buildTemplate(buildOptions(cacheDir), fake.ports);
    assert.deepEqual(result, { ok: true, dir: join(cacheDir, key) });
    assert.deepEqual(readdirSync(cacheDir), [key]);
  });
});

test("a template that exists when the build server reports its generator: the server stops and nothing is built", async () => {
  await withTemp(async cacheDir => {
    const key = templateKey(VERSION, GENERATOR_LINES, SMALL_BOXES);
    mkdirSync(join(cacheDir, key), { recursive: true });
    writeFileSync(join(cacheDir, key, "template.json"), "{}");
    const fake = fakePorts({ cacheDir });
    const result = await buildTemplate(buildOptions(cacheDir), fake.ports);
    assert.deepEqual(result, { ok: true, dir: join(cacheDir, key) });
    assert.deepEqual(fake.events, ["start", "stop"]);
  });
});

test("template.json is the last file written, and the region copy comes first", async () => {
  await withTemp(async cacheDir => {
    const fake = fakePorts({ cacheDir });
    const result = await buildTemplate(buildOptions(cacheDir), fake.ports);
    assert.equal(result.ok, true);
    assert.deepEqual(fake.copies.map(copy => copy.templateJsonThere), [false, false]);
    assert.deepEqual(fake.copies.map(copy => copy.from.split(/[\\/]/).at(-1)), ["region", "poi"], "only the directories the server made are copied");
    const dir = result.ok ? result.dir : "";
    const meta = JSON.parse(readFileSync(join(dir, "template.json"), "utf8")) as Record<string, unknown>;
    assert.equal(meta.version, VERSION);
    assert.equal(meta.key, dir.split(/[\\/]/).at(-1));
    assert.deepEqual(meta.boxes, SMALL_BOXES);
  });
});

test("the key changes with a box, with the version, with the generator lines, with TEMPLATE_FORMAT", () => {
  const base = templateKey(VERSION, GENERATOR_LINES, SMALL_BOXES);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(templateKey(VERSION, [...GENERATOR_LINES].reverse(), SMALL_BOXES), base, "the order of the generator lines does not matter");
  assert.notEqual(templateKey(VERSION, GENERATOR_LINES, [{ ...SMALL_BOXES[0]!, maxX: 20 }, SMALL_BOXES[1]!]), base);
  assert.notEqual(templateKey("1.21.5", GENERATOR_LINES, SMALL_BOXES), base);
  assert.notEqual(templateKey(VERSION, ["level-type=minecraft\\:normal"], SMALL_BOXES), base);
  assert.notEqual(templateKey(VERSION, GENERATOR_LINES, SMALL_BOXES, TEMPLATE_FORMAT + 1), base);
});

test("templateDir ignores a directory without template.json", async () => {
  await withTemp(cacheDir => {
    mkdirSync(join(cacheDir, "abc"));
    assert.equal(templateDir(cacheDir, "abc"), null);
    assert.equal(templateDir(cacheDir, "missing"), null);
    writeFileSync(join(cacheDir, "abc", "template.json"), "{}");
    assert.equal(templateDir(cacheDir, "abc"), join(cacheDir, "abc"));
  });
});

test("the build server is started with sync-chunk-writes=false", async () => {
  await withTemp(async cacheDir => {
    const fake = fakePorts({ cacheDir });
    await buildTemplate(buildOptions(cacheDir), fake.ports);
    assert.deepEqual(fake.startedWith, [BUILD_SERVER_PROPERTIES]);
  });
});

test("the stop waits for the 'Saved the game' line, not the RCON answer, and no rejection goes unhandled", async () => {
  await withTemp(async cacheDir => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const fake = fakePorts({ cacheDir });
      const result = await buildTemplate(buildOptions(cacheDir), fake.ports);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(result.ok, true);
      const flush = fake.events.indexOf("rcon save-all flush");
      assert.deepEqual(fake.events.slice(flush, flush + 3), ["rcon save-all flush", "log Saved the game", "stop"]);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

test("no 'Saved the game' line within the bound: { ok: false, bound: true }, no directory", async () => {
  await withTemp(async cacheDir => {
    const fake = fakePorts({ cacheDir, noSavedLine: true });
    const result = await buildTemplate(buildOptions(cacheDir), fake.ports);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.bound, true);
    assert.match(result.ok ? "" : result.reason, /Saved the game/);
    assert.ok(fake.events.includes("stop"));
    assert.deepEqual(readdirSync(cacheDir), []);
  });
});

test("a server that will not start fails the build without a bound and leaves no directory", async () => {
  await withTemp(async cacheDir => {
    const fake = fakePorts({ cacheDir, startFails: true });
    const result = await buildTemplate(buildOptions(cacheDir), fake.ports);
    assert.deepEqual(result, { ok: false, reason: "build server did not start: java would not start", bound: false });
    assert.deepEqual(readdirSync(cacheDir), []);
  });
});

test("a refused forceload fails the build with the server's words", async () => {
  await withTemp(async cacheDir => {
    const fake = fakePorts({ cacheDir });
    const inner = fake.ports.startServer.bind(fake.ports);
    const refusing: TemplatePorts = {
      ...fake.ports,
      startServer: async (...args) => ({ ...(await inner(...args)), rcon: async command => (command.startsWith("forceload add") ? FORCELOAD_REFUSAL : "Test failed") }),
    };
    const result = await buildTemplate(buildOptions(cacheDir), refusing);
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /forceload add refused.*No chunks were marked for force loading/);
    assert.deepEqual(readdirSync(cacheDir), []);
  });
});

test("a <key> directory without template.json is not a template: the build replaces it", async () => {
  await withTemp(async cacheDir => {
    const key = templateKey(VERSION, GENERATOR_LINES, SMALL_BOXES);
    writeRegionFile(join(cacheDir, key, "region", "r.0.0.mca"), 1); // a crashed copy or a hand-made leftover
    const fake = fakePorts({ cacheDir });
    const result = await buildTemplate(buildOptions(cacheDir), fake.ports);
    assert.deepEqual(result, { ok: true, dir: join(cacheDir, key) });
    assert.notEqual(templateDir(cacheDir, key), null);
    assert.deepEqual(readdirSync(cacheDir), [key]);
  });
});

test("a build server that dies during the save fails the build at once, not as a bound", async () => {
  await withTemp(async cacheDir => {
    const fake = fakePorts({ cacheDir });
    const inner = fake.ports.startServer.bind(fake.ports);
    const dying: TemplatePorts = {
      ...fake.ports,
      startServer: async (...args) => ({ ...(await inner(...args)), waitForLog: () => Promise.reject(new Error("[server] exited code=137")) }),
    };
    const result = await buildTemplate(buildOptions(cacheDir), dying);
    assert.deepEqual(result, { ok: false, reason: "[server] exited code=137", bound: false });
    assert.deepEqual(readdirSync(cacheDir), []);
  });
});

test("LogLineWaiters.failAll rejects every pending wait with the error and clears its timer", async () => {
  const waiters = new LogLineWaiters();
  const first = waiters.waitFor("a", 60_000);
  const second = waiters.waitFor("b", 60_000);
  waiters.failAll(new Error("server exited"));
  await assert.rejects(first, /server exited/);
  await assert.rejects(second, /server exited/);
  assert.equal(waiters.pending(), 0);
});

test("LogLineWaiters: a line before the wait is not seen, one after it resolves, the bound rejects with LogWaitTimeout", async () => {
  const waiters = new LogLineWaiters();
  waiters.feed("Saved the game");
  const seen = waiters.waitFor("Saved the game", 1_000);
  waiters.feed("[INFO]: Saved the game");
  await seen;
  await assert.rejects(waiters.waitFor("never", 5), LogWaitTimeout);
  assert.equal(waiters.pending(), 0, "a timed-out wait leaves no timer or listener");
});

test("probeServer reads the view distance and generator lines the started server wrote, then stops it and removes its root", async () => {
  await withTemp(async cacheDir => {
    const fake = fakePorts({ cacheDir });
    assert.deepEqual(await probeServer(fake.ports, VERSION, join(cacheDir, "probe")), { viewChunks: 8, generatorLines: GENERATOR_LINES });
    assert.deepEqual(fake.events, ["start", "stop"]);
    assert.deepEqual(readdirSync(cacheDir), []);
  });
});

test("parseBuildArgs: versions and lanes optional, port a number", () => {
  assert.deepEqual(parseBuildArgs(["build"]), { versions: null, lanes: 28, port: null });
  assert.deepEqual(parseBuildArgs(["build", "--version", "1.21.4", "--lanes", "2", "--port", "25570"]), { versions: ["1.21.4"], lanes: 2, port: 25570 });
  assert.throws(() => parseBuildArgs(["build", "--lanes", "x"]), /--lanes/);
  assert.throws(() => parseBuildArgs(["build", "--lane", "2"]), /unknown flag --lane;/);
  assert.throws(() => parseBuildArgs(["sing"]), /usage/);
});

// One real build, gated: it starts a Minecraft server on a port of its own (25566 by default) and takes about a minute.
test("real build: lanes 1..2 of one contract scenario leave region files", { skip: process.env.MINE_AI_TEST_REAL_TEMPLATE !== "1", timeout: BOUND_MS + REAL_BUILD_MARGIN_MS }, async () => {
  await withTemp(async cacheDir => {
    const scenarios = (await loadAllScenarios()).filter(loaded => loaded.file.startsWith("contract/scenarios/")).slice(0, 1).map(loaded => loaded.scenario);
    const boxes = templateArea(scenarios, { lanes: 2, viewChunks: 8 });
    const port = Number(process.env.MINE_AI_TEST_TEMPLATE_PORT ?? 25566);
    const result = await buildTemplate({ cacheDir, version: VERSION, boxes, boundMs: BOUND_MS, log: line => console.log(line) }, realTemplatePorts({ preferPort: port }));
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    const dir = result.ok ? result.dir : "";
    assert.ok(savedChunkCount(join(dir, "region")) >= chunkCount(boxes));
    assert.ok(readdirSync(join(dir, "region")).some(name => name.endsWith(".mca")));
  });
});

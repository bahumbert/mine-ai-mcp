// Builds a template world on ext4 (the chunks lane servers would otherwise generate) and stores it by key; `bun world-template.ts build` builds ahead.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MinecraftServer, prepareWorldDir } from "mine-labs";
import { chunkCount, type ChunkBox } from "../arena/template-area.ts";
import { runBounded } from "./run-bounded.ts";

/** Bumped when the build changes what a template holds, so old templates stop matching. */
export const TEMPLATE_FORMAT = 1;

/**
 * The build server's properties. With Mine Labs' default `sync-chunk-writes=true` the final `save-all flush` of 35 604 chunks held one
 * tick over 60 s and the watchdog killed the server; with false: 43.8 s build, 10.8 s flush, 5.3 s stop (plan scenario-clients-ext4 P0, 2026-10-31).
 */
export const BUILD_SERVER_PROPERTIES = { "sync-chunk-writes": "false" } as const;

/** P0 measured the build at VmHWM 2.7 GB; the shared servers' 3 GB heap holds it. The daemon's memory ledger counts this heap for a build it runs. */
export const BUILD_SERVER_HEAP_MB = 3_072;
const BUILD_SERVER_HEAP = `${BUILD_SERVER_HEAP_MB}M`;
/** Mine Labs' `FORCELOAD_CHUNK_LIMIT` (compile.ts): vanilla refuses a `forceload add` beyond it. */
const FORCELOAD_BATCH_CHUNKS = 256;
const PROBE_POLL_MS = 20;
const BLOCKS_PER_CHUNK = 16;
/** Mine Labs' flat world floor: a chunk that holds this block is loaded. */
const FLOOR_PROBE = "execute if block %X -64 %Z minecraft:bedrock";
const SAVED_LINE = "Saved the game";
/** The directories of a world that make a template; the server makes `entities` and `poi` only when it has something to put in them. */
export const WORLD_DIRECTORIES = ["region", "entities", "poi"] as const;
const GENERATOR_PROPERTY_KEYS = ["level-type", "generator-settings"] as const;
const REGION_HEADER_BYTES = 4_096;
const LOCATION_ENTRY_BYTES = 4;
/** Mine Labs logs this when the server process ends (`server/server.ts`, `proc.on("exit")`). */
const SERVER_EXIT_LOG = "[server] exited code=";

/** `waitFor` ran out of time before the line came. */
export class LogWaitTimeout extends Error {
  constructor(text: string, boundMs: number) {
    super(`no server log line holding "${text}" within ${boundMs} ms`);
    this.name = "LogWaitTimeout";
  }
}

/** Server log lines fed in, and waits for the next line holding a text. A line that came before the wait is not seen. */
export class LogLineWaiters {
  private readonly waits = new Set<{ readonly text: string; readonly resolve: () => void; readonly fail: (error: Error) => void }>();

  feed(line: string): void {
    for (const wait of this.waits) {
      if (line.includes(wait.text)) wait.resolve();
    }
  }

  /** Rejects every pending wait: the server it listens to is gone, so its line will never come. */
  failAll(error: Error): void {
    for (const wait of this.waits) wait.fail(error);
  }

  waitFor(text: string, boundMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const settle = (finish: () => void): void => { clearTimeout(timer); this.waits.delete(wait); finish(); };
      const wait = { text, resolve: () => settle(resolve), fail: (error: Error) => settle(() => reject(error)) };
      const timer = setTimeout(() => wait.fail(new LogWaitTimeout(text, boundMs)), boundMs);
      this.waits.add(wait);
    });
  }

  /** Waits not yet settled (a test checks a timed-out wait leaves none). */
  pending(): number {
    return this.waits.size;
  }
}

export interface TemplateServer {
  rcon(command: string): Promise<string>;
  /** Resolves when a server log line holding `text` appears after this call; rejects with `LogWaitTimeout` at `boundMs`. */
  waitForLog(text: string, boundMs: number): Promise<void>;
  stop(): Promise<void>;
}

export interface TemplatePorts {
  /** A flat server of that version in `root`, with `properties` written by the Mine Labs patch's option; its world is `<root>/world`. */
  startServer(version: string, root: string, properties: Readonly<Record<string, string>>): Promise<TemplateServer>;
  copyDir(from: string, to: string, boundMs: number): Promise<void>;
  /** A monotonic millisecond clock, for the bound. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface BuildOptions {
  readonly cacheDir: string;
  readonly version: string;
  readonly boxes: readonly ChunkBox[];
  readonly boundMs: number;
  readonly log: (line: string) => void;
}

export type BuildResult =
  | { readonly ok: true; readonly dir: string }
  /** `bound`: the build ran out of time, so a later try on a quieter machine may pass; false: it failed for its own reason. */
  | { readonly ok: false; readonly reason: string; readonly bound: boolean };

/** The SHA-256 of what decides a template's contents: the game version, the generator Mine Labs writes, the chunk boxes and the format. */
export function templateKey(version: string, generatorLines: readonly string[], boxes: readonly ChunkBox[], format = TEMPLATE_FORMAT): string {
  return createHash("sha256").update(JSON.stringify([format, version, [...generatorLines].sort(), boxes])).digest("hex");
}

/** The directory of a finished template, or null: a directory without `template.json` is a build that did not finish. */
export function templateDir(cacheDir: string, key: string): string | null {
  const dir = join(cacheDir, key);
  return existsSync(join(dir, "template.json")) ? dir : null;
}

/** Saved chunks of a region directory: the non-zero location entries of each `r.*.mca` header. */
export function savedChunkCount(regionDir: string): number {
  if (!existsSync(regionDir)) return 0;
  return readdirSync(regionDir).filter(file => /^r\..*\.mca$/u.test(file)).reduce((total, name) => total + locationEntriesOf(join(regionDir, name)), 0);
}

function locationEntriesOf(regionFile: string): number {
  const header = Buffer.alloc(REGION_HEADER_BYTES);
  const fd = openSync(regionFile, "r");
  try {
    const read = readSync(fd, header, 0, REGION_HEADER_BYTES, 0);
    let entries = 0;
    for (let offset = 0; offset + LOCATION_ENTRY_BYTES <= read; offset += LOCATION_ENTRY_BYTES) entries += header.readUInt32BE(offset) === 0 ? 0 : 1;
    return entries;
  } finally {
    closeSync(fd);
  }
}

/** The `server.properties` lines of the generator (kept raw: they hold Mine Labs' own escapes). */
export function generatorLinesOf(propertiesText: string): string[] {
  return propertiesText.split(/\r?\n/u).filter(line => GENERATOR_PROPERTY_KEYS.some(key => line.startsWith(`${key}=`)));
}

/** One `server.properties` value (the text after `key=`), or undefined. */
export function propertyOf(propertiesText: string, key: string): string | undefined {
  return propertiesText.split(/\r?\n/u).find(line => line.startsWith(`${key}=`))?.slice(key.length + 1);
}

interface Chunk { readonly x: number; readonly z: number }

/** Every distinct chunk of the boxes, in box order. */
function chunksOfBoxes(boxes: readonly ChunkBox[]): Chunk[] {
  const seen = new Set<string>();
  return boxes.flatMap(chunksOfBox).filter(({ x, z }) => !seen.has(`${x},${z}`) && seen.add(`${x},${z}`));
}

function chunksOfBox(box: ChunkBox): Chunk[] {
  const chunks: Chunk[] = [];
  for (let z = box.minZ; z <= box.maxZ; z++) {
    for (let x = box.minX; x <= box.maxX; x++) chunks.push({ x, z });
  }
  return chunks;
}

/** Runs of consecutive x on one row: one `forceload add` each. */
function rowRunsOf(batch: readonly Chunk[]): { from: Chunk; to: Chunk }[] {
  const runs: { from: Chunk; to: Chunk }[] = [];
  for (const chunk of batch) {
    const last = runs.at(-1);
    if (last && last.to.z === chunk.z && last.to.x + 1 === chunk.x) last.to = chunk;
    else runs.push({ from: chunk, to: chunk });
  }
  return runs;
}

/** A failure the build reports as its result. */
class BuildFailure extends Error {
  constructor(message: string, readonly bound: boolean) {
    super(message);
  }
}

function blockCoordinate(chunk: number): number {
  return chunk * BLOCKS_PER_CHUNK;
}

function forceloadCommand(verb: "add" | "remove", run: { from: Chunk; to: Chunk }): string {
  return `forceload ${verb} ${blockCoordinate(run.from.x)} ${blockCoordinate(run.from.z)} ${blockCoordinate(run.to.x)} ${blockCoordinate(run.to.z)}`;
}

function floorProbeCommand(chunk: Chunk): string {
  return FLOOR_PROBE.replace("%X", String(blockCoordinate(chunk.x))).replace("%Z", String(blockCoordinate(chunk.z)));
}

/** Milliseconds left of the bound; throws a bound failure when none. */
type BuildClock = { remaining(what: string): number };

function buildClockOf(ports: TemplatePorts, boundMs: number): BuildClock {
  const deadline = ports.now() + boundMs;
  return {
    remaining(what) {
      const left = deadline - ports.now();
      if (left <= 0) throw new BuildFailure(`${what}: the ${boundMs} ms bound ran out`, true);
      return left;
    },
  };
}

/** Forces one batch, waits until every chunk answers its floor probe, then releases it. */
async function loadBatch(server: TemplateServer, batch: readonly Chunk[], ports: TemplatePorts, clock: BuildClock): Promise<void> {
  const runs = rowRunsOf(batch);
  for (const run of runs) {
    const answer = await server.rcon(forceloadCommand("add", run));
    if (!answer.startsWith("Marked ")) throw new BuildFailure(`forceload add refused: ${answer}`, false);
  }
  let waiting = batch;
  while (waiting.length > 0) {
    const unanswered: Chunk[] = [];
    for (const chunk of waiting) {
      if (!/passed/iu.test(await server.rcon(floorProbeCommand(chunk)))) unanswered.push(chunk);
    }
    waiting = unanswered;
    if (waiting.length === 0) break;
    clock.remaining(`${waiting.length} chunk(s) of a batch never loaded`);
    await ports.sleep(PROBE_POLL_MS);
  }
  for (const run of runs) await server.rcon(forceloadCommand("remove", run));
}

/** Saves the world and waits for the server's own "Saved the game" line: the RCON answer comes too late (it times out at 10 s, P0). */
async function saveWorld(server: TemplateServer, clock: BuildClock, log: (line: string) => void): Promise<void> {
  const saved = server.waitForLog(SAVED_LINE, clock.remaining("save"));
  // The command's own answer is not waited for; its rejection only goes to the log.
  server.rcon("save-all flush").catch(error => log(`world template: save-all flush answer: ${String(error)}`));
  try {
    await saved;
  } catch (error) {
    if (error instanceof LogWaitTimeout) throw new BuildFailure(`${error.message} (save-all flush)`, true);
    throw error;
  }
}

/** Copies the world's directories into `tmpDir` and writes `template.json` last. */
async function writeTemplateDir(tmpDir: string, worldDir: string, meta: Record<string, unknown>, ports: TemplatePorts, clock: BuildClock): Promise<void> {
  mkdirSync(tmpDir, { recursive: true });
  for (const name of WORLD_DIRECTORIES) {
    if (existsSync(join(worldDir, name))) await ports.copyDir(join(worldDir, name), join(tmpDir, name), clock.remaining(`copy of ${name}`));
  }
  writeFileSync(join(tmpDir, "template.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

/** Moves a finished tmp directory to its key; a key another daemon finished first wins and the tmp goes. */
function publishTemplate(tmpDir: string, finalDir: string, cacheDir: string, key: string): string {
  try {
    // A `<key>` without template.json is no template (`templateDir`): a crashed copy would make the rename fail for good.
    if (!templateDir(cacheDir, key)) {
      rmSync(finalDir, { recursive: true, force: true });
      renameSync(tmpDir, finalDir);
    }
  } catch (error) {
    if (!templateDir(cacheDir, key)) throw error; // the rename lost a race with another daemon's finished template
  }
  return finalDir;
}

/** Builds the template of `boxes` in a temporary server root of `cacheDir` and stores it under its key; nothing is left behind on any failure. */
export async function buildTemplate(options: BuildOptions, ports: TemplatePorts = realTemplatePorts()): Promise<BuildResult> {
  const { cacheDir, version, boxes, boundMs, log } = options;
  const startedAt = ports.now();
  const clock = buildClockOf(ports, boundMs);
  const buildRoot = join(cacheDir, `build.tmp-${process.pid}`);
  let tmpDir: string | null = null;
  let server: TemplateServer | null = null;
  try {
    rmSync(buildRoot, { recursive: true, force: true });
    mkdirSync(buildRoot, { recursive: true });
    server = await orFail("build server did not start", () => ports.startServer(version, buildRoot, BUILD_SERVER_PROPERTIES));
    const key = templateKey(version, generatorLinesOf(readFileSync(join(buildRoot, "server.properties"), "utf8")), boxes);
    const existing = templateDir(cacheDir, key);
    if (existing) return { ok: true, dir: existing };
    const chunks = chunksOfBoxes(boxes);
    log(`world template ${key}: building ${chunks.length} chunks in ${Math.ceil(chunks.length / FORCELOAD_BATCH_CHUNKS)} batches`);
    for (let first = 0; first < chunks.length; first += FORCELOAD_BATCH_CHUNKS) await loadBatch(server, chunks.slice(first, first + FORCELOAD_BATCH_CHUNKS), ports, clock);
    await saveWorld(server, clock, log);
    await orFail("build server did not stop", () => server!.stop());
    server = null;
    const worldDir = join(buildRoot, "world");
    const saved = savedChunkCount(join(worldDir, "region"));
    if (saved < chunkCount(boxes)) throw new BuildFailure(`only ${saved} of ${chunkCount(boxes)} chunks saved`, false);
    tmpDir = join(cacheDir, `${key}.tmp-${process.pid}`);
    rmSync(tmpDir, { recursive: true, force: true }); // a crashed build of this pid left it
    const meta = { key, version, boxes, chunks: saved, builtAt: new Date().toISOString(), buildMs: Math.round(ports.now() - startedAt) };
    await writeTemplateDir(tmpDir, worldDir, meta, ports, clock);
    const dir = publishTemplate(tmpDir, join(cacheDir, key), cacheDir, key);
    log(`world template ${key} built: ${saved} chunks saved in ${meta.buildMs} ms`);
    return { ok: true, dir };
  } catch (error) {
    const failure = error instanceof BuildFailure ? error : new BuildFailure(error instanceof Error ? error.message : String(error), false);
    log(`world template build failed: ${failure.message}`);
    return { ok: false, reason: failure.message, bound: failure.bound };
  } finally {
    await server?.stop().catch(() => undefined);
    rmSync(buildRoot, { recursive: true, force: true });
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Runs a step of the build; any error it throws becomes a build failure that names the step. */
async function orFail<T>(step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new BuildFailure(`${step}: ${error instanceof Error ? error.message : String(error)}`, false);
  }
}

/** The ports over a Mine Labs flat server; `preferPort` keeps the build server out of a daemon's port block. */
export function realTemplatePorts(options: { readonly preferPort?: number; readonly log?: (line: string) => void } = {}): TemplatePorts {
  return {
    async startServer(version, root, properties) {
      const waiters = new LogLineWaiters();
      const labs = await MinecraftServer.create({
        version, root, preferPort: options.preferPort, worldType: "flat", pauseWhenEmptySeconds: 0, maxHeap: BUILD_SERVER_HEAP, properties,
        log: line => {
          waiters.feed(line);
          if (line.startsWith(SERVER_EXIT_LOG)) waiters.failAll(new Error(line)); // the "Saved the game" line will never come
          options.log?.(line);
        },
      });
      try {
        if (options.preferPort !== undefined && labs.gamePort !== options.preferPort) throw new Error(`ports ${options.preferPort} and ${options.preferPort + 1} are not both free (Mine Labs chose ${labs.gamePort})`);
        await prepareWorldDir(labs.worldDir);
        await labs.start();
      } catch (error) {
        await labs.stop().catch(() => undefined);
        throw error;
      }
      return {
        rcon: async command => {
          if (!labs.rcon) throw new Error("the build server has no RCON connection");
          return labs.rcon.command(command);
        },
        waitForLog: (text, boundMs) => waiters.waitFor(text, boundMs),
        stop: () => labs.stop(),
      };
    },
    async copyDir(from, to, boundMs) {
      mkdirSync(dirname(to), { recursive: true });
      const result = await runBounded("cp", ["-r", from, to], { cwd: dirname(to), boundMs });
      if (result.code !== 0) throw new Error(`cp -r ${from} failed${result.timedOut ? ` (cut at ${boundMs} ms)` : ""}: ${result.stderrTail}`);
    },
    now: () => performance.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  };
}

// The command line lives in world-template-cli.ts; `bun world-template.ts build` runs it.
if (import.meta.main) process.exit(await (await import("./world-template-cli.ts")).main(process.argv.slice(2)));

// Lane servers start from the template world (spec 2026-10-30-scenario-clients-ext4 D10 "Use"): which template a version has, and the copy of its chunks into a server's world.
import { access, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Scenario } from "mine-labs";
import { loadAllScenarios } from "../arena/all-scenarios.ts";
import { templateArea, type ChunkBox } from "../arena/template-area.ts";
import type { ScenarioServerConfig } from "./config.ts";
import { touchLastUsed } from "./mirror-modules.ts";
import type { ServerRequest } from "./pool.ts";
import { runBounded } from "./run-bounded.ts";
import { generatorLinesOf, propertyOf, templateDir, templateKey, WORLD_DIRECTORIES } from "./world-template.ts";

/** The gamerule probe server's key prefix (`daemon.ts` `probeServers`): a shared flat server whose placements wait on it, so it starts without a copy. */
const PROBE_KEY_PREFIX = "probe:";

export interface TemplateUsePorts {
  /** Every scenario of the physical suite: the census the template area is computed from. */
  scenarios(): Promise<readonly Scenario[]>;
  run: typeof runBounded;
  /** A monotonic millisecond clock. */
  now(): number;
  /** The bytes of every file under each directory given; a directory that does not exist counts 0. */
  directoryBytes(directories: readonly string[]): Promise<number>;
}

const BYTES_PER_MB = 1024 * 1024;

const realPorts: TemplateUsePorts = {
  scenarios: async () => (await loadAllScenarios()).map(loaded => loaded.scenario),
  run: runBounded,
  now: () => performance.now(),
  directoryBytes: async directories => (await Promise.all(directories.map(directoryBytes))).reduce((sum, bytes) => sum + bytes, 0),
};

async function directoryBytes(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const sizes = await Promise.all(entries.map(entry => (entry.isDirectory() ? directoryBytes(join(directory, entry.name)) : stat(join(directory, entry.name)).then(info => info.size, () => 0))));
  return sizes.reduce((sum, bytes) => sum + bytes, 0);
}

/** A world holding a template's chunks; the server's stop removes it, since each is 436 MB or more and nothing else deletes a server root's world. */
export interface TemplatedWorld {
  remove(): Promise<void>;
}

/** A version's template as the daemon computes it: the key and the chunk boxes the key was made of. */
interface ResolvedTemplate {
  readonly key: string;
  readonly boxes: readonly ChunkBox[];
}

/** One version's template for the daemon's build: what to build when `present` is false. */
export interface TemplateBuildStatus extends ResolvedTemplate {
  readonly version: string;
  /** A finished template of the key is on disk. */
  readonly present: boolean;
}

/** What a server's own `server.properties` says about a version's flat world: the two inputs of the template key that only a started server states. */
interface FlatWorldFacts {
  readonly viewChunks: number;
  readonly generatorLines: readonly string[];
}

/**
 * The daemon's view of the template worlds on disk. It learns a version's view distance and generator lines from the `server.properties` of the first
 * flat server of that version that starts (the gamerule probe server, normally the first), computes the key the build computes (`world-template-cli.ts`:
 * the same census, area and `templateKey`), and copies the finished template into each lane server's world. Every failure costs the template, never a server.
 */
export class LaneWorldTemplates {
  readonly #facts = new Map<string, FlatWorldFacts>();
  readonly #resolved = new Map<string, Promise<ResolvedTemplate | null>>();
  readonly #said = new Set<string>();
  /** A version's template size in MB (a version's key is computed once and a finished template never changes, so one entry per key). */
  readonly #worldMb = new Map<string, number>();
  readonly #ports: TemplateUsePorts;

  constructor(private readonly options: { readonly config: ScenarioServerConfig; readonly log: (line: string) => void }, ports: Partial<TemplateUsePorts> = {}) {
    this.#ports = { ...realPorts, ...ports };
  }

  /** A started server's `server.properties`; only a flat world's lines are the template's generator (a default world writes `level-type=minecraft:normal`). */
  observe(request: ServerRequest, propertiesText: string): void {
    if (!hasTemplateWorld(request.scenario)) return;
    const version = request.scenario.minecraft.version;
    if (this.#facts.has(version)) return;
    const viewDistance = propertyOf(propertiesText, "view-distance");
    if (viewDistance === undefined || !/^\d+$/u.test(viewDistance)) {
      this.#sayOnce(`view:${version}`, `world template for ${version}: server.properties of ${request.id} holds no usable view-distance ("${viewDistance ?? "absent"}")`);
      return;
    }
    this.#facts.set(version, { viewChunks: Number(viewDistance), generatorLines: generatorLinesOf(propertiesText) });
    // The key resolves now: read the size so `worldMbKnown` answers for the servers the scheduler admits from here on (a failed read costs the size, never a server).
    void this.worldMbFor(version).catch(() => undefined);
  }

  /** Copies the version's template into `worldDir` when the server is a lane server of a flat world and a template of its key exists; null leaves the world empty. `onCopied` is called once after a copy that worked. */
  async prepare(request: ServerRequest, worldDir: string, onCopied?: () => void): Promise<TemplatedWorld | null> {
    const source = await this.#source(request);
    if (source === null) return null;
    const world = await this.#copy(request.id, source.key, source.dir, worldDir);
    if (world !== null) onCopied?.();
    return world;
  }

  /** True exactly when `prepare` of this request would copy a template: the factory asks before it chooses the server's root (a RAM root only helps a copy). */
  async wouldCopy(request: ServerRequest): Promise<boolean> {
    return (await this.#source(request)) !== null;
  }

  /**
   * The size in MB, rounded up, of the files under the version's template (the directories a copy takes): what a copy puts in a server's root. Read from
   * disk once per key when its template exists; 0 while the version has no key or no template (not remembered, so a template built later is measured).
   */
  async worldMbFor(version: string): Promise<number> {
    const resolved = await this.#resolve(version);
    if (resolved === null) return 0;
    const known = this.#worldMb.get(version);
    if (known !== undefined) return known;
    const dir = templateDir(this.options.config.templateDir, resolved.key);
    if (dir === null) return 0;
    const mb = Math.ceil((await this.#ports.directoryBytes(WORLD_DIRECTORIES.map(name => join(dir, name)))) / BYTES_PER_MB);
    this.#worldMb.set(version, mb);
    return mb;
  }

  /**
   * `worldMbFor`'s answer when it was already read, else 0: for the scheduler, which cannot await while it admits. `observe` reads it when the key
   * resolves, so it is 0 only for the servers admitted before the first flat server wrote its properties (they get no copy either) and while no template exists.
   */
  worldMbKnown(version: string): number {
    return this.#worldMb.get(version) ?? 0;
  }

  /** The template a copy for this request comes from, with the log line of why not (said once); the one place that decides, so `wouldCopy` and `prepare` agree. */
  async #source(request: ServerRequest): Promise<{ readonly key: string; readonly dir: string } | null> {
    if (this.options.config.worldTemplate !== 1 || !isLaneServer(request)) return null;
    const version = request.scenario.minecraft.version;
    const resolved = await this.#resolve(version);
    if (resolved === null) {
      this.#sayOnce(`facts:${version}`, `world template for ${version} not known yet: no flat server of that version has written its server.properties (servers start empty)`);
      return null;
    }
    const { key } = resolved;
    const dir = templateDir(this.options.config.templateDir, key);
    if (dir === null) {
      this.#sayOnce(`missing:${key}`, `world template ${key} missing (servers start empty until it is built)`);
      return null;
    }
    return { key, dir };
  }

  /** Every version a flat server has written its properties for, with its key and whether its template is on disk: what the daemon's build looks at. A version whose census failed is left out (the log says why). */
  async buildStatus(): Promise<TemplateBuildStatus[]> {
    const statuses: TemplateBuildStatus[] = [];
    for (const version of this.#facts.keys()) {
      const resolved = await this.#resolve(version);
      if (resolved) statuses.push({ version, ...resolved, present: templateDir(this.options.config.templateDir, resolved.key) !== null });
    }
    return statuses;
  }

  /** The version's key and boxes, computed once from the first flat server's facts; null before that server started or when the census failed. */
  #resolve(version: string): Promise<ResolvedTemplate | null> {
    const facts = this.#facts.get(version);
    if (!facts) return Promise.resolve(null);
    let resolved = this.#resolved.get(version);
    if (!resolved) {
      resolved = this.#computeKey(version, facts);
      this.#resolved.set(version, resolved);
    }
    return resolved;
  }

  async #computeKey(version: string, facts: FlatWorldFacts): Promise<ResolvedTemplate | null> {
    try {
      const boxes = templateBoxesOf(await this.#ports.scenarios(), version, this.options.config.templateLanes, facts.viewChunks);
      return { key: templateKey(version, facts.generatorLines, boxes), boxes };
    } catch (error) {
      this.options.log(`world template for ${version} unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** One `cp -r` child process of the directories the template holds, awaited and bounded; a failed or cut copy leaves the world empty. */
  async #copy(id: string, key: string, dir: string, worldDir: string): Promise<TemplatedWorld | null> {
    const { log, config } = this.options;
    const sources = await directoriesPresent(dir);
    markUsed(dir);
    const startedAt = this.#ports.now();
    let failure: string | null = null;
    try {
      const result = await this.#ports.run("cp", ["-r", ...sources, worldDir], { cwd: worldDir, boundMs: config.templateCopyBoundMs });
      if (result.timedOut) failure = `cut at ${config.templateCopyBoundMs} ms`;
      else if (result.code !== 0) failure = `cp exited ${result.code}: ${result.stderrTail}`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure !== null) {
      await Promise.all(WORLD_DIRECTORIES.map(name => rm(join(worldDir, name), { recursive: true, force: true })));
      log(`world template copy into ${id} failed: ${failure}`);
      return null;
    }
    log(`world template ${key} copied into ${id} in ${Math.round(this.#ports.now() - startedAt)} ms`);
    return { remove: () => rm(worldDir, { recursive: true, force: true }) };
  }

  #sayOnce(what: string, line: string): void {
    if (this.#said.has(what)) return;
    this.#said.add(what);
    this.options.log(line);
  }
}

/** The prune judges a template by its `.last-used` (`world-template-prune.ts`); a store that cannot be written costs the mark, never the copy. */
function markUsed(dir: string): void {
  try {
    touchLastUsed(dir, Date.now());
  } catch {
    // the template is still copied
  }
}

/** The directories of a world that `dir` holds (the build server makes `entities` and `poi` only when it has something to put in them). */
async function directoriesPresent(dir: string): Promise<string[]> {
  const present = await Promise.all(WORLD_DIRECTORIES.map(name => access(join(dir, name)).then(() => true, () => false)));
  return WORLD_DIRECTORIES.filter((_, index) => present[index]).map(name => join(dir, name));
}

/** The chunk boxes a version's template holds: the build (`world-template-cli.ts`) and the daemon's lookup call this one function, so their keys agree. */
export function templateBoxesOf(scenarios: readonly Scenario[], version: string, lanes: number, viewChunks: number): ChunkBox[] {
  return templateArea(scenarios.filter(scenario => scenario.minecraft.version === version), { lanes, viewChunks });
}

/** A shared (lane) server of a flat world that is not the gamerule probe: the only servers a template helps (spec D10, amendment 2026-10-31). */
function isLaneServer(request: ServerRequest): boolean {
  return request.kind === "shared" && !request.key.startsWith(PROBE_KEY_PREFIX) && hasTemplateWorld(request.scenario);
}

/** Only a flat world has a template (a default world's chunks depend on its seed and the player's path): the one rule of `observe`, of the copy and of the scheduler's world reserve. */
export function hasTemplateWorld(scenario: Pick<Scenario, "world">): boolean {
  return scenario.world.type === "flat";
}

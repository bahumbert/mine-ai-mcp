// Lane servers start from the template world (spec 2026-10-30-scenario-clients-ext4 D10 "Use"): which template a version has, and the copy of its chunks into a server's world.
import { access, rm } from "node:fs/promises";
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
}

const realPorts: TemplateUsePorts = {
  scenarios: async () => (await loadAllScenarios()).map(loaded => loaded.scenario),
  run: runBounded,
  now: () => performance.now(),
};

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
  readonly #ports: TemplateUsePorts;

  constructor(private readonly options: { readonly config: ScenarioServerConfig; readonly log: (line: string) => void }, ports: Partial<TemplateUsePorts> = {}) {
    this.#ports = { ...realPorts, ...ports };
  }

  /** A started server's `server.properties`; only a flat world's lines are the template's generator (a default world writes `level-type=minecraft:normal`). */
  observe(request: ServerRequest, propertiesText: string): void {
    if (request.scenario.world.type !== "flat") return;
    const version = request.scenario.minecraft.version;
    if (this.#facts.has(version)) return;
    const viewDistance = propertyOf(propertiesText, "view-distance");
    if (viewDistance === undefined || !/^\d+$/u.test(viewDistance)) {
      this.#sayOnce(`view:${version}`, `world template for ${version}: server.properties of ${request.id} holds no usable view-distance ("${viewDistance ?? "absent"}")`);
      return;
    }
    this.#facts.set(version, { viewChunks: Number(viewDistance), generatorLines: generatorLinesOf(propertiesText) });
  }

  /** Copies the version's template into `worldDir` when the server is a lane server of a flat world and a template of its key exists; null leaves the world empty. */
  async prepare(request: ServerRequest, worldDir: string): Promise<TemplatedWorld | null> {
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
    return this.#copy(request.id, key, dir, worldDir);
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
  return request.kind === "shared" && !request.key.startsWith(PROBE_KEY_PREFIX) && request.scenario.world.type === "flat";
}

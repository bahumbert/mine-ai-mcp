// The real server factory: a Mine Labs server per request, in its own port pair, its java pid recorded for the leftover cleanup.
import { readFile, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MinecraftServer, prepareWorldDir } from "mine-labs";
import type { ScenarioServerConfig } from "./config.ts";
import { PortPairs } from "./port-block.ts";
import type { ServerFactory, ServerRequest } from "./pool.ts";
import type { ScenarioServer } from "./scenario-server.ts";
import { findJavaPid, procFs, type PidFile } from "./server-pids.ts";
import { makeRamRoot, type RamRoot } from "./world-ram-root.ts";
import type { LaneWorldTemplates, TemplatedWorld } from "./world-template-use.ts";

/** What the factory asks of the template copies: the copy itself, its facts, and the two questions that decide a RAM root (`wouldCopy`, `worldMbFor`). */
export type LaneWorlds = Pick<LaneWorldTemplates, "prepare" | "observe" | "wouldCopy" | "worldMbFor">;

/** The part of a Mine Labs server the factory uses; the real class fits it, a test's fake answers as Mine Labs does (`worldDir` is `<root>/world`). */
export interface LabsHandle {
  readonly worldDir: string;
  readonly gamePort: number;
  readonly rcon?: { command(command: string): Promise<string> };
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Mine Labs and the file system as the factory calls them; the defaults are the real ones. */
export interface LabsPorts {
  create(options: Parameters<typeof MinecraftServer.create>[0]): Promise<LabsHandle>;
  prepareWorldDir(worldDir: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  /** The pid of the java process running in `root`, or null. */
  findPid(root: string): number | null;
}

const realLabs: LabsPorts = {
  create: options => MinecraftServer.create(options),
  prepareWorldDir,
  symlink: (target, path) => symlink(target, path, "dir"),
  findPid: root => findJavaPid(root, procFs),
};

/** What Mine Labs logs when the java process outlived its kill and it let go of the handles (`server.ts` `stop`). */
const ABANDONED_MARK = "abandoning attached handles";

const labsServers = new WeakMap<ScenarioServer, LabsHandle>();

/** The Mine Labs server behind a scenario server, for the one place that runs a trial on it. */
export function labsServerOf(server: ScenarioServer): MinecraftServer {
  const labs = labsServers.get(server);
  if (!(labs instanceof MinecraftServer)) throw new Error(`server ${server.id} was not made by the Mine Labs factory`);
  return labs;
}

export class LabsServerFactory implements ServerFactory {
  /** Makes each RAM root's name unique within this daemon: a server id is reused by nothing today, but a root outlives a failed stop. */
  #ramRoots = 0;

  constructor(
    private readonly options: {
      readonly serverRoot: string;
      readonly ports: PortPairs;
      readonly pidFile: PidFile;
      readonly config: ScenarioServerConfig;
      readonly log: (message: string) => void;
      /** Copies the template world into each lane server before it starts; none: every server starts with an empty world, as before. */
      readonly templates?: LaneWorlds;
      /** The daemon's directory of RAM roots (spec 2026-11-15-scenario-disk-stalls D1); none: every root is on disk, as before. */
      readonly ramWorlds?: { readonly dir: string };
      readonly labs?: LabsPorts;
    },
  ) {}

  async create(request: ServerRequest): Promise<ScenarioServer> {
    const { serverRoot, ports, pidFile, config, log } = this.options;
    const labsPorts = this.options.labs ?? realLabs;
    const port = ports.lease();
    const ram = await this.#ramRoot(request, labsPorts);
    // The ledger holds the template's size for a world headed to RAM (`ServerRequest.worldMb`) until the copy ends; a world that is not going to RAM releases it now.
    const worldDone = () => request.onWorldCopied?.();
    if (!ram) worldDone();
    const root = ram?.root ?? join(serverRoot, request.id);
    const world = request.scenario.world;
    let abandoned = false;
    const createOptions: Parameters<typeof MinecraftServer.create>[0] = {
      version: request.scenario.minecraft.version, root, preferPort: port,
      log: message => {
        if (message.includes(ABANDONED_MARK)) abandoned = true;
        log(`[${request.id}] ${message}`);
      },
      worldType: world.type, seed: world.seed, structures: world.structures,
      maxPlayers: request.kind === "shared" ? config.maxPlayers : undefined,
      // 1.21.4 pauses a server empty for 60 s (32 times in step 6b, 2026-10-23): the first trial after a pause differs from the others'.
      pauseWhenEmptySeconds: 0,
      enableCommandBlocks: request.kind === "shared", maxHeap: `${request.heapMb}M`,
    };
    let labs: LabsHandle | undefined;
    let templated: TemplatedWorld | null = null;
    try {
      labs = await labsPorts.create(createOptions);
      if (!ports.contains(labs.gamePort)) {
        throw new Error(`Mine Labs moved server ${request.id} to port ${labs.gamePort}, outside this daemon's block`);
      }
      await labsPorts.prepareWorldDir(labs.worldDir);
      templated = await this.options.templates?.prepare(request, labs.worldDir, worldDone) ?? null;
      // No copy was made (a failed `cp`, none asked for): nothing is left to wait for.
      if (!templated) worldDone();
      await labs.start();
      // What the template key needs of this server; a file that cannot be read costs the template, never the server.
      await readFile(join(root, "server.properties"), "utf8").then(text => this.options.templates?.observe(request, text)).catch(() => undefined);
    } catch (error) {
      worldDone();
      await labs?.stop().catch(() => undefined);
      await templated?.remove().catch(() => undefined);
      await ram?.remove().catch(() => undefined);
      ports.release(port);
      throw error;
    }
    const pid = labsPorts.findPid(dirname(labs.worldDir));
    if (pid !== null) await pidFile.add({ pid, root: dirname(labs.worldDir) });
    const started = labs;
    const server: ScenarioServer = {
      id: request.id, kind: request.kind, gamePort: started.gamePort, heapMb: request.heapMb,
      command: async command => {
        if (!started.rcon) throw new Error(`server ${request.id} has no RCON connection`);
        return started.rcon.command(command);
      },
      javaPid: () => pid,
      stop: async () => {
        try {
          await started.stop();
        } finally {
          // The RAM is freed whatever the stop did; the logs it linked to stay on disk.
          await ram?.remove().catch((error: unknown) => log(`world in RAM: removing the root of ${request.id} failed: ${error instanceof Error ? error.message : String(error)}`));
        }
        // A world that cannot be removed (9P answers ENOTEMPTY or EBUSY now and then) must not keep the port pair and the pid entry.
        await templated?.remove().catch((error: unknown) => log(`world template: removing the world of ${request.id} failed: ${error instanceof Error ? error.message : String(error)}`));
        ports.release(port);
        // A java process Mine Labs let go of keeps its entry: the next daemon's leftover kill ends it (and the RAM files it holds open).
        if (pid !== null && !abandoned) await pidFile.remove(pid);
      },
    };
    labsServers.set(server, started);
    return server;
  }

  /** The RAM root of a lane server that is about to get a template copy, or null (a disk root): RAM off, no copy for this server, no room, or a step that failed. */
  async #ramRoot(request: ServerRequest, labs: LabsPorts): Promise<RamRoot | null> {
    const { ramWorlds, templates, serverRoot, log } = this.options;
    if (!ramWorlds || !templates) return null;
    try {
      if (!await templates.wouldCopy(request)) return null;
      const needMb = await templates.worldMbFor(request.scenario.minecraft.version);
      return await makeRamRoot({
        ramDir: ramWorlds.dir, name: `${request.id}-${++this.#ramRoots}`, id: request.id, diskLogs: join(serverRoot, request.id, "logs"), needMb, symlink: labs.symlink, log,
      });
    } catch (error) {
      log(`world in RAM failed for ${request.id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}

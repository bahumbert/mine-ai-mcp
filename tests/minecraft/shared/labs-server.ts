// The real server factory: a Mine Labs server per request, in its own port pair, its java pid recorded for the leftover cleanup.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MinecraftServer, prepareWorldDir } from "mine-labs";
import type { ScenarioServerConfig } from "./config.ts";
import { PortPairs } from "./port-block.ts";
import type { ServerFactory, ServerRequest } from "./pool.ts";
import type { ScenarioServer } from "./scenario-server.ts";
import { findJavaPid, procFs, type PidFile } from "./server-pids.ts";
import type { LaneWorldTemplates, TemplatedWorld } from "./world-template-use.ts";

const labsServers = new WeakMap<ScenarioServer, MinecraftServer>();

/** The Mine Labs server behind a scenario server, for the one place that runs a trial on it. */
export function labsServerOf(server: ScenarioServer): MinecraftServer {
  const labs = labsServers.get(server);
  if (!labs) throw new Error(`server ${server.id} was not made by the Mine Labs factory`);
  return labs;
}

export class LabsServerFactory implements ServerFactory {
  constructor(
    private readonly options: {
      readonly serverRoot: string;
      readonly ports: PortPairs;
      readonly pidFile: PidFile;
      readonly config: ScenarioServerConfig;
      readonly log: (message: string) => void;
      /** Copies the template world into each lane server before it starts; none: every server starts with an empty world, as before. */
      readonly templates?: LaneWorldTemplates;
    },
  ) {}

  async create(request: ServerRequest): Promise<ScenarioServer> {
    const { serverRoot, ports, pidFile, config, log } = this.options;
    const root = join(serverRoot, request.id);
    const port = ports.lease();
    const world = request.scenario.world;
    const createOptions: Parameters<typeof MinecraftServer.create>[0] = {
      version: request.scenario.minecraft.version, root, log: message => log(`[${request.id}] ${message}`), preferPort: port,
      worldType: world.type, seed: world.seed, structures: world.structures,
      maxPlayers: request.kind === "shared" ? config.maxPlayers : undefined,
      // 1.21.4 pauses a server empty for 60 s (32 times in step 6b, 2026-10-23): the first trial after a pause differs from the others'.
      pauseWhenEmptySeconds: 0,
      enableCommandBlocks: request.kind === "shared", maxHeap: `${request.heapMb}M`,
    };
    let labs: MinecraftServer | undefined;
    let templated: TemplatedWorld | null = null;
    try {
      labs = await MinecraftServer.create(createOptions);
      if (!ports.contains(labs.gamePort)) {
        throw new Error(`Mine Labs moved server ${request.id} to port ${labs.gamePort}, outside this daemon's block`);
      }
      await prepareWorldDir(labs.worldDir);
      templated = await this.options.templates?.prepare(request, labs.worldDir) ?? null;
      await labs.start();
      // What the template key needs of this server; a file that cannot be read costs the template, never the server.
      await readFile(join(root, "server.properties"), "utf8").then(text => this.options.templates?.observe(request, text)).catch(() => undefined);
    } catch (error) {
      await labs?.stop().catch(() => undefined);
      await templated?.remove().catch(() => undefined);
      ports.release(port);
      throw error;
    }
    const pid = findJavaPid(dirname(labs.worldDir), procFs);
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
        await started.stop();
        // A world that cannot be removed (9P answers ENOTEMPTY or EBUSY now and then) must not keep the port pair and the pid entry.
        await templated?.remove().catch((error: unknown) => log(`world template: removing the world of ${request.id} failed: ${error instanceof Error ? error.message : String(error)}`));
        ports.release(port);
        if (pid !== null) await pidFile.remove(pid);
      },
    };
    labsServers.set(server, started);
    return server;
  }
}

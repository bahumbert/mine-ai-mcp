// A `TemplateBuilds` over fakes (no server, no census): the scheduler and daemon tests drive its builds by hand.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenarioServerConfig, type ScenarioServerConfig } from "./config.ts";
import { PortPairs } from "./port-block.ts";
import { TemplateBuilds } from "./scheduler-template-build.ts";
import type { BuildOptions, BuildResult, TemplatePorts, TemplateServer } from "./world-template.ts";
import type { TemplateBuildStatus } from "./world-template-use.ts";

export const BUILD_VERSION = "1.21.4";
export const BUILD_KEY = "key-1-21-4";
export const BUILD_JAVA_PID = 4_242;

/** One call of the fake `buildTemplate`: the test ends it with `finish`. */
export interface BuildCall {
  readonly options: BuildOptions;
  readonly ports: TemplatePorts;
  finish(result: BuildResult): void;
  /** Starts the build's server through the ports the builds gave, as `buildTemplate` does. */
  startServer(): Promise<TemplateServer>;
}

export class FakeBuildServer implements TemplateServer {
  stopped = false;
  readonly #stopWaiters: (() => void)[] = [];
  async rcon(): Promise<string> { return ""; }
  async waitForLog(): Promise<void> {}
  async stop(): Promise<void> {
    this.stopped = true;
    for (const resolve of this.#stopWaiters.splice(0)) resolve();
  }
  /** Resolves when the server is stopped: what a real build's RCON call would notice as an error. */
  whenStopped(): Promise<void> {
    return this.stopped ? Promise.resolve() : new Promise(resolve => this.#stopWaiters.push(resolve));
  }
}

export class TemplateBuildRig {
  readonly lines: string[] = [];
  /** The pid file's content: `{ pid, root }` per registered server. */
  readonly pidFile: { pid: number; root: string }[] = [];
  readonly calls: BuildCall[] = [];
  readonly servers: FakeBuildServer[] = [];
  readonly leased: number[] = [];
  readonly released: number[] = [];
  readonly preferPorts: number[] = [];
  readonly status: { -readonly [K in keyof TemplateBuildStatus]: TemplateBuildStatus[K] }[] = [{ version: BUILD_VERSION, key: BUILD_KEY, boxes: [], present: false }];
  /** The template store of this rig's config: tests put templates in it. */
  readonly storeDir = mkdtempSync(join(tmpdir(), "template-build-rig-"));
  readonly config: ScenarioServerConfig;
  readonly builds: TemplateBuilds;
  clock = 1_000;
  /** A hook before `buildStatus` answers (a test delays it to let the world change). */
  statusGate: Promise<void> | null = null;
  /** While set, the fake `buildTemplate` rejects with it (the real one catches everything; this is a defect in it). */
  buildError: Error | null = null;
  /** While set, adding to the pid file rejects with it. */
  pidFileError: Error | null = null;
  /** While set, leasing a port pair throws it (every pair in use). */
  leaseError: Error | null = null;
  /** What `findJavaPid` answers for the build server's root. */
  javaPid: number | null = BUILD_JAVA_PID;

  constructor(env: Record<string, string> = {}) {
    this.config = { ...loadScenarioServerConfig(env), templateDir: this.storeDir };
    const ports = new PortPairs({ first: 25_600, last: 25_619 });
    this.builds = new TemplateBuilds({
      config: this.config, log: line => this.lines.push(line), now: () => this.clock,
      templates: { buildStatus: async () => { await this.statusGate; return this.status.map(entry => ({ ...entry })); } },
      ports: { lease: () => { if (this.leaseError) throw this.leaseError; const port = ports.lease(); this.leased.push(port); return port; }, release: port => { ports.release(port); this.released.push(port); } },
      pidFile: {
        add: async server => {
          if (this.pidFileError) throw this.pidFileError;
          this.pidFile.push(server);
        },
        remove: async pid => { this.pidFile.splice(0, this.pidFile.length, ...this.pidFile.filter(server => server.pid !== pid)); },
      },
      findJavaPid: () => this.javaPid,
      templatePorts: preferPort => {
        this.preferPorts.push(preferPort);
        return {
          startServer: async () => { const server = new FakeBuildServer(); this.servers.push(server); return server; },
          copyDir: async () => {}, now: () => this.clock, sleep: async () => {},
        };
      },
      build: (options, ports) => new Promise((resolve, reject) => {
        if (this.buildError) { reject(this.buildError); return; }
        const call: BuildCall = {
          options, ports,
          finish: result => {
            // A finished template is on disk: the next look at the store finds it.
            if (result.ok) for (const entry of this.status) if (entry.version === options.version) entry.present = true;
            resolve(result);
          },
          startServer: () => ports.startServer(options.version, join(this.storeDir, "build.tmp-1"), {}),
        };
        this.calls.push(call);
      }),
    });
  }

  /** `startIfDue` with a machine that has room, and idle as the test says. */
  async startIfDue(options: { idle?: () => boolean; ledgerMb?: number } = {}): Promise<void> {
    await this.builds.startIfDue({ idle: options.idle ?? (() => true), ledgerMb: options.ledgerMb ?? 20_000 });
  }

  /** Lets promise callbacks run. */
  async settle(): Promise<void> {
    for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
  }

  /** Ends the builds a test left running (a real build ends when its server stops), then stops the builds. */
  async shutDown(): Promise<void> {
    for (const call of this.calls) call.finish({ ok: false, reason: "the test is over", bound: false });
    await this.builds.stop();
  }

  dispose(): void {
    rmSync(this.storeDir, { recursive: true, force: true });
  }
}

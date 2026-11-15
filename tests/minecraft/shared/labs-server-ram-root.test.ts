// A templated lane server's root lives in RAM (spec 2026-11-15-scenario-disk-stalls D1, 3.1): the factory's choice of root, its logs linked to disk, and the removal at every exit.
// Mine Labs is replaced by a fake that answers as it does (`server.ts` of mine-labs): `worldDir` is `<root>/world`, `start` and `stop` resolve, the game port is the one it was given.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenarioServerConfig } from "./config.ts";
import { LabsServerFactory, type LabsHandle, type LabsPorts, type LaneWorlds } from "./labs-server.ts";
import { PortPairs } from "./port-block.ts";
import type { ServerRequest } from "./pool.ts";
import { fixtureScenario } from "./scenario-fixture.ts";
import { PidFile } from "./server-pids.ts";

/** The line Mine Labs logs when the java process outlived its kill (`server.ts` `stop`). */
const ABANDON_LINE = "[server] process remained active after 5000ms; abandoning attached handles";
const JAVA_PID = 4_242;
const TEMPLATE_FILE_BYTES = 1024 * 1024;

/** What the next fake server does; read when it is created. */
interface Behaviour { stopThrows?: boolean; startThrows?: boolean; abandons?: boolean }

interface Rig {
  readonly serverRoot: string;
  readonly ramDir: string;
  readonly lines: string[];
  readonly ports: PortPairs;
  readonly pidFile: PidFile;
  /** The `root` of each `create` call of the fake Mine Labs, in order. */
  readonly roots: string[];
  next: Behaviour;
  factory(overrides?: { ram?: boolean; wouldCopy?: boolean; worldMb?: number; labs?: Partial<LabsPorts> }): LabsServerFactory;
}

function request(id = "s1", overrides: Partial<ServerRequest> = {}): ServerRequest {
  return { id, kind: "shared", key: "k1", heapMb: 3_072, setup: [], scenario: fixtureScenario(10), ...overrides };
}

async function withRig(body: (rig: Rig) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "labs-ram-root-"));
  const rig: Rig = {
    serverRoot: join(dir, "disk", "servers"), ramDir: join(dir, "ram", "mine-ai-worlds-test"), lines: [], roots: [], next: {},
    ports: new PortPairs({ first: 25_400, last: 25_559 }), pidFile: new PidFile(join(dir, "daemon.pids")),
    factory(overrides = {}) {
      const templates: LaneWorlds = {
        wouldCopy: async () => overrides.wouldCopy ?? true,
        worldMbFor: async () => overrides.worldMb ?? 5,
        observe: () => {},
        // What a copy does: the template's directories land in the world; the server's stop removes the world.
        prepare: async (_request, worldDir) => {
          mkdirSync(join(worldDir, "region"), { recursive: true });
          writeFileSync(join(worldDir, "region", "r.0.0.mca"), Buffer.alloc(TEMPLATE_FILE_BYTES));
          return { remove: async () => rmSync(worldDir, { recursive: true, force: true }) };
        },
      };
      const labs: LabsPorts = {
        create: async (options): Promise<LabsHandle> => {
          rig.roots.push(options.root);
          mkdirSync(options.root, { recursive: true });
          const mode = rig.next;
          rig.next = {};
          return {
            worldDir: join(options.root, "world"), gamePort: options.preferPort!,
            start: async () => { if (mode.startThrows) throw new Error("server did not start"); },
            stop: async () => {
              if (mode.abandons) options.log(ABANDON_LINE);
              if (mode.stopThrows) throw new Error("stop exploded");
            },
          };
        },
        prepareWorldDir: async worldDir => { rmSync(worldDir, { recursive: true, force: true }); mkdirSync(worldDir, { recursive: true }); },
        symlink: async (target, path) => symlinkSync(target, path, "dir"),
        findPid: () => JAVA_PID,
        ...overrides.labs,
      };
      return new LabsServerFactory({
        serverRoot: rig.serverRoot, ports: rig.ports, pidFile: rig.pidFile, config: loadScenarioServerConfig({}), log: line => rig.lines.push(line), templates,
        ramWorlds: overrides.ram === false ? undefined : { dir: rig.ramDir }, labs,
      });
    },
  };
  try {
    await body(rig);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a templated lane server's root is a directory of the RAM dir, its logs a link to the disk root's logs, and its world holds the copy", async () => {
  await withRig(async rig => {
    const server = await rig.factory().create(request());
    const root = join(rig.ramDir, "s1-1");
    assert.deepEqual(rig.roots, [root]);
    assert.equal(lstatSync(join(root, "logs")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(root, "logs")), join(rig.serverRoot, "s1", "logs"));
    assert.ok(existsSync(join(rig.serverRoot, "s1", "logs")), "the disk logs directory exists before the server starts, so the link is not dangling");
    assert.equal(statSync(join(root, "world", "region", "r.0.0.mca")).size, TEMPLATE_FILE_BYTES, "the copy went into the RAM root");
    assert.deepEqual((await rig.pidFile.read()).map(entry => entry.root), [root], "the pid entry names the RAM root: the leftover kill matches the java process by it");
    await server.stop();
  });
});

for (const [name, behaviour] of [["clean", {}], ["a stop that throws", { stopThrows: true }], ["Mine Labs abandoning the java process", { abandons: true }]] as const satisfies readonly (readonly [string, Behaviour])[]) {
  test(`stop with ${name}: the RAM root is removed, the logs stay on disk, and the pid entry and port pair go as each case says`, async () => {
    await withRig(async rig => {
      rig.next = behaviour;
      const server = await rig.factory().create(request());
      writeFileSync(join(rig.serverRoot, "s1", "logs", "latest.log"), "a line\n");
      if ("stopThrows" in behaviour) await assert.rejects(server.stop(), /stop exploded/u, "the error reaches the caller");
      else await server.stop();
      assert.equal(existsSync(join(rig.ramDir, "s1-1")), false, "the root is removed whatever the stop did");
      assert.equal(existsSync(join(rig.serverRoot, "s1", "logs", "latest.log")), true, "removing the link never reaches the disk logs it points at");
      const entries = await rig.pidFile.read();
      if ("abandons" in behaviour) {
        // Mine Labs let go of a java process still running: its entry stays, naming a root that no longer exists, and the next daemon's leftover kill matches it by `<root> (deleted)` (server-pids.test.ts).
        assert.deepEqual(entries, [{ pid: JAVA_PID, root: join(rig.ramDir, "s1-1") }]);
      } else if ("stopThrows" in behaviour) {
        assert.equal(entries.length, 1, "a stop that threw skips the rest of the cleanup (as before this task): the entry is the way back to the process");
      } else {
        assert.deepEqual(entries, []);
        assert.equal(rig.ports.lease(), 25_400, "the port pair is free again");
      }
    });
  });
}

test("a start that fails removes the RAM root, frees the port pair and throws the start's error", async () => {
  await withRig(async rig => {
    rig.next = { startThrows: true };
    await assert.rejects(rig.factory().create(request()), /server did not start/u);
    assert.equal(existsSync(join(rig.ramDir, "s1-1")), false);
    assert.equal(rig.ports.lease(), 25_400);
  });
});

test("two servers with the same id never share a root: a root of the first is not the second's, and each stop removes its own", async () => {
  await withRig(async rig => {
    const factory = rig.factory();
    const first = await factory.create(request("s1"));
    const second = await factory.create(request("s1"));
    const [firstRoot, secondRoot] = rig.roots;
    assert.notEqual(firstRoot, secondRoot);
    await first.stop();
    assert.deepEqual([existsSync(firstRoot!), existsSync(secondRoot!)], [false, true]);
    await second.stop();
    assert.equal(existsSync(secondRoot!), false);
  });
});

test("less room than the template needs: a disk root, and the log says how much was free and needed", async () => {
  await withRig(async rig => {
    mkdirSync(rig.ramDir, { recursive: true });
    await rig.factory({ worldMb: 1_000_000_000 }).create(request());
    assert.deepEqual(rig.roots, [join(rig.serverRoot, "s1")]);
    assert.match(rig.lines.join("\n"), /world in RAM skipped for s1: \d+ MB free in .*mine-ai-worlds-test, 1000000000 MB needed/u);
    assert.deepEqual((await rig.pidFile.read()).map(entry => entry.root), [join(rig.serverRoot, "s1")]);
  });
});

test("a RAM step that fails (the link is refused) leaves no RAM root, starts on the disk root and says why", async () => {
  await withRig(async rig => {
    const refuse = async (): Promise<void> => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
    await rig.factory({ labs: { symlink: refuse } }).create(request());
    assert.deepEqual(rig.roots, [join(rig.serverRoot, "s1")]);
    assert.equal(existsSync(join(rig.ramDir, "s1-1")), false);
    assert.match(rig.lines.join("\n"), /world in RAM failed for s1: EPERM/u);
  });
});

test("RAM off, a server that gets no copy, and a daemon with no RAM dir: a disk root as before, no RAM dir made, nothing said", async () => {
  for (const overrides of [{ ram: false }, { wouldCopy: false }] as const) {
    await withRig(async rig => {
      await rig.factory(overrides).create(request());
      assert.deepEqual(rig.roots, [join(rig.serverRoot, "s1")]);
      assert.equal(existsSync(rig.ramDir), false);
      assert.deepEqual(rig.lines.filter(line => line.includes("in RAM")), []);
    });
  }
});

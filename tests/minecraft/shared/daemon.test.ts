import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunResult } from "mine-labs";
import { ClientsAhead } from "./client-ahead.ts";
import { loadScenarioServerConfig } from "./config.ts";
import { daemonListens, exchange } from "./daemon-client.ts";
import { createDaemonMirror, startDaemon, type Daemon, type DaemonMirror } from "./daemon.ts";
import { FakeFactory } from "./fake-servers.ts";
import { modulesHash } from "./mirror-modules.ts";
import { rootSlug } from "./source-root.ts";
import type { DaemonMessage } from "./protocol.ts";
import { ScriptedClients } from "./scripted-clients.ts";
import { BUILD_KEY, TemplateBuildRig } from "./template-build-rig.ts";
import type { TemplateBuilds } from "./scheduler-template-build.ts";
import type { TrialRunner } from "./trial.ts";
// scheduler-trial.ts reaches this test at depth 3, past IMPORTER_DEPTH 2; the others are listed so each selects it by name (2026-11-15).
// check-reads: tests/minecraft/shared/protocol.ts, tests/minecraft/shared/submission-handler.ts, tests/minecraft/shared/scheduler-types.ts, tests/minecraft/shared/scheduler-trial.ts, tests/minecraft/shared/scheduler.ts, tests/minecraft/shared/result-class.ts, tests/minecraft/shared/trial.ts

const ONE_FILE = fileURLToPath(new URL("../contract/scenarios/air-supply-under-water.yaml", import.meta.url));

const passing: TrialRunner = async input => {
  await input.onPrepared();
  input.deferReset(async () => {});
  return { scenario: input.scenario.name ?? "x", outcome: "pass", elapsedMs: 3, goal: { state: "passed", detail: "ok" }, goalText: "" } satisfies RunResult;
};

const probeAnswers = (factory: FakeFactory): void => {
  factory.onCreate = server => { server.defaultReply = command => (command.startsWith("gamerule ") ? `Gamerule ${command.slice(9)} is currently set to: true` : ""); };
};

async function withDaemon(
  run: (context: { daemon: Daemon; socketPath: string; factory: FakeFactory; dir: string; logs: string[] }) => Promise<void>,
  overrides: { env?: Record<string, string>; runTrial?: TrialRunner; mirror?: DaemonMirror; templateBuilds?: TemplateBuilds } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "daemon-"));
  const socketPath = join(dir, "d.sock");
  const factory = new FakeFactory();
  const logs: string[] = [];
  probeAnswers(factory);
  const config = loadScenarioServerConfig({ MINE_AI_SCENARIO_SAMPLE_EVERY_MS: "20", MINE_AI_SCENARIO_SOCKET_PATH: socketPath, ...overrides.env });
  const daemon = await startDaemon({
    socketPath, config, stateDir: join(dir, "state"), portBlock: { first: 25_400, last: 25_559 }, log: line => logs.push(line),
    factory, runTrial: overrides.runTrial ?? passing, mirror: overrides.mirror, templateBuilds: overrides.templateBuilds,
    machine: { read: async () => ({ cpuBusy: 0.1, memAvailableMb: 20_000, threads: 24 }) }, residentMbOf: async () => 900,
    runIo: { open: async () => ({ log: () => {}, close: async () => {} }), writeResult: async () => {} },
  });
  try {
    await run({ daemon, socketPath, factory, dir, logs });
  } finally {
    await daemon.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

async function submitAndCollect(socketPath: string, paths: string[], onMessage: (message: DaemonMessage) => void = () => {}): Promise<DaemonMessage[]> {
  const messages: DaemonMessage[] = [];
  const session = await exchange(socketPath, { type: "submit", paths, out: "/tmp/daemon-test-out", repeat: 1, lanes: null, lock: false, env: {} }, message => { messages.push(message); onMessage(message); });
  await session.closed;
  return messages;
}

test("a submit over the socket streams a result and a done, and the daemon keeps its server for the next one", async () => {
  await withDaemon(async ({ socketPath, factory }) => {
    const messages = await submitAndCollect(socketPath, [ONE_FILE]);
    const result = messages.find(message => message.type === "result");
    assert.equal(result?.type === "result" ? result.outcome : "", "pass");
    assert.equal(messages.at(-1)?.type, "done");
    await submitAndCollect(socketPath, [ONE_FILE]);
    assert.equal(factory.created.filter(server => server.kind === "shared").length, 2, "one probe for the gamerule defaults and one for the key, reused by the second submit");
  });
});

test("a featured socket submission runs a canary before its batch and sends no internal canary result", async () => {
  let calls = 0;
  await withDaemon(async ({ socketPath, dir }) => {
    const messages: DaemonMessage[] = [];
    const session = await exchange(socketPath, { type: "submit", paths: [ONE_FILE], out: dir, repeat: 2, lanes: null, lock: false,
      env: { MINE_AI_SUBMIT_FEATURES: "classes,canary", MINE_AI_SUBMIT_CANARY: ONE_FILE } }, message => messages.push(message));
    await session.closed;
    assert.equal(calls, 3);
    assert.equal(messages.filter(message => message.type === "result").length, 2);
    assert.ok(messages.some(message => message.type === "info" && message.text.startsWith("bench canary passed in")));
    assert.deepEqual(messages.at(-1), { type: "done", runs: 2, passed: 2, failed: 0, cancelled: 0, infra: 0 });
  }, { runTrial: async input => { calls++; return passing(input); } });
});

test("a second daemon on a live socket refuses to start", async () => {
  await withDaemon(async ({ socketPath }) => {
    const second = startDaemon({
      socketPath, config: loadScenarioServerConfig({}), stateDir: "/tmp/never", portBlock: { first: 25_400, last: 25_559 }, log: () => {},
      factory: new FakeFactory(), runTrial: passing, machine: { read: async () => ({ cpuBusy: 0, memAvailableMb: 1, threads: 1 }) },
      residentMbOf: async () => 0,
    });
    await assert.rejects(second, /another daemon/u);
  });
});

test("a stale socket file with nothing listening is replaced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "daemon-stale-"));
  const socketPath = join(dir, "d.sock");
  try {
    await writeFile(socketPath, "");
    const daemon = await startDaemon({
      socketPath, config: loadScenarioServerConfig({}), stateDir: join(dir, "state"), portBlock: { first: 25_400, last: 25_559 }, log: () => {},
      factory: new FakeFactory(), runTrial: passing, machine: { read: async () => ({ cpuBusy: 0, memAvailableMb: 20_000, threads: 1 }) },
      residentMbOf: async () => 0,
    });
    assert.equal(await daemonListens(socketPath), true);
    await daemon.stop();
    assert.equal(await daemonListens(socketPath), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a message the daemon cannot read gets an error and the connection closes", async () => {
  await withDaemon(async ({ socketPath }) => {
    const messages: DaemonMessage[] = [];
    // @ts-expect-error a request type that does not exist, to see the refusal
    const session = await exchange(socketPath, { type: "reboot" }, message => messages.push(message));
    await session.closed;
    assert.equal(messages[0]?.type, "error");
  });
});

test("the submitter leaving mid-run cancels its trials and the daemon keeps serving", async () => {
  let aborted = false;
  let started = false;
  const waits: TrialRunner = async input => {
    await input.onPrepared();
    input.deferReset(async () => {});
    started = true;
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    return { scenario: "x", outcome: "cancelled", elapsedMs: 1, goal: { state: "pending", detail: "cancelled" }, goalText: "" };
  };
  await withDaemon(async ({ socketPath }) => {
    const session = await exchange(socketPath, { type: "submit", paths: [ONE_FILE], out: "/tmp/x", repeat: 1, lanes: null, lock: false, env: {} }, () => {});
    while (!started) await new Promise(resolve => setTimeout(resolve, 10));
    session.close();
    while (!aborted) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(aborted, true);
    assert.equal(await daemonListens(socketPath), true);
  }, { runTrial: waits });
});

test("stop with nothing running stops the daemon and removes the socket", async () => {
  await withDaemon(async ({ daemon, socketPath }) => {
    const messages: DaemonMessage[] = [];
    const session = await exchange(socketPath, { type: "stop" }, message => messages.push(message));
    await session.closed;
    await daemon.stopped;
    assert.equal(messages[0]?.type, "stopping");
    assert.equal(await daemonListens(socketPath), false);
  });
});

test("the daemon exits by itself after DAEMON_IDLE with nothing queued", async () => {
  await withDaemon(async ({ daemon }) => {
    await Promise.race([daemon.stopped, new Promise((_, reject) => setTimeout(() => reject(new Error("did not exit when idle")), 3_000))]);
  }, { env: { MINE_AI_SCENARIO_DAEMON_IDLE_MS: "150" } });
});

test("stopping the daemon stops every server it started, the probe included", async () => {
  await withDaemon(async ({ daemon, socketPath, factory }) => {
    await submitAndCollect(socketPath, [ONE_FILE]);
    assert.ok(factory.created.length >= 1);
    await daemon.stop();
    assert.ok(factory.created.every(server => server.stopped), "no java server left behind");
  });
});

test("a --lock submit over the socket runs on a server of its own that the daemon stops after the batch, the probe and plain servers staying", async () => {
  await withDaemon(async ({ socketPath, factory }) => {
    await submitAndCollect(socketPath, [ONE_FILE]);
    const messages: DaemonMessage[] = [];
    const session = await exchange(socketPath, { type: "submit", paths: [ONE_FILE], out: "/tmp/daemon-test-out", repeat: 1, lanes: 1, lock: true, env: {} }, message => messages.push(message));
    await session.closed;
    assert.equal(messages.find(message => message.type === "result")?.type, "result");
    const shared = factory.created.filter(server => server.kind === "shared");
    assert.equal(shared.length, 3, "the probe, the plain batch's server and a third for the locked batch");
    for (let waited = 0; !shared[2]!.stopped && waited < 2_000; waited += 20) await new Promise(done => setTimeout(done, 20));
    assert.deepEqual(shared.map(server => server.stopped), [false, false, true]);
  });
});

test("the daemon logs one sample line with the machine, the ledger, the target and the counts, and one trial line per settled trial", async () => {
  await withDaemon(async ({ socketPath, logs }) => {
    await submitAndCollect(socketPath, [ONE_FILE]);
    await new Promise(resolve => setTimeout(resolve, 60));
    const sample = logs.find(line => /sample: .* \| cpu=10% own=- load1=- mem=\d+ ledger=-?\d+ target=28 running=\d+ queued=\d+ servers=\d+ starts=\d+ held=/u.test(line));
    assert.ok(sample, `no sample line in ${logs.join(" / ")}`);
    assert.ok(logs.some(line => /^trial air-supply-under-water lane 1 server s\d+ queue=\d+ serverWait=\d+ mutexWait=\d+ arrange=\d+ join=\d+ trial=\d+ restoreWait=\d+ restore=\d+ hold=\d+$/u.test(line)), "a trial line");
    assert.ok(logs.some(line => /^server s\d+ \(shared, key .*\) starting: new key$/u.test(line)), "a start with its reason");
  });
});

test("a daemon given clients ahead boots one for the scenario it runs and kills it when the submission ends unused", async () => {
  const clients = new ScriptedClients();
  const dir = await mkdtemp(join(tmpdir(), "daemon-ahead-"));
  const socketPath = join(dir, "d.sock");
  const factory = new FakeFactory();
  const logs: string[] = [];
  probeAnswers(factory);
  const config = loadScenarioServerConfig({ MINE_AI_SCENARIO_SAMPLE_EVERY_MS: "20", MINE_AI_SCENARIO_SOCKET_PATH: socketPath });
  const daemon = await startDaemon({
    socketPath, config, stateDir: join(dir, "state"), portBlock: { first: 25_400, last: 25_559 }, log: line => logs.push(line),
    factory, runTrial: passing, clientsAhead: new ClientsAhead({ config, log: line => logs.push(line), spawn: clients.spawn }),
    machine: { read: async () => ({ cpuBusy: 0.1, memAvailableMb: 20_000, threads: 24 }) }, residentMbOf: async () => 900,
    runIo: { open: async () => ({ log: () => {}, close: async () => {} }), writeResult: async () => {} },
  });
  try {
    const messages = await submitAndCollect(socketPath, [ONE_FILE]);
    assert.equal(messages.at(-1)?.type, "done");
    assert.equal(clients.spawned.length, 1, "one client for the one scenario, booted in the pass that admitted it");
    await clients.spawned[0]!.ahead.closed;
    assert.equal(clients.spawned[0]!.ahead.child.signalCode, "SIGKILL", "this runner never asked for it: it died with the submission");
  } finally {
    await daemon.stop();
    await clients.stopAll();
    await rm(dir, { recursive: true, force: true });
  }
});

/** A mirror that records what the daemon asks of it, in order. */
function recordingMirror(calls: string[]): DaemonMirror {
  return {
    acquire: async () => ({ kind: "snapshot", root: "/repo", dir: "/snapshots/g1", generation: 1, syncMs: 5, startedAt: "2026-10-31T10:00:00.000Z", sourceHead: null, release: () => { calls.push("release"); } }),
    prune: async () => { calls.push("prune"); },
    settled: async () => { calls.push("settled"); },
  };
}

test("the daemon prunes the mirror at its start and, once the installs settled, again before it stops", async () => {
  const calls: string[] = [];
  await withDaemon(async ({ daemon }) => {
    for (let waited = 0; !calls.includes("prune") && waited < 2_000; waited += 20) await new Promise(done => setTimeout(done, 20));
    assert.deepEqual(calls, ["prune"], "pruned once at the start");
    await daemon.stop();
    assert.deepEqual(calls, ["prune", "settled", "prune"], "the install settles, then the last prune");
  }, { mirror: recordingMirror(calls) });
});

test("a submit goes through the daemon's mirror: its snapshot's line is sent and its hold is given back when the batch ends", async () => {
  const calls: string[] = [];
  await withDaemon(async ({ socketPath }) => {
    const messages = await submitAndCollect(socketPath, [ONE_FILE]);
    assert.ok(messages.some(message => message.type === "info" && message.text.startsWith("clients start from snapshot g1 of /repo (synced in 5 ms")));
    assert.equal(messages.at(-1)?.type, "done");
    assert.ok(calls.includes("release"), "the hold was given back");
  }, { mirror: recordingMirror(calls) });
});

test("the daemon's own mirror runs on the real node_modules trees and their prune, under a directory named by its socket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "daemon-mirror-"));
  try {
    const root = join(dir, "root");
    mkdirSync(join(root, "tests", "minecraft"), { recursive: true });
    writeFileSync(join(root, "bun.lock"), "lock");
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "tests", "minecraft", "client-host.ts"), "export {};");
    const mirrorDir = join(dir, "mirror");
    const readyTree = join(mirrorDir, "modules", modulesHash(root), "node_modules");
    mkdirSync(join(readyTree, "mine-labs"), { recursive: true });
    const staleTree = join(mirrorDir, "modules", "0".repeat(64));
    mkdirSync(staleTree, { recursive: true });
    const eightDaysAgo = (Date.now() - 8 * 86_400_000) / 1000;
    writeFileSync(join(staleTree, ".last-used"), "");
    utimesSync(join(staleTree, ".last-used"), eightDaysAgo, eightDaysAgo);
    const socketPath = join(dir, "d.sock");
    const mirror = createDaemonMirror({
      config: loadScenarioServerConfig({ MINE_AI_SCENARIO_MIRROR_DIR: mirrorDir }), socketPath, log: () => {}, ports: { mounts: () => `drvfs ${dir} 9p rw 0 0\n` },
    });
    const snapshot = await mirror.acquire(join(root, "tests", "minecraft"));
    assert.equal(snapshot.kind, "snapshot", snapshot.kind === "in-place" ? snapshot.reason : "");
    if (snapshot.kind !== "snapshot") return;
    assert.ok(snapshot.dir.startsWith(join(mirrorDir, rootSlug(socketPath))), `the snapshot lives under the daemon's slug: ${snapshot.dir}`);
    assert.equal(realpathSync(join(snapshot.dir, "node_modules")), realpathSync(readyTree), "linked to the tree modulesFor found ready");
    snapshot.release();
    await mirror.settled();
    await mirror.prune();
    assert.equal(existsSync(staleTree), false, "pruneModules deleted the old unlinked tree");
    assert.equal(existsSync(readyTree), true, "and kept the tree a snapshot links");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the daemon's mirror passes the submitter's notify on: a slow sync reaches it as a syncing line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "daemon-mirror-slow-"));
  try {
    const root = join(dir, "root");
    mkdirSync(join(root, "tests", "minecraft"), { recursive: true });
    writeFileSync(join(root, "bun.lock"), "lock");
    writeFileSync(join(root, "package.json"), "{}");
    const mirrorDir = join(dir, "mirror");
    mkdirSync(join(mirrorDir, "modules", modulesHash(root), "node_modules", "mine-labs"), { recursive: true });
    const mirror = createDaemonMirror({
      config: loadScenarioServerConfig({ MINE_AI_SCENARIO_MIRROR_DIR: mirrorDir }), socketPath: join(dir, "d.sock"), log: () => {}, slowSyncNoticeMs: 20,
      ports: { mounts: () => `drvfs ${dir} 9p rw 0 0\n`, run: () => new Promise(resolve => setTimeout(() => resolve({ code: 0, stderrTail: "" }), 150)) },
    });
    const notices: string[] = [];
    const snapshot = await mirror.acquire(join(root, "tests", "minecraft"), undefined, line => notices.push(line));
    assert.equal(snapshot.kind, "snapshot", snapshot.kind === "in-place" ? snapshot.reason : "");
    assert.deepEqual(notices, [`syncing ${root} to the client mirror ...`]);
    if (snapshot.kind === "snapshot") snapshot.release();
    await mirror.settled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > 5_000) throw new Error(`timed out waiting for ${what}`);
    await pause(10);
  }
}

test("the daemon builds a missing template at the first idle sample, never beside a running trial, and holds a submission made during the build", async () => {
  const builds = new TemplateBuildRig();
  builds.status.length = 0; // no flat server has written its server.properties yet
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  const gated: TrialRunner = async input => {
    await input.onPrepared();
    input.deferReset(async () => {});
    started += 1;
    await gate;
    return { scenario: "x", outcome: "pass", elapsedMs: 1, goal: { state: "passed", detail: "ok" }, goalText: "" } satisfies RunResult;
  };
  try {
    await withDaemon(async ({ socketPath }) => {
      const first = submitAndCollect(socketPath, [ONE_FILE]);
      await until(() => started === 1, "the first trial");
      builds.status.push({ version: "1.21.4", key: BUILD_KEY, boxes: [], present: false }); // the first server of the key wrote it
      await pause(150);
      assert.equal(builds.calls.length, 0, "a trial runs, so nothing is built");
      release();
      await first;
      await until(() => builds.calls.length === 1, "the build");
      let waitSeen = false;
      const second = submitAndCollect(socketPath, [ONE_FILE], message => { if (message.type === "wait") waitSeen = true; });
      await until(() => waitSeen, "the first wait message");
      assert.equal(started, 1, "the second submission's trial waits for the build");
      builds.calls[0]!.finish({ ok: true, dir: join(builds.storeDir, BUILD_KEY) });
      const messages = await second;
      assert.equal(started, 2);
      const waits = messages.flatMap(message => (message.type === "wait" ? [message.text] : []));
      assert.match(waits[0] ?? "", /waits: world template build of 1\.21\.4 is running/u, "the submitter is told what it waits for");
      assert.equal(messages.find(message => message.type === "result")?.type, "result");
    }, { runTrial: gated, templateBuilds: builds.builds, env: { MINE_AI_SCENARIO_WAIT_REPORT_MS: "50" } });
  } finally {
    builds.dispose();
  }
});

test("the daemon does not stop for idleness while a build runs", async () => {
  const builds = new TemplateBuildRig();
  try {
    await withDaemon(async ({ socketPath }) => {
      await until(() => builds.calls.length === 1, "the build");
      await pause(500); // five times DAEMON_IDLE_MS
      assert.equal(await daemonListens(socketPath), true);
      builds.calls[0]!.finish({ ok: true, dir: join(builds.storeDir, BUILD_KEY) });
    }, { templateBuilds: builds.builds, env: { MINE_AI_SCENARIO_DAEMON_IDLE_MS: "100" } });
  } finally {
    builds.dispose();
  }
});

test("the daemon's stop ends a running build before it closes the socket", async () => {
  const builds = new TemplateBuildRig();
  try {
    await withDaemon(async ({ daemon }) => {
      await until(() => builds.calls.length === 1, "the build");
      await builds.calls[0]!.startServer();
      const stopping = daemon.stop();
      await builds.servers[0]!.whenStopped();
      builds.calls[0]!.finish({ ok: false, reason: "build server did not stop: killed", bound: false });
      await stopping;
      assert.equal(builds.servers[0]!.stopped, true);
      assert.deepEqual(builds.pidFile, []);
    }, { templateBuilds: builds.builds });
  } finally {
    builds.dispose();
  }
});

test("a stop request during a build stops the build at once instead of waiting for it (the bound is 180 s), and the daemon then stops", async () => {
  const builds = new TemplateBuildRig();
  try {
    await withDaemon(async ({ daemon, socketPath }) => {
      await until(() => builds.calls.length === 1, "the build");
      await builds.calls[0]!.startServer();
      const session = await exchange(socketPath, { type: "stop" }, () => {});
      await session.closed;
      await builds.servers[0]!.whenStopped(); // the request itself stopped the build server
      builds.calls[0]!.finish({ ok: false, reason: "build server did not stop: killed", bound: false });
      await daemon.stopped;
      assert.equal(builds.calls.length, 1, "no other build");
    }, { templateBuilds: builds.builds });
  } finally {
    builds.dispose();
  }
});

test("a daemon asked to stop starts no build, even one whose key is being computed when the stop request comes", async () => {
  const builds = new TemplateBuildRig();
  let open!: () => void;
  builds.statusGate = new Promise<void>(resolve => { open = resolve; });
  try {
    await withDaemon(async ({ daemon, socketPath }) => {
      const session = await exchange(socketPath, { type: "stop" }, () => {});
      await session.closed;
      open();
      await daemon.stopped;
      assert.equal(builds.calls.length, 0);
    }, { templateBuilds: builds.builds });
  } finally {
    builds.dispose();
  }
});

interface RamDaemon { readonly daemon: Daemon; readonly logs: string[]; readonly ramDir: string }

/** A daemon with the real server factory (it starts no server: no trial is submitted) over a temp RAM dir, its template builds a rig's. */
async function withRamDaemon(env: Record<string, string>, body: (daemon: RamDaemon) => Promise<void>, seed: (ramDir: string) => void = () => {}): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "daemon-ram-"));
  const ramDir = join(dir, "ram");
  const builds = new TemplateBuildRig();
  const logs: string[] = [];
  const socketPath = join(dir, "a.sock");
  seed(ramDir); // what other daemons left, before this one starts
  const config = loadScenarioServerConfig({ MINE_AI_SCENARIO_SOCKET_PATH: socketPath, MINE_AI_SCENARIO_WORLD_RAM_DIR: ramDir, ...env });
  const daemon = await startDaemon({
    socketPath, config, stateDir: join(dir, "state"), portBlock: { first: 25_400, last: 25_559 }, log: line => logs.push(line), runTrial: passing, templateBuilds: builds.builds,
    machine: { read: async () => ({ cpuBusy: 0.1, memAvailableMb: 20_000, threads: 24 }) }, residentMbOf: async () => 900,
    runIo: { open: async () => ({ log: () => {}, close: async () => {} }), writeResult: async () => {} },
  });
  try {
    await body({ daemon, logs, ramDir });
  } finally {
    await daemon.stop();
    builds.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

const ramDirsOf = (ramDir: string): string[] => (existsSync(ramDir) ? readdirSync(ramDir).sort() : []);

test("a daemon with the real factory makes its RAM dir, logs where, and removes it at stop", async () => {
  await withRamDaemon({}, async ({ daemon, logs, ramDir }) => {
    const [name] = ramDirsOf(ramDir);
    assert.match(name ?? "", /^mine-ai-worlds-[0-9a-f]{8}$/u);
    assert.equal(JSON.parse(readFileSync(join(ramDir, name!, "owner.json"), "utf8")).pid, process.pid);
    assert.ok(logs.includes(`worlds in RAM under ${join(ramDir, name!)}`), logs.join("\n"));
    await daemon.stop();
    assert.deepEqual(ramDirsOf(ramDir), [], "the dir is gone, so /dev/shm holds nothing of this daemon");
  });
});

for (const [name, env, line] of [
  ["MINE_AI_SCENARIO_WORLD_RAM=0", { MINE_AI_SCENARIO_WORLD_RAM: "0" }, "worlds on disk (WORLD_RAM=0)"],
  ["MINE_AI_SCENARIO_WORLD_TEMPLATE=0 (no template world to copy)", { MINE_AI_SCENARIO_WORLD_TEMPLATE: "0" }, "worlds on disk (WORLD_TEMPLATE=0: no template world to copy)"],
] as const) {
  test(`${name} makes no RAM dir and says the worlds are on disk`, async () => {
    await withRamDaemon(env, async ({ logs, ramDir }) => {
      assert.deepEqual(ramDirsOf(ramDir), []);
      assert.ok(logs.includes(line), logs.join("\n"));
    });
  });
}

test("a daemon given its own factory (the unit tests') makes no RAM dir and sweeps none", async () => {
  const ramDir = await mkdtemp(join(tmpdir(), "daemon-ram-factory-"));
  const deadDir = join(ramDir, "mine-ai-worlds-dead00aa");
  mkdirSync(deadDir);
  writeFileSync(join(deadDir, "owner.json"), JSON.stringify({ socketPath: "/tmp/x", pid: 2_147_483_000 }));
  try {
    await withDaemon(async ({ logs }) => {
      assert.deepEqual(ramDirsOf(ramDir), ["mine-ai-worlds-dead00aa"]);
      assert.deepEqual(logs.filter(line => line.includes("RAM") || line.includes("worlds on disk")), []);
    }, { env: { MINE_AI_SCENARIO_WORLD_RAM_DIR: ramDir } });
  } finally {
    await rm(ramDir, { recursive: true, force: true });
  }
});

// The other daemons are processes of their own: a living `bun` child stands for one on another socket and the same port block (two daemons in one test process
// hang when the second one stopped is stopped; seen with a fake factory and WORLD_RAM=0 too).
test("at start a dir whose owner.json pid is dead is removed and one whose pid is a living bun process (another daemon) is kept, now and after this daemon's stop", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  assert.ok(child.pid !== undefined, "the stand-in daemon started");
  const owners = { dead: "mine-ai-worlds-dead00aa", live: "mine-ai-worlds-live00bb" };
  try {
    await withRamDaemon({}, async ({ daemon, ramDir }) => {
      assert.equal(existsSync(join(ramDir, owners.dead)), false);
      assert.equal(existsSync(join(ramDir, owners.live, "s1-1")), true, `the child's comm is ${readFileSync(`/proc/${child.pid}/comm`, "utf8").trim()}: a living daemon's server root is untouched`);
      assert.equal(ramDirsOf(ramDir).length, 2, "the live dir and this daemon's own");
      await daemon.stop();
      assert.deepEqual(ramDirsOf(ramDir), [owners.live], "this daemon's stop removed only its own dir");
    }, ramDir => {
      for (const [name, pid] of [[owners.dead, 2_147_483_000], [owners.live, child.pid!]] as const) {
        mkdirSync(join(ramDir, name, "s1-1"), { recursive: true });
        writeFileSync(join(ramDir, name, "owner.json"), JSON.stringify({ socketPath: "/tmp/other.sock", pid }));
      }
    });
  } finally {
    child.kill();
  }
});

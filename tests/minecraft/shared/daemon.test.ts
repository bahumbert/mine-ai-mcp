import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunResult } from "mine-labs";
import { loadScenarioServerConfig } from "./config.ts";
import { daemonListens, exchange } from "./daemon-client.ts";
import { startDaemon, type Daemon } from "./daemon.ts";
import { FakeFactory } from "./fake-servers.ts";
import type { DaemonMessage } from "./protocol.ts";
import type { TrialRunner } from "./trial.ts";

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
  run: (context: { daemon: Daemon; socketPath: string; factory: FakeFactory; dir: string }) => Promise<void>,
  overrides: { env?: Record<string, string>; runTrial?: TrialRunner } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "daemon-"));
  const socketPath = join(dir, "d.sock");
  const factory = new FakeFactory();
  probeAnswers(factory);
  const config = loadScenarioServerConfig({ MINE_AI_SCENARIO_SAMPLE_EVERY_MS: "20", MINE_AI_SCENARIO_SOCKET_PATH: socketPath, ...overrides.env });
  const daemon = await startDaemon({
    socketPath, config, stateDir: join(dir, "state"), portBlock: { first: 25_400, last: 25_559 }, log: () => {},
    factory, runTrial: overrides.runTrial ?? passing,
    machine: { read: async () => ({ cpuBusy: 0.1, memAvailableMb: 20_000, threads: 24 }) }, residentMbOf: async () => 900,
    runIo: { open: async () => ({ log: () => {}, close: async () => {} }), writeResult: async () => {} },
  });
  try {
    await run({ daemon, socketPath, factory, dir });
  } finally {
    await daemon.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

async function submitAndCollect(socketPath: string, paths: string[]): Promise<DaemonMessage[]> {
  const messages: DaemonMessage[] = [];
  const session = await exchange(socketPath, { type: "submit", paths, out: "/tmp/daemon-test-out", repeat: 1, lanes: null, lock: false, env: {} }, message => messages.push(message));
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

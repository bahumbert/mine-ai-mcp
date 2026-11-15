import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { FRESH_SERVER_GAMERULES } from "../arena/gamerule-defaults.ts";
import { loadScenarioServerConfig } from "./config.ts";
import { exchange, type Exchange } from "./daemon-client.ts";
import { type Daemon, startDaemon } from "./daemon.ts";
import { FakeFactory } from "./fake-servers.ts";
import { settlesWithin } from "./settles-within.ts";
import { TemplateBuildRig } from "./template-build-rig.ts";

const nextTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test("a pending build resident read holds neither successive daemon samples nor its stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rig-resident-"));
  const rig = new TemplateBuildRig();
  rig.javaPid = 7;
  await rig.startIfDue();
  await rig.calls[0]!.startServer();
  const factory = new FakeFactory();
  factory.onCreate = server => {
    server.defaultReply = command => {
      if (!command.startsWith("gamerule ")) return "";
      const rule = command.slice(9);
      const value = FRESH_SERVER_GAMERULES[rule];
      return value === undefined ? "Unknown or incomplete command" : `Gamerule ${rule} is currently set to: ${value}`;
    };
  };
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  let daemon: Daemon | undefined;
  let session: Exchange | undefined;
  let reads = 0;
  let sampled = Promise.withResolvers<void>();
  try {
    const socketPath = join(dir, "d.sock");
    daemon = await startDaemon({
      socketPath, config: loadScenarioServerConfig({ MINE_AI_SCENARIO_SAMPLE_EVERY_MS: "20" }),
      stateDir: join(dir, "state"), portBlock: { first: 25_320, last: 25_359 },
      log: line => { if (line.startsWith("sample:")) sampled.resolve(); },
      factory, templateBuilds: rig.builds,
      runTrial: async () => { throw new Error("the build holds this trial"); },
      machine: { read: async () => ({ cpuBusy: 0.1, memAvailableMb: 20_000, threads: 24 }) },
      residentMbOf: pid => pid === 7 ? (reads++, new Promise<number>(() => {})) : Promise.resolve(900),
    });
    const path = fileURLToPath(new URL("../contract/scenarios/air-supply-under-water.yaml", import.meta.url));
    session = await exchange(socketPath, { type: "submit", paths: [path], out: dir, repeat: 1, lanes: 1, lock: false, env: {} }, () => {});
    for (let turn = 0; factory.created.length === 0; turn++) {
      assert.ok(turn < 10_000, "the submission starts the gamerule probe");
      await nextTurn();
    }
    const probe = factory.created[0]!;
    for (let sample = 1; sample <= 2; sample++) {
      sampled = Promise.withResolvers<void>();
      await clock.advance(20, 20);
      assert.equal(await settlesWithin(sampled.promise), true, `sample ${sample} finishes despite the pending build read`);
      assert.equal(probe.commands.filter(command => command === "tick query").length, sample);
    }
    assert.equal(reads, 1, "one read stays outstanding for this build");
    assert.equal(await settlesWithin(daemon.stop(), 10_000), true, "stopping never awaits the resident read");
  } finally {
    session?.close();
    await daemon?.stop();
    await rig.shutDown();
    rig.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rejected build resident read leaves the next sample free to read again", async () => {
  const rig = new TemplateBuildRig();
  let reads = 0;
  const residentMbOf = async (): Promise<number> => {
    if (++reads === 1) throw new Error("process read failed");
    return 1_234;
  };
  try {
    await rig.startIfDue();
    await rig.calls[0]!.startServer();
    await rig.builds.sampleResident(residentMbOf);
    await rig.settle();
    assert.equal(rig.builds.ledgerReading()?.residentMb, 0);
    await rig.builds.sampleResident(residentMbOf);
    await rig.settle();
    assert.equal(reads, 2);
    assert.equal(rig.builds.ledgerReading()?.residentMb, 1_234);
  } finally {
    await rig.shutDown();
    rig.dispose();
  }
});

/** Ends A and starts B while A's process read is still outstanding. */
async function replaceBuild(rig: TemplateBuildRig): Promise<void> {
  await rig.servers[0]!.stop();
  rig.calls[0]!.finish({ ok: true, dir: join(rig.storeDir, rig.status[0]!.key) });
  await rig.settle();
  rig.status.push({ version: "1.20.4", key: "key-1-20-4", boxes: [], present: false });
  rig.javaPid = 8;
  await rig.startIfDue();
  await rig.calls[1]!.startServer();
}

test("a late resident answer from build A never fills build B's ledger reading", async () => {
  const rig = new TemplateBuildRig();
  const resident = Promise.withResolvers<number>();
  try {
    await rig.startIfDue();
    await rig.calls[0]!.startServer();
    const sampled = rig.builds.sampleResident(() => resident.promise);
    await replaceBuild(rig);
    resident.resolve(2_000);
    await sampled;
    await rig.settle();
    assert.equal(rig.builds.ledgerReading()?.residentMb, 0, "B has no reading yet");
  } finally {
    resident.resolve(0);
    await rig.shutDown();
    rig.dispose();
  }
});

test("build B starts its own resident read while build A's read is still pending", async () => {
  const rig = new TemplateBuildRig();
  const resident = Promise.withResolvers<number>();
  const pids: number[] = [];
  const residentMbOf = (pid: number): Promise<number> => {
    pids.push(pid);
    return pid === 8 ? Promise.resolve(1_234) : resident.promise;
  };
  try {
    await rig.startIfDue();
    await rig.calls[0]!.startServer();
    void rig.builds.sampleResident(residentMbOf);
    await replaceBuild(rig);
    await rig.builds.sampleResident(residentMbOf);
    await rig.settle();
    assert.deepEqual(pids, [4_242, 8]);
    assert.equal(rig.builds.ledgerReading()?.residentMb, 1_234);
  } finally {
    resident.resolve(0);
    await rig.shutDown();
    rig.dispose();
  }
});

test("a daemon stop ends the template build its rig left running: the stop does not wait for a build only a test could finish", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rig-stop-"));
  const socketPath = join(dir, "d.sock");
  const rig = new TemplateBuildRig();
  const logs: string[] = [];
  let daemon: Daemon | undefined;
  let stopping: Promise<void> | undefined;
  try {
    daemon = await startDaemon({
      socketPath,
      config: loadScenarioServerConfig({ MINE_AI_SCENARIO_SAMPLE_EVERY_MS: "20" }),
      stateDir: join(dir, "state"),
      portBlock: { first: 25_400, last: 25_559 },
      log: line => logs.push(line),
      factory: new FakeFactory(),
      runTrial: async () => { throw new Error("no trial runs in this test"); },
      templateBuilds: rig.builds,
      machine: { read: async () => ({ cpuBusy: 0.1, memAvailableMb: 20_000, threads: 24 }) },
      residentMbOf: async () => 900,
    });
    // The first sample of the daemon starts the rig's build; counted in event-loop turns, not wall milliseconds.
    for (let turn = 0; rig.calls.length === 0; turn += 1) {
      assert.ok(turn < 10_000, "the first sample starts the build");
      await nextTurn();
    }
    assert.equal(rig.calls.length, 1);
    stopping = daemon.stop();
    assert.equal(await settlesWithin(stopping, 10_000), true, "the stop ends the build and then the daemon");
    assert.ok(logs.includes("daemon stopped"), "the daemon logs its stop");
  } finally {
    // Only a stop that did not end is still waiting here: the test's end finishes the build, as a real build ends with its server.
    for (const call of rig.calls) call.finish({ ok: false, reason: "the test is over", bound: false });
    await (stopping ?? daemon?.stop());
    rig.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

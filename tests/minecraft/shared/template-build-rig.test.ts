import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenarioServerConfig } from "./config.ts";
import { type Daemon, startDaemon } from "./daemon.ts";
import { FakeFactory } from "./fake-servers.ts";
import { settlesWithin } from "./settles-within.ts";
import { TemplateBuildRig } from "./template-build-rig.ts";

const nextTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

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

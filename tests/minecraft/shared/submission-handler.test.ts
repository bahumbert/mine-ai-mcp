import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GameruleDefaultsCache } from "./gamerule-defaults.ts";
import type { DaemonMessage } from "./protocol.ts";
import { SchedulerRig } from "./scheduler-rig.ts";
import type { ScenarioServer } from "./scenario-server.ts";
import { handleSubmit } from "./submission-handler.ts";

const CONTRACT_DIR = fileURLToPath(new URL("../contract/scenarios", import.meta.url));
const ONE_FILE = join(CONTRACT_DIR, "air-supply-under-water.yaml");

function setup() {
  const rig = new SchedulerRig();
  const sent: DaemonMessage[] = [];
  const probe: ScenarioServer = {
    id: "probe", kind: "shared", gamePort: 25_400, heapMb: 3_072, javaPid: () => null, stop: async () => {},
    command: async command => `Gamerule ${command.slice("gamerule ".length)} is currently set to: true`,
  };
  const cache = new GameruleDefaultsCache(async () => probe);
  const base = { scheduler: rig.scheduler, defaults: cache, config: rig.config, send: (message: DaemonMessage) => sent.push(message) };
  return { rig, sent, base };
}

test("a submission loads its files, queues them as lanes, and sends one result and a done per run", async () => {
  const { rig, sent, base } = setup();
  rig.sample();
  const running = handleSubmit(base, { type: "submit", paths: [ONE_FILE], out: "/tmp/out", repeat: 1, lanes: null, lock: false, env: {} });
  await rig.until(() => rig.running.length === 1, "the trial to start");
  rig.running[0]!.finish();
  await running.finished;
  const kinds = sent.map(message => message.type);
  assert.ok(kinds.includes("result"));
  assert.equal(kinds.at(-1), "done");
  const done = sent.at(-1);
  assert.deepEqual(done?.type === "done" ? [done.runs, done.passed] : [], [1, 1]);
});

test("a file that fails to load is sent as an error, counted as failed, and the others still run", async () => {
  const { rig, sent, base } = setup();
  rig.sample();
  const running = handleSubmit(base, { type: "submit", paths: [ONE_FILE, "/nonexistent/x.yaml"], out: "/tmp/out", repeat: 1, lanes: null, lock: false, env: {} });
  await rig.until(() => rig.running.length === 1, "the trial to start");
  rig.running[0]!.finish();
  await running.finished;
  assert.ok(sent.some(message => message.type === "error" && message.text.includes("nonexistent")));
  const done = sent.at(-1);
  assert.deepEqual(done?.type === "done" ? [done.runs, done.passed, done.failed] : [], [2, 1, 1]);
});

test("a submission with nothing loadable ends at once with a done and no trial", async () => {
  const { sent, base } = setup();
  const running = handleSubmit(base, { type: "submit", paths: ["/nonexistent/x.yaml"], out: "/tmp/out", repeat: 1, lanes: null, lock: false, env: {} });
  await running.finished;
  assert.equal(sent.at(-1)?.type, "done");
});

test("closing the connection cancels the submission's trials", async () => {
  const { rig, base } = setup();
  rig.sample();
  const running = handleSubmit(base, { type: "submit", paths: [ONE_FILE], out: "/tmp/out", repeat: 1, lanes: null, lock: false, env: {} });
  await rig.until(() => rig.running.length === 1, "the trial to start");
  running.connectionClosed();
  assert.equal(rig.running[0]?.input.signal.aborted, true);
  rig.running[0]!.finish("cancelled");
  await running.finished;
});

test("the submitter's variables reach the scenario's client env, and the YAML's own env wins over them", async () => {
  const { rig, base } = setup();
  rig.sample();
  const running = handleSubmit(base, { type: "submit", paths: [ONE_FILE], out: "/tmp/out", repeat: 1, lanes: null, lock: false, env: { MINE_AI_DIG_TRACE: "/tmp/trace", MINE_AI_SCENARIO_EVIDENCE: "1" } });
  await rig.until(() => rig.running.length === 1, "the trial to start");
  const env = rig.running[0]!.input.scenario.client.env;
  assert.equal(env.MINE_AI_DIG_TRACE, "/tmp/trace");
  assert.equal(env.MINE_AI_SCENARIO_EVIDENCE, "1");
  rig.running[0]!.finish();
  await running.finished;
});

test("a gamerule probe server that fails to start ends the submission with an error and a done instead of rejecting (a rejection would kill the daemon)", async () => {
  const { rig, sent } = setup();
  const failing = new GameruleDefaultsCache(async () => { throw new Error("probe port busy"); });
  const running = handleSubmit({ scheduler: rig.scheduler, defaults: failing, config: rig.config, send: message => sent.push(message) },
    { type: "submit", paths: [ONE_FILE], out: "/tmp/out", repeat: 1, lanes: null, lock: false, env: {} });
  await running.finished;
  assert.ok(sent.some(message => message.type === "error" && message.text.includes("probe port busy")));
  const done = sent.at(-1);
  assert.deepEqual(done?.type === "done" ? [done.runs, done.failed] : [], [1, 1]);
});

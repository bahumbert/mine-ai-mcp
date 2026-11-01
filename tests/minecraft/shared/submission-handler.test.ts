import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_HOST_PROTOCOL } from "../client-boot-marker.ts";
import { clientTupleOf } from "./client-ahead.ts";
import { GameruleDefaultsCache } from "./gamerule-defaults.ts";
import type { InPlace, ScenarioMirror, Snapshot } from "./mirror.ts";
import type { DaemonMessage } from "./protocol.ts";
import { SchedulerRig } from "./scheduler-rig.ts";
import type { ScenarioServer } from "./scenario-server.ts";
import { ScriptedClients } from "./scripted-clients.ts";
import { sourceRootOf } from "./source-root.ts";
import { handleSubmit } from "./submission-handler.ts";

// check-reads: tests/minecraft/contract/scenarios/air-supply-under-water.yaml, tests/minecraft/templates/**/*.yaml
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

test("a scenario whose client entry cannot be resolved gets a server of its own and the rest of the submission is queued as usual", async () => {
  const { rig, sent, base } = setup();
  rig.sample();
  const folder = mkdtempSync(join(tmpdir(), "submission-client-"));
  try {
    const typo = join(folder, "typo-client.yaml");
    const templatePath = fileURLToPath(new URL("../templates/flat-single-action.yaml", import.meta.url));
    writeFileSync(typo, [
      ["../../templates/flat-single-action.yaml", templatePath],
      ["name: contract-air-supply-under-water", "name: typo-client"],
      ["cwd: ../..", "cwd: ."],
      ["- client-host.ts", "- no-such-host.ts"],
    ].reduce((text, [from, to]) => {
      assert.ok(text.includes(from!), `the contract YAML no longer holds '${from}'`);
      return text.replace(from!, to!);
    }, readFileSync(ONE_FILE, "utf8")));
    const running = handleSubmit(base, { type: "submit", paths: [ONE_FILE, typo], out: "/tmp/out", repeat: 1, lanes: null, lock: false, env: {} });
    await rig.until(() => sent.some(message => message.type === "info" && message.text.includes("scenarios:")), "the placement summary");
    const info = sent.find(message => message.type === "info" && message.text.includes("scenarios:"));
    const text = info?.type === "info" ? info.text : "";
    assert.match(text, /2 scenarios: 1 on lanes, 1 on servers of their own/u);
    assert.match(text, /own server: .*typo-client.*its client entry .*no-such-host\.ts could not be resolved \(ENOENT\)/u);
    await rig.drain();
    await running.finished;
    const done = sent.at(-1);
    assert.equal(done?.type === "done" ? done.runs : 0, 2, "both scenarios were queued and ran");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
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

// The scenario mirror (plan 2026-10-30-scenario-clients-ext4 T4): the clients of a submission start from a snapshot of their source root, or from where they are.
const TESTS_DIR = dirname(dirname(CONTRACT_DIR));
const WORKTREE = sourceRootOf(TESTS_DIR)!;
const SNAPSHOT_TIME = "2026-10-31T10:00:00.000Z";

type MirrorAnswer = { readonly kind: "snapshot" } | { readonly kind: "in-place"; readonly reason: string; readonly fallback: boolean } | { readonly kind: "throws"; readonly message: string };

/** A mirror that answers what the test says for each root and remembers what it was asked and which holds were given back. Its snapshots live in `snapshotsIn`; a test that boots clients gives a real tree. */
class FakeMirror {
  readonly acquired: { readonly cwd: string; readonly signal: AbortSignal | undefined }[] = [];
  readonly released: number[] = [];
  /** What `acquire` does when its signal aborts while it waits: nothing waits (`none`), or it answers in-place `cancelled` or a snapshot that was ready just as the submitter left. */
  waits: "none" | "cancelled-in-place" | "snapshot-anyway" = "none";
  private generations = 0;

  constructor(private readonly snapshotsIn = "/snapshots", private readonly answer: (root: string) => MirrorAnswer = () => ({ kind: "snapshot" })) {}

  /** When set, `acquire` calls its `notify` with this line before it answers, like a sync that runs long. */
  slowSyncLine: string | null = null;

  async acquire(cwd: string, signal?: AbortSignal, notify?: (line: string) => void): Promise<Snapshot | InPlace> {
    this.acquired.push({ cwd, signal });
    const root = sourceRootOf(cwd) ?? cwd;
    if (this.slowSyncLine !== null) notify?.(this.slowSyncLine);
    if (this.waits !== "none") await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
    if (this.waits === "cancelled-in-place") return { kind: "in-place", root, reason: "the submission was cancelled during the sync", fallback: false, release: () => {} };
    const answer = this.answer(root);
    if (answer.kind === "throws") throw new Error(answer.message);
    // A real sync takes a while: a snapshot comes back after a rejection of another root has already happened.
    await new Promise(resolve => setImmediate(resolve));
    if (answer.kind === "in-place") return { kind: "in-place", root, reason: answer.reason, fallback: answer.fallback, release: () => {} };
    const generation = ++this.generations;
    return {
      kind: "snapshot", root, dir: join(this.snapshotsIn, `g${generation}`), generation, syncMs: 123, startedAt: SNAPSHOT_TIME, release: () => { this.released.push(generation); },
    };
  }
}

const asMirror = (fake: FakeMirror): Pick<ScenarioMirror, "acquire"> => fake;

function withMirror() {
  const { rig, sent, base } = setup();
  const fake = new FakeMirror();
  return { rig, sent, fake, deps: { ...base, mirror: asMirror(fake) } };
}

const submitMessage = (paths: string[], overrides: Partial<Parameters<typeof handleSubmit>[1]> = {}) =>
  ({ type: "submit", paths, out: "/tmp/out", repeat: 1, lanes: null, lock: false, env: {}, ...overrides }) as Parameters<typeof handleSubmit>[1];

/** A scenario copy of the contract one whose client is not our host (so it gets a server of its own) and runs in `cwd`. */
function ownClientScenario(folder: string, name: string, cwd: string): string {
  const file = join(folder, `${name}.yaml`);
  const templatePath = fileURLToPath(new URL("../templates/flat-single-action.yaml", import.meta.url));
  writeFileSync(file, [
    ["../../templates/flat-single-action.yaml", templatePath], ["name: contract-air-supply-under-water", `name: ${name}`], ["cwd: ../..", `cwd: ${cwd}`], ["- client-host.ts", "- no-such-host.ts"],
  ].reduce((text, [from, to]) => {
    assert.ok(text.includes(from!), `the contract YAML no longer holds '${from}'`);
    return text.replace(from!, to!);
  }, readFileSync(ONE_FILE, "utf8")));
  return file;
}

/** A trial on a server of its own starts a sample after the lane's: sample (a second apart on the rig's clock) until `count` run. */
async function sampleUntilRunning(rig: SchedulerRig, count: number): Promise<void> {
  for (let samples = 0; rig.running.length < count; samples++) {
    if (samples > 400) throw new Error(`${rig.running.length} of ${count} trials running after ${samples} samples`);
    rig.clock += 1_000;
    rig.sample();
    await rig.settle();
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const infoTexts =(sent: readonly DaemonMessage[]): string[] => sent.flatMap(message => (message.type === "info" ? [message.text] : []));
const cwdsOfRunning = (rig: SchedulerRig): (string | undefined)[] => rig.running.map(trial => trial.input.scenario.client.cwd);

test("lane and own entries of one root carry the snapshot's cwd, one acquire serves them and one info line names the snapshot", async () => {
  const { rig, sent, fake, deps } = withMirror();
  const folder = mkdtempSync(join(tmpdir(), "submission-mirror-"));
  try {
    rig.sample();
    const running = handleSubmit(deps, submitMessage([ONE_FILE, ownClientScenario(folder, "own-client", TESTS_DIR)]));
    await sampleUntilRunning(rig, 2);
    assert.deepEqual(fake.acquired.map(call => call.cwd), [TESTS_DIR], "one acquire for the root both scenarios share");
    const snapshotCwd = join("/snapshots/g1", relative(WORKTREE, TESTS_DIR));
    assert.deepEqual(cwdsOfRunning(rig), [snapshotCwd, snapshotCwd], "the lane trial (shifted copy of the lifted scenario) and the own trial both run from the snapshot");
    assert.ok(infoTexts(sent).includes(`clients start from snapshot g1 of ${WORKTREE} (synced in 123 ms, started ${SNAPSHOT_TIME})`), infoTexts(sent).join(" | "));
    await rig.drain();
    await running.finished;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

for (const { name, answer, line } of [
  { name: "a fallback keeps the original cwd and says why the clients start from /mnt/d", answer: { reason: "rsync exited 23: boom", fallback: true }, line: `clients start from /mnt/d for ${WORKTREE}: rsync exited 23: boom` },
  { name: "a root already on ext4 keeps its cwd and sends no fallback line", answer: { reason: `${WORKTREE} is already on ext4`, fallback: false }, line: null },
]) {
  test(`an in-place answer: ${name}`, async () => {
    const { rig, sent, deps } = withMirror();
    const mirror = new FakeMirror("/snapshots", () => ({ kind: "in-place", ...answer }));
    rig.sample();
    const running = handleSubmit({ ...deps, mirror: asMirror(mirror) }, submitMessage([ONE_FILE]));
    await rig.until(() => rig.running.length === 1, "the trial to start");
    assert.deepEqual(cwdsOfRunning(rig), [TESTS_DIR]);
    assert.deepEqual(infoTexts(sent).filter(text => text.includes("clients start from")), line === null ? [] : [line]);
    await rig.drain();
    await running.finished;
  });
}

test("a line the mirror gives while it syncs reaches the submitter as an info line before the clients start", async () => {
  const { rig, sent, fake, deps } = withMirror();
  fake.slowSyncLine = `syncing ${WORKTREE} to the client mirror ...`;
  rig.sample();
  const running = handleSubmit(deps, submitMessage([ONE_FILE]));
  await rig.until(() => rig.running.length === 1, "the trial to start");
  const texts = infoTexts(sent);
  assert.ok(texts.indexOf(fake.slowSyncLine) >= 0, texts.join(" | "));
  assert.ok(texts.indexOf(fake.slowSyncLine) < texts.findIndex(text => text.startsWith("clients start from snapshot")), "the start line comes before the end line");
  await rig.drain();
  await running.finished;
});

test("two source roots get one acquire each: the snapshot's root runs from it, the other (in place) where it is", async () => {
  const { rig, sent, deps } = withMirror();
  const folder = mkdtempSync(join(tmpdir(), "submission-roots-"));
  try {
    const otherRoot = join(folder, "other");
    const otherTests = join(otherRoot, "tests", "minecraft");
    mkdirSync(otherTests, { recursive: true });
    writeFileSync(join(otherRoot, "bun.lock"), "lock");
    const mirror = new FakeMirror("/snapshots", root => (root === WORKTREE ? { kind: "snapshot" } : { kind: "in-place", reason: "no space left", fallback: true }));
    rig.sample();
    const running = handleSubmit({ ...deps, mirror: asMirror(mirror) }, submitMessage([ONE_FILE, ownClientScenario(folder, "other-root", otherTests)]));
    await sampleUntilRunning(rig, 2);
    assert.deepEqual(mirror.acquired.map(call => call.cwd).sort(), [otherTests, TESTS_DIR].sort());
    assert.deepEqual(new Set(cwdsOfRunning(rig)), new Set([join("/snapshots/g1", relative(WORKTREE, TESTS_DIR)), otherTests]));
    assert.ok(infoTexts(sent).includes(`clients start from /mnt/d for ${otherRoot}: no space left`));
    await rig.drain();
    await running.finished;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("an acquire that throws puts that root in place with its message and loses nothing of the other root: its snapshot is used and released", async () => {
  const { rig, sent, deps } = withMirror();
  const folder = mkdtempSync(join(tmpdir(), "submission-throws-"));
  try {
    const otherRoot = join(folder, "other");
    const otherTests = join(otherRoot, "tests", "minecraft");
    mkdirSync(otherTests, { recursive: true });
    writeFileSync(join(otherRoot, "bun.lock"), "lock");
    const mirror = new FakeMirror("/snapshots", root => (root === WORKTREE ? { kind: "snapshot" } : { kind: "throws", message: "EACCES: modulesHash" }));
    rig.sample();
    const running = handleSubmit({ ...deps, mirror: asMirror(mirror) }, submitMessage([ONE_FILE, ownClientScenario(folder, "other-root", otherTests)]));
    await sampleUntilRunning(rig, 2);
    assert.deepEqual(new Set(cwdsOfRunning(rig)), new Set([join("/snapshots/g1", relative(WORKTREE, TESTS_DIR)), otherTests]));
    assert.ok(infoTexts(sent).includes(`clients start from /mnt/d for ${otherRoot}: the snapshot could not be made: EACCES: modulesHash`), infoTexts(sent).join(" | "));
    await rig.drain();
    await running.finished;
    assert.deepEqual(mirror.released, [1], "the snapshot that resolved after the other root's rejection is released");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the hold is given back after the batch is done, after a cancel and after the scheduler threw", async () => {
  const done = withMirror();
  done.rig.sample();
  const finished = handleSubmit(done.deps, submitMessage([ONE_FILE]));
  await done.rig.until(() => done.rig.running.length === 1, "the trial to start");
  assert.deepEqual(done.fake.released, [], "held while the trial runs");
  await done.rig.drain();
  await finished.finished;
  assert.deepEqual(done.fake.released, [1], "released once after done");

  const cancelled = withMirror();
  cancelled.rig.sample();
  const left = handleSubmit(cancelled.deps, submitMessage([ONE_FILE]));
  await cancelled.rig.until(() => cancelled.rig.running.length === 1, "the trial to start");
  left.connectionClosed();
  cancelled.rig.running[0]!.finish("cancelled");
  await left.finished;
  assert.deepEqual(cancelled.fake.released, [1], "released after a cancel");

  const thrown = withMirror();
  thrown.rig.scheduler.submit = () => { throw new Error("scheduler refused"); };
  const failed = handleSubmit(thrown.deps, submitMessage([ONE_FILE]));
  await failed.finished;
  assert.ok(thrown.sent.some(message => message.type === "error" && message.text.includes("scheduler refused")));
  assert.deepEqual(thrown.fake.released, [1], "released after a thrown submission");
});

test("two submissions of one root run on two snapshots: their client tuples differ, so a client booted for g1 is never handed to a g2 trial", async () => {
  const { rig, deps } = withMirror();
  rig.sample();
  const first = handleSubmit(deps, submitMessage([ONE_FILE]));
  await rig.until(() => rig.running.length === 1, "the first trial");
  const second = handleSubmit(deps, submitMessage([ONE_FILE]));
  await rig.until(() => rig.running.length === 2, "the second trial");
  const [one, two] = rig.running.map(trial => clientTupleOf(trial.input.scenario.client));
  assert.notEqual(one, two);
  assert.match(one!, /snapshots\/g1\//u);
  assert.match(two!, /snapshots\/g2\//u);
  await rig.drain();
  await Promise.all([first.finished, second.finished]);
});

/** A tree the scheduler's own `runsOurClientHost` accepts: a root with `bun.lock`, our host file and the protocol stamp. */
function writeSnapshotTree(dir: string): void {
  mkdirSync(join(dir, "tests", "minecraft"), { recursive: true });
  writeFileSync(join(dir, "bun.lock"), "lock");
  writeFileSync(join(dir, "tests", "minecraft", "client-host.ts"), "export {};");
  writeFileSync(join(dir, "tests", "minecraft", "client-boot-marker.ts"), `export const CLIENT_HOST_PROTOCOL = ${CLIENT_HOST_PROTOCOL};\n`);
}

test("a lane trial's client is the one booted ahead: the shifted copy and the entry carry the same snapshot cwd", { timeout: 30_000 }, async () => {
  const clients = new ScriptedClients();
  const rig = new SchedulerRig({}, { clients });
  const folder = mkdtempSync(join(tmpdir(), "submission-ahead-"));
  try {
    writeSnapshotTree(join(folder, "g1"));
    const probe: ScenarioServer = {
      id: "probe", kind: "shared", gamePort: 25_400, heapMb: 3_072, javaPid: () => null, stop: async () => {},
      command: async command => `Gamerule ${command.slice("gamerule ".length)} is currently set to: true`,
    };
    const mirror = new FakeMirror(folder);
    const running = handleSubmit({ scheduler: rig.scheduler, defaults: new GameruleDefaultsCache(async () => probe), config: rig.config, send: () => {}, mirror: asMirror(mirror) }, submitMessage([ONE_FILE]));
    await sampleUntilRunning(rig, 1);
    assert.equal(clients.spawned[0]!.spec.cwd, join(folder, "g1", relative(WORKTREE, TESTS_DIR)), "booted from the snapshot");
    assert.equal(clientTupleOf(rig.running[0]!.input.scenario.client), clientTupleOf(clients.spawned[0]!.spec), "what the trial runs (the shifted lifted scenario) has the booted client's tuple");
    assert.equal(rig.running[0]!.clients[0], clients.spawned[0]!.ahead, "the trial took the booted client");
    await rig.drain();
    await running.finished;
  } finally {
    rig.scheduler.cancelAll("test over");
    await clients.stopAll();
    rmSync(folder, { recursive: true, force: true });
  }
});

for (const { name, waits, released } of [
  { name: "the sync gives up", waits: "cancelled-in-place", released: [] },
  { name: "the sync finishes as the submitter leaves, and its snapshot is released", waits: "snapshot-anyway", released: [1] },
] as const) {
  test(`cancel during the sync, ${name}: the signal reaches acquire, no trial is queued, done is sent, no fallback line`, async () => {
    const { rig, sent, fake, deps } = withMirror();
    fake.waits = waits;
    rig.sample();
    const running = handleSubmit(deps, submitMessage([ONE_FILE]));
    await rig.until(() => fake.acquired.length === 1, "acquire to start");
    assert.equal(fake.acquired[0]!.signal?.aborted, false);
    running.connectionClosed();
    await running.finished;
    assert.equal(fake.acquired[0]!.signal?.aborted, true);
    assert.equal(rig.scheduler.queuedCount + rig.scheduler.runningCount, 0, "no trial was queued");
    assert.equal(sent.at(-1)?.type, "done");
    assert.deepEqual(infoTexts(sent).filter(text => text.includes("clients start from /mnt/d")), [], "a submitter who left needs no fallback line");
    assert.deepEqual(fake.released, released);
  });
}

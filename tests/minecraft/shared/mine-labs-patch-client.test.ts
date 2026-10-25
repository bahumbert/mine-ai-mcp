import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as mineLabs from "mine-labs";
import type { ClientCompletion } from "mine-labs/client";

/**
 * A scenario client that prints before `init`, then reports what `init` carried and what its own environment holds.
 * argv[2] picks a boot: `exit:<code>` writes to stderr and exits at once, `flood:<n>` writes n stderr lines and exits 4,
 * `die-on-init` exits 5 when `init` arrives. After `start` every boot reports a completion whose detail is 3000 characters.
 */
const FIXTURE = `
import { createInterface } from "node:readline";
const mode = process.argv[2] ?? "idle";
const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
if (mode.startsWith("flood:")) for (let i = 0; i < Number(mode.slice(6)); i++) console.error("flood line " + i);
console.error("boot stderr line");
process.stdout.write("boot stdout line\\n");
if (mode.startsWith("exit:")) process.exit(Number(mode.slice(5)));
if (mode.startsWith("flood:")) process.exit(4);
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "init" && mode === "die-on-init") process.exit(5);
  if (message.type === "init") {
    send({ type: "log", message: "init " + JSON.stringify({ hasEnv: "env" in message, env: message.env, artifacts: process.env.MINE_LABS_ARTIFACTS_DIR, spawned: process.env.SPAWN_MARK }) });
    send({ type: "ready" });
  }
  if (message.type === "arranged") send({ type: "prepared" });
  if (message.type === "start") send({ type: "finish", completion: { status: "succeeded", detail: "d".repeat(3000) } });
  if (message.type === "stop") process.exit(0);
});
`;

let directory: string;
let fixture: string;

test.before(async () => {
  directory = await mkdtemp(join(tmpdir(), "mine-labs-patch-client-"));
  fixture = join(directory, "echo-client.mjs");
  await writeFile(fixture, FIXTURE);
});
test.after(async () => {
  await rm(directory, { recursive: true, force: true });
});

function clientSpec(mode: string, env: Record<string, string> = {}) {
  return mineLabs.scenarioSchema.parse({
    name: "client-fixture",
    client: { command: process.execPath, args: [fixture, mode], env },
    players: [{ name: "Walker" }],
    goal: { kind: "completion", who: "Walker" },
  });
}

function launch(mode: string, extra: Partial<mineLabs.LaunchScenarioClientOptions> & { env?: Record<string, string> } = {}) {
  const scenario = clientSpec(mode, extra.env);
  const { client, ...definition } = scenario;
  const logs: string[] = [];
  const completions: ClientCompletion[] = [];
  const process_ = mineLabs.launchScenarioClient({
    client, scenario: definition, host: "127.0.0.1", port: 25565, username: "Walker", version: "1.21.4", artifactsDirectory: "lane-artifacts",
    log: (message) => logs.push(message), onChat: () => {}, onCompletion: (completion) => completions.push(completion), ...extra,
  });
  return { client: process_, logs, completions };
}

/** The `init` report the fixture logged, parsed. */
function initReport(logs: string[]): { hasEnv: boolean; env?: Record<string, string>; artifacts?: string; spawned?: string } {
  const line = logs.find((entry) => entry.includes(": init {"));
  assert.ok(line, `no init report in ${JSON.stringify(logs)}`);
  return JSON.parse(line.slice(line.indexOf("init {") + 5));
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a client started the old way, with a provider that has nothing or none, gets its environment at spawn and no env in init", async () => {
  const asked: string[] = [];
  const nothing = (spec: mineLabs.LaunchScenarioClientOptions["client"], username: string) => (asked.push(`${username} ${spec.args.at(-1)}`), undefined);
  const { client, logs } = launch("idle", { env: { SPAWN_MARK: "from-spawn" }, clientProvider: nothing });
  await client.ready;
  assert.deepEqual(asked, ["Walker idle"]);
  const report = initReport(logs);
  assert.equal(report.hasEnv, false);
  assert.equal(report.spawned, "from-spawn");
  assert.equal(report.artifacts, "lane-artifacts");
  assert.ok(logs.includes("client 'Walker' stdout: boot stdout line"));
  assert.ok(logs.includes("client 'Walker' stderr: boot stderr line"));
  await client.stop("test complete");
});

test("a client booted earlier is handed over alive: init carries the lane environment, the boot output is replayed in order", async () => {
  const { client: spec } = clientSpec("idle");
  const ahead = mineLabs.spawnClientAhead(spec);
  await until(() => ahead.recentOutput().length >= 2, "the boot output");

  const { client, logs } = launch("idle", { env: { MINE_AI_ARENA: "lane-env", MINE_LABS_ARTIFACTS_DIR: "from-yaml" }, clientProvider: () => ahead });
  await client.ready;

  const report = initReport(logs);
  assert.deepEqual(report.env, { MINE_AI_ARENA: "lane-env", MINE_LABS_ARTIFACTS_DIR: "lane-artifacts" }, "the artifacts directory wins over the same name in client.env, as it does at spawn");
  const replayed = logs.filter((entry) => entry.includes("boot "));
  assert.equal(replayed.length, 2);
  assert.ok(replayed.includes("client 'Walker' stdout: boot stdout line"));
  assert.ok(replayed.includes("client 'Walker' stderr: boot stderr line"));
  assert.ok(logs.findIndex((entry) => entry.includes("boot ")) < logs.findIndex((entry) => entry.includes(": init {")), "replayed lines come before the answer to init");
  await client.stop("test complete");
});

test("a client that exited between the pick and the handover fails ready at once, naming its code and its stderr", async () => {
  const { client: spec } = clientSpec("exit:3");
  const ahead = mineLabs.spawnClientAhead(spec);
  await ahead.closed;

  const startedAt = Date.now();
  const { client } = launch("exit:3", { clientProvider: () => ahead });
  await assert.rejects(client.ready, /client .Walker. exited with code 3 before it was handed over: boot stderr line/u);
  assert.ok(Date.now() - startedAt < 2_000, `ready failed after ${Date.now() - startedAt} ms, not at once`);
  await client.stop("test complete");
});

test("a client that cannot be spawned fails ready with the spawn error", async () => {
  const ahead = mineLabs.spawnClientAhead({ command: "/nonexistent/mine-labs-client", args: [], env: {} });
  const { client } = launch("idle", { clientProvider: () => ahead });
  await assert.rejects(client.ready, /ENOENT/u);
});

test("output past the bound drops the oldest lines and says how many", async () => {
  const { client: spec } = clientSpec("flood:1000");
  const ahead = mineLabs.spawnClientAhead(spec);
  await ahead.closed;
  await until(() => ahead.recentOutput().some((entry) => entry.line === "boot stderr line"), "the last boot line");
  const kept = ahead.recentOutput();
  assert.ok(kept.length <= mineLabs.CLIENT_AHEAD_MAX_LINES, `${kept.length} lines kept`);
  assert.equal(kept.some((entry) => entry.line === "flood line 0"), false, "the oldest line is gone");
  assert.ok(kept.some((entry) => entry.line === "flood line 999"));

  const { client, logs } = launch("flood:1000", { clientProvider: () => ahead });
  await assert.rejects(client.ready, /exited with code 4 before it was handed over/u);
  assert.ok(logs.some((entry) => /\d+ earlier output lines? dropped/u.test(entry)), JSON.stringify(logs.slice(0, 3)));
});

test("a provider that throws fails the launch with the user's name and the cause", () => {
  assert.throws(
    () => launch("idle", { clientProvider: () => { throw new Error("pool is gone"); } }),
    /client 'Walker': the client provider failed: pool is gone/u,
  );
});

test("a client handed over alive that dies later fails ready like a client spawned on the spot", async () => {
  const { client: spec } = clientSpec("idle");
  const ahead = mineLabs.spawnClientAhead({ ...spec, args: [fixture, "die-on-init"] });
  await until(() => ahead.recentOutput().length >= 2, "the boot output");
  const { client } = launch("idle", { clientProvider: () => ahead });
  await assert.rejects(client.ready, /client .Walker. exited with code 5/u);
});

test("stop brings a handed-over client down", async () => {
  const { client: spec } = clientSpec("idle");
  const ahead = mineLabs.spawnClientAhead(spec);
  const { client } = launch("idle", { clientProvider: () => ahead });
  await client.ready;
  await client.stop("test complete");
  assert.notEqual(ahead.child.exitCode ?? ahead.child.signalCode, null);
});

test("a completion line longer than the kept tail reaches the trial whole, on the old path and on a handed-over client", async () => {
  for (const ahead of [false, true]) {
    const spawned = ahead ? mineLabs.spawnClientAhead(clientSpec("idle").client) : undefined;
    const { client, completions } = launch("idle", { clientProvider: spawned && (() => spawned) });
    await client.ready;
    client.arranged();
    await client.prepared;
    client.start();
    await until(() => completions.length > 0, `the completion (ahead ${ahead})`);
    assert.equal(completions[0]!.detail?.length, 3000, `ahead ${ahead}`);
    await client.stop("test complete");
  }
});

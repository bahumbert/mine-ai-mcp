import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as mineLabs from "mine-labs";
import type { ClientCompletion } from "mine-labs/client";

/**
 * The real client host, booted ahead of its trial and handed over (Mine Labs' `clientProvider`), or started the old way.
 * No Minecraft server runs: the host fails or stops before it needs one, or logs the refused connection.
 */
const CLIENT_HOST = join(import.meta.dirname, "client-host.ts");
const MARKER_DRIVER = (marker: string) => `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "loaded");
export async function run() { return { status: "succeeded" }; }
`;

let directory: string;
test.before(async () => {
  directory = await mkdtemp(join(tmpdir(), "client-host-test-"));
});
test.after(async () => {
  await rm(directory, { recursive: true, force: true });
});

function clientSpec(driver: string, env: Record<string, string> = {}) {
  return mineLabs.scenarioSchema.parse({
    name: "client-host-fixture",
    client: { command: process.execPath, args: [CLIENT_HOST, driver], env },
    players: [{ name: "Walker" }],
    goal: { kind: "completion", who: "Walker" },
  });
}

/** Launch the host on `driver`: `spawnEnv` at spawn, `launchEnv` as the scenario's client.env at the launch (init.env when ahead). */
function launch(driver: string, options: { ahead: boolean; spawnEnv?: Record<string, string>; launchEnv?: Record<string, string> }) {
  const logs: string[] = [];
  const completions: ClientCompletion[] = [];
  const { client } = clientSpec(driver, options.spawnEnv);
  const ahead = options.ahead ? mineLabs.spawnClientAhead(client) : undefined;
  const { client: launchClient, ...definition } = clientSpec(driver, options.launchEnv);
  const process_ = mineLabs.launchScenarioClient({
    client: launchClient, scenario: definition, host: "127.0.0.1", port: 1, username: "Walker", version: "1.21.4", artifactsDirectory: join(directory, "artifacts"),
    clientProvider: ahead && (() => ahead), log: (message) => logs.push(message), onChat: () => {}, onCompletion: (completion) => completions.push(completion),
  });
  process_.ready.catch(() => undefined);
  return { client: process_, ahead, logs, completions };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function writeDriver(name: string, source: string): Promise<string> {
  const file = join(directory, name);
  await writeFile(file, source);
  return file;
}

test("a host booted ahead has loaded its driver before init arrives", { timeout: 60_000 }, async () => {
  const marker = join(directory, "loaded-before-init");
  const driver = await writeDriver("marker-driver.ts", MARKER_DRIVER(marker));
  const spec = clientSpec(driver).client;
  const ahead = mineLabs.spawnClientAhead(spec);
  try {
    await until(() => existsSync(marker), "the driver import");
    assert.equal(ahead.child.exitCode, null, "the host waits for init after loading");
  } finally {
    ahead.child.kill();
  }
});

test("a driver import that fails reaches the trial as a failed completion once init arrives, booted ahead or not", { timeout: 60_000 }, async () => {
  const driver = await writeDriver("broken-driver.ts", `import "./does-not-exist.ts";\nexport async function run() { return { status: "succeeded" }; }\n`);
  for (const ahead of [false, true]) {
    const { client, completions } = launch(driver, { ahead });
    await until(() => completions.length > 0, `the completion (ahead ${ahead})`);
    assert.equal(completions[0]!.status, "failed");
    assert.match(completions[0]!.detail ?? "", /does-not-exist/u, `ahead ${ahead}`);
    await client.stop("test complete");
  }
});

test("a lane value in init.env wins over the one the host was spawned with, and the spawn value still serves a client without init.env", { timeout: 60_000 }, async () => {
  const driver = await writeDriver("arena-driver.ts", MARKER_DRIVER(join(directory, "arena-driver-loaded")));
  const lane = JSON.stringify({ x: 3, z: 4 });

  // Booted with a bad value, handed the lane's value in init.env: the host gets past the arena and reaches the absent server and fails there.
  const good = launch(driver, { ahead: true, spawnEnv: { MINE_AI_ARENA: "not json" }, launchEnv: { MINE_AI_ARENA: lane } });
  await until(() => good.completions.length > 0, "the refused connection");
  assert.match(good.completions[0]!.detail ?? "", /ECONNREFUSED/u, "the failure is the missing server, not the arena");
  await good.client.stop("test complete");

  // The old way: the env is the process's own, init has no env, and a bad value still fails the client as it always did.
  const old = launch(driver, { ahead: false, spawnEnv: { MINE_AI_ARENA: "not json" }, launchEnv: { MINE_AI_ARENA: "not json" } });
  await until(() => old.completions.length > 0, "the arena failure of the old path");
  assert.match(old.completions[0]!.detail ?? "", /JSON|Unexpected|parse/iu);
  await old.client.stop("test complete");
});

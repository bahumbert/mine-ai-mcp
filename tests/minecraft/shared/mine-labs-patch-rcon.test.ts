// Tests RCON transport-failure retention and propagation into trial results.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock } from "../../../src/test-support/fake-bot/fake-clock.js";
import { Rcon } from "../../../node_modules/mine-labs/src/server/rcon.ts";
import * as mineLabs from "mine-labs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function transport(execute: (command: string) => Promise<string | boolean>) {
  const rcon = new Rcon("localhost", 0, "test");
  let socketError: ((cause: unknown) => void) | undefined;
  Object.defineProperty(rcon, "client", { value: {
    execute, authenticate: async () => true, isConnected: () => true,
    connection: { on: (_event: string, listener: (cause: unknown) => void) => { socketError = listener; } },
  } });
  return { rcon, failSocket: () => socketError?.(new Error("socket closed")) };
}

test("counts a timed out command", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { rcon } = transport(() => new Promise(() => {}));
  const pending = rcon.command("test");
  await Promise.resolve();
  const rejected = assert.rejects(pending, /timed out/u);
  await clock.advance(10_000);
  await rejected;
  assert.equal(rcon.transportFailures, 1);
  assert.match(rcon.failureSince(0)!, /^rcon command timed out after/u);
});

test("records rejected writes, lost connections, and non-string replies", async () => {
  for (const answer of [new Error("Unable to write to socket"), false, "socket"] as const) {
    const { rcon, failSocket } = transport(async () => {
      if (answer instanceof Error) throw answer;
      return answer === "socket" ? "unused" : answer;
    });
    if (answer === "socket") { await rcon.connect(); failSocket(); }
    await assert.rejects(rcon.command("test"));
    assert.equal(rcon.transportFailures, 1);
    assert.match(rcon.failureSince(0)!, answer instanceof Error ? /Unable to write/u : answer === false ? /no text/u : /connection lost/u);
  }
});

test("a refused setup command is not a transport failure", async () => {
  const { rcon } = transport(async () => "0");
  await assert.rejects(rcon.executeChecked("test"), /setup command failed/u);
  assert.equal(rcon.transportFailures, 0);
  assert.equal(rcon.failureSince(0), null);
});

test("failureSince returns the first failure after the count, or the oldest retained", async () => {
  let count = 0;
  const { rcon } = transport(async () => { throw new Error(`failure ${++count}`); });
  for (let i = 0; i < 2; i++) await assert.rejects(rcon.command("test"));
  assert.equal(rcon.failureSince(0), "failure 1");
  assert.equal(rcon.failureSince(1), "failure 2");
  assert.equal(rcon.failureSince(2), null);
  for (let i = 2; i < 25; i++) await assert.rejects(rcon.command("test"));
  assert.equal(rcon.transportFailures, 25);
  assert.equal(rcon.failureSince(0), "failure 6");
  assert.equal(rcon.failureSince(24), "failure 25");
  assert.equal(rcon.failureSince(25), null);
});

test("trials retain transport failures through arrangement, goal polling and loss of the RCON reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "rcon-trial-"));
  try {
    for (const fail of [false, true]) {
      const { rcon } = transport(async () => { if (fail) throw new Error("write failed"); return "ok"; });
      const server = new mineLabs.MinecraftServer(
        { version: "1.21.4", host: "127.0.0.1", worldDir: root, gamePort: 0, rconPort: 0, rconPassword: "x", worldType: "flat", structures: false, operators: [] },
        "unused.jar", () => {}, { gamePort: 0, rconPort: 0, release() {} },
      );
      server.rcon = rcon;
      const scenario = mineLabs.scenarioSchema.parse({ name: "rcon", client: { command: "true" }, goal: { kind: "survive", seconds: 1 } });
      const result = await mineLabs.runScenarioTrial({ server, scenario, runDir: root, log: () => {}, onArranged: () => { server.rcon = undefined; throw new Error("stop trial"); } });
      if (fail) assert.equal(result.transportFailure, "write failed");
      else assert.equal("transportFailure" in result, false);
    }
    for (const mode of ["success", "failure", "lost"] as const) {
      const abort = new AbortController();
      let polled = false;
      const server = new mineLabs.MinecraftServer(
        { version: "1.21.4", host: "127.0.0.1", worldDir: root, gamePort: 1, rconPort: 0, rconPassword: "x", worldType: "flat", structures: false, operators: [] },
        "unused.jar", () => {}, { gamePort: 1, rconPort: 0, release() {} },
      );
      const { rcon } = transport(async (command) => {
        if (command !== "time query gametime") return "ok";
        polled = true;
        if (mode === "lost") server.rcon = undefined;
        abort.abort("poll complete");
        if (mode !== "success") throw new Error("goal poll write failed");
        return "The time is 100"; // Measured by the scenario-ticks audit, spec section 2.
      });
      Object.defineProperties(rcon, {
        executeChecked: { value: async () => "ok" },
        playerOnline: { value: async () => true },
        preparePlayerMetrics: { value: async () => {} },
      });
      server.rcon = rcon;
      const client = `const readline = require('node:readline'); readline.createInterface({input: process.stdin}).on('line', line => { const type = JSON.parse(line).type; if (type === 'init') console.log(JSON.stringify({type:'ready'})); if (type === 'arranged') console.log(JSON.stringify({type:'prepared'})); if (type === 'stop') process.exit(0); });`;
      const scenario = mineLabs.scenarioSchema.parse({ name: "rcon-goal", client: { command: process.execPath, args: ["-e", client] }, goal: { kind: "survive", seconds: 1 } });
      const result = await mineLabs.runScenarioTrial({ server, scenario, runDir: root, log: () => {}, signal: abort.signal });
      assert.equal(polled, true, "the trial reached its goal poll");
      if (mode === "success") assert.equal("transportFailure" in result, false);
      else assert.equal(result.transportFailure, "goal poll write failed");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

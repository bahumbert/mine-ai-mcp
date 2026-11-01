import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ollamaServeEnv } from "./install/ollama-serve.ts";
import { saveInstallState } from "./install/state.ts";
import { writeOtherAgents } from "./stack-bots.ts";
import { hostHealth, json, stackFixture, startedFixture, type StackFixture } from "./stack-test-support.ts";
import { bringUpStack, createStack, describeStack, realStackDeps, startBot, startStack, stopBot, stopStack } from "./stack.ts";

const otherAgentsPath = (fixture: StackFixture): string => join(fixture.root, "run", "other-agents.json");
const otherAgents = (fixture: StackFixture): string[] => (JSON.parse(readFileSync(otherAgentsPath(fixture), "utf8")) as { usernames: string[] }).usernames;

const argValues = (args: readonly string[], flag: string): string[] => args.flatMap((arg, i) => (args[i - 1] === flag ? [arg] : []));

test("starts Ollama, warms the model, starts the server, then host and brain of each bot, in that order", async () => {
  const { fixture } = await startedFixture();
  assert.deepEqual(
    fixture.events.filter((event, i, all) => event !== all[i - 1]),
    ["fetch GET /api/version", "spawn ollama", "fetch GET /api/version", "fetch POST /api/generate", "spawn server", "start chat commands", "spawn host-ayla", "fetch GET /health", "spawn brain-ayla"],
  );
  const warm = fixture.network.requests.find((request) => request.url.endsWith("/api/generate"))!;
  assert.deepEqual(JSON.parse(warm.body), { model: fixture.manifest.ollama.model, prompt: "", stream: false });
});

test("our Ollama gets the manifest env and its own host and port", async () => {
  const { fixture } = await startedFixture();
  const env = fixture.children.optionsOf("ollama").env;
  assert.equal(env.OLLAMA_HOST, `127.0.0.1:${fixture.manifest.ollama.port}`);
  for (const [key, value] of Object.entries(fixture.manifest.ollama.env)) assert.equal(env[key], value);
  assert.deepEqual(fixture.children.argsOf("ollama"), ["serve"]);
});

test("our Ollama serves the model store the install recorded, with the env ollamaServeEnv builds for the install steps too", async () => {
  const fixture = stackFixture();
  const state = { ollama: "installed", ollamaModels: join(fixture.root, "models") } as const;
  saveInstallState(fixture.root, state);
  hostHealth(fixture, 25_575);
  hostHealth(fixture, 25_576);
  await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  const env = fixture.children.optionsOf("ollama").env;
  assert.equal(env.OLLAMA_MODELS, join(fixture.root, "models"));
  assert.deepEqual(env, ollamaServeEnv(fixture.manifest, fixture.manifest.ollama.port, state));
});

test("the real stack dependencies look for ollama.exe where this data root's install recorded it", () => {
  const root = mkdtempSync(join(tmpdir(), "mine-ai-stack-deps-"));
  const exe = join(root, "Ollama é", "ollama.exe");
  mkdirSync(dirname(exe), { recursive: true });
  writeFileSync(exe, "");
  saveInstallState(root, { ollama: "installed", ollamaPath: exe });
  assert.equal(realStackDeps(() => {}, root).ollamaExe(), exe);
  rmSync(root, { recursive: true, force: true });
});

test("the server runs from the settings' memory with its console on a pipe", async () => {
  const { fixture } = await startedFixture();
  const { args, options } = { args: fixture.children.argsOf("server"), options: fixture.children.optionsOf("server") };
  assert.deepEqual(args, ["-Xms1G", "-Xmx4096M", "-jar", "server.jar", "nogui"]);
  assert.equal(options.stdin, "pipe");
  assert.ok(options.cwd.endsWith("server"));
});

test("a brain is spawned only after the health of its own host answers", async () => {
  const fixture = stackFixture();
  hostHealth(fixture, 25_575, 3);
  await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  const health = fixture.events.map((event, i) => (event === "fetch GET /health" ? i : -1)).filter((i) => i >= 0);
  assert.equal(health.length, 4);
  assert.ok(fixture.events.indexOf("spawn brain-ayla") > health[3]!);
});

test("host argv carries the server, the version, the persona's username, a port of its own and the data root", async () => {
  const { fixture } = await startedFixture();
  const args = fixture.children.argsOf("host-ayla");
  assert.ok(args[0]!.replaceAll("\\", "/").endsWith("src/server/host.ts"));
  assert.deepEqual(argValues(args, "--minecraft-host"), ["127.0.0.1"]);
  assert.deepEqual(argValues(args, "--minecraft-port"), ["25565"]);
  assert.deepEqual(argValues(args, "--version"), [fixture.manifest.minecraft.version]);
  assert.deepEqual(argValues(args, "--username"), ["Ayla"]);
  assert.deepEqual(argValues(args, "--instance-id"), ["ayla"]);
  assert.deepEqual(argValues(args, "--listen-port"), ["25575"]);
  assert.ok(argValues(args, "--data-root")[0]!.replaceAll("\\", "/").endsWith("bot-data"));
  assert.equal(fixture.children.spawns.find((call) => call.name === "host-ayla")!.cmd, "C:/MineAI/bun.exe");
});

test("a brain gets the other-agents file and no --other-agent, and takes the manifest's env and slots", async () => {
  const { fixture } = await startedFixture((settings) => ({ ...settings, bots: ["ayla", "brea"] }));
  const args = fixture.children.argsOf("brain-ayla");
  const file = join(fixture.root, "run", "other-agents.json");
  assert.deepEqual(argValues(args, "--other-agents-file"), [file]);
  assert.deepEqual(argValues(fixture.children.argsOf("brain-brea"), "--other-agents-file"), [file]);
  assert.deepEqual(argValues(args, "--other-agent"), []);
  assert.deepEqual(argValues(args, "--model-slots"), [String(fixture.manifest.brainModelSlots)]);
  const agent = argValues(args, "--agent")[0]!;
  assert.ok(agent.replaceAll("\\", "/").includes("personas/ayla.json=http://127.0.0.1:25575/mcp"));
  const env = fixture.children.optionsOf("brain-ayla").env;
  for (const [key, value] of Object.entries(fixture.manifest.brainEnv)) assert.equal(env[key], value);
  assert.equal(env.MINE_AI_LLM_BASE_URL, `${fixture.ollamaUrl}/v1`);
  assert.equal(env.MINE_AI_LLM_MODEL, fixture.settings.llm.model);
});

test("a remote endpoint gives the brain its URL, key and model, and Ollama is never started", async () => {
  const { fixture } = await startedFixture((settings) => ({ ...settings, llm: { kind: "remote", baseUrl: "https://api.example.test/v1", apiKey: "sk-1", model: "big-model" } }));
  const env = fixture.children.optionsOf("brain-ayla").env;
  assert.equal(env.MINE_AI_LLM_BASE_URL, "https://api.example.test/v1");
  assert.equal(env.MINE_AI_LLM_API_KEY, "sk-1");
  assert.equal(env.MINE_AI_LLM_MODEL, "big-model");
  assert.ok(!fixture.events.includes("spawn ollama"));
});

for (const [label, probe, expected] of [
  ["down", { up: false, detail: "Nothing is listening at far.example:25565" }, /Nothing is listening/u],
  ["another version", { up: true, versionOk: false, detail: "The server at far.example:25565 runs 1.20.1" }, /runs 1\.20\.1/u],
  ["online-mode", { up: true, versionOk: true, onlineMode: true, detail: "The server at far.example:25565 has online-mode on" }, /online-mode on/u],
  ["login refused", { up: true, versionOk: true, detail: "The server at far.example:25565 is up, but refused" }, /refused/u],
] as const) {
  test(`a remote server that is ${label}: one line, no host, no brain, no model loaded`, async () => {
    const fixture = stackFixture((settings) => ({ ...settings, server: { kind: "remote", host: "far.example", port: 25_565 } }));
    fixture.probe = probe;
    const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
    assert.match(state.problem ?? "", expected);
    assert.deepEqual(fixture.children.spawns, []);
    assert.equal(state.bots.size, 0);
    assert.ok(fixture.said.some((line) => expected.test(line)));
  });
}

test("a remote server that answers starts the bots against its address", async () => {
  const fixture = stackFixture((settings) => ({ ...settings, server: { kind: "remote", host: "far.example", port: 25_570 } }));
  hostHealth(fixture, 25_575);
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  assert.equal(state.problem, null);
  assert.deepEqual(argValues(fixture.children.argsOf("host-ayla"), "--minecraft-host"), ["far.example"]);
  assert.deepEqual(argValues(fixture.children.argsOf("host-ayla"), "--minecraft-port"), ["25570"]);
});

test("no server set: no bot, no model loaded, one line (not one per bot) says where to set one", async () => {
  const fixture = stackFixture((settings) => ({ ...settings, server: { kind: "none" }, bots: ["ayla", "brea"] }));
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  assert.equal(state.problem, null);
  assert.deepEqual(fixture.children.spawns, []);
  assert.equal(fixture.said.length, 1);
  assert.ok(fixture.said.some((line) => line.includes("settings.json") && line.includes("server")));
  // The file exists (the fixture's fake says so): today's line, not the missing-file one.
  assert.match(fixture.said[0]!, /^No Minecraft server is set, so no bot starts\./u);
  assert.equal(describeStack(state).settingsFound, true);
  const refused = await startBot(state, "ayla");
  assert.equal(refused.ok, false);
});

test("no settings file: the start names the path it read, starts nothing, and the status says the file was not found", async () => {
  const fixture = stackFixture((settings) => ({ ...settings, server: { kind: "none" } }));
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, { ...fixture.deps, settingsFileExists: () => false });
  assert.equal(state.problem, null);
  assert.deepEqual(fixture.children.spawns, []);
  assert.equal(fixture.said.length, 1);
  assert.ok(fixture.said[0]!.startsWith(`No settings file at ${join(fixture.root, "settings.json")}, so no bot starts.`), fixture.said[0]);
  assert.match(fixture.said[0]!, /configure --server-local/u);
  assert.equal(describeStack(state).settingsFound, false);
});

test("a host that never turns healthy is stopped and reported, and the other bots still start", async () => {
  const fixture = stackFixture((settings) => ({ ...settings, bots: ["ayla", "brea"] }));
  // Ayla's host is polled every 500 ms for the whole wait; Brea's host reuses the freed port and answers at once.
  hostHealth(fixture, 25_575, Math.ceil(fixture.manifest.waits.hostHealthMs / 500));
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  assert.ok(fixture.events.includes("stop host-ayla"));
  assert.ok(!fixture.events.includes("spawn brain-ayla"));
  assert.ok(fixture.events.includes("spawn brain-brea"));
  assert.ok(fixture.said.some((line) => line.includes("Ayla") && line.includes("host-ayla.log")));
  assert.deepEqual([...state.bots.keys()], ["brea"]);
  assert.ok(fixture.clock.time >= fixture.manifest.waits.hostHealthMs, "the wait ran to its limit before giving up");
});

test("a host that ends while starting is reported with its exit code, without waiting out the health timeout", async () => {
  const fixture = stackFixture();
  fixture.children.script("host-ayla", { exitsWith: 3 });
  hostHealth(fixture, 25_575, Number.MAX_SAFE_INTEGER);
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  assert.equal(state.bots.size, 0);
  assert.ok(fixture.said.some((line) => line.includes("code 3")));
  assert.ok(fixture.clock.time < fixture.manifest.waits.hostHealthMs, "an ended host is not waited for");
});

test("a persona file that is missing is reported by name and the other bots still start", async () => {
  const fixture = stackFixture((settings) => ({ ...settings, bots: ["ghost", "ayla"] }));
  hostHealth(fixture, 25_575);
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  assert.deepEqual([...state.bots.keys()], ["ayla"]);
  assert.ok(fixture.said.some((line) => line.includes("ghost") && line.includes("personas")));
});

// The stack comes up in order, so a failed step leaves exactly the earlier children, and Ollama (ours) is stopped.
for (const [label, arrange, problem, spawned] of [
  ["the server ending before it is ready: reports the log", (f: StackFixture) => f.children.script("server", { lines: ["Failed to bind to port 25565"], exitsWith: 1 }), [/Failed to bind to port 25565/u, /server\.log/u], ["ollama", "server"]],
  ["Ollama that does not answer in time: names its log file", (f: StackFixture) => f.network.route("GET", `${f.ollamaUrl}/api/version`, () => json({}, 503)), [/ollama\.log/u], ["ollama"]],
  ["a warm-up that fails: says what Ollama answered", (f: StackFixture) => f.network.route("POST", `${f.ollamaUrl}/api/generate`, () => json({ error: "model 'gemma4:12b' not found" }, 404)), [/not found/u, /install model/u], ["ollama"]],
] as const) {
  test(`${label}; Ollama is stopped and no later service starts`, async () => {
    const fixture = stackFixture();
    arrange(fixture);
    const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
    for (const pattern of problem) assert.match(state.problem ?? "", pattern);
    assert.deepEqual(fixture.children.spawns.map((call) => call.name), spawned);
    assert.ok(fixture.events.includes("stop ollama"));
  });
}

test("a warm-up whose connection breaks does not show Bun's hint for programmers to the player", async () => {
  const fixture = stackFixture();
  fixture.network.route("POST", `${fixture.ollamaUrl}/api/generate`, () => {
    throw new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");
  });
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  assert.match(state.problem ?? "", /\(The socket connection was closed unexpectedly\.\)/u);
  assert.doesNotMatch(state.problem ?? "", /verbose/u);
});

test("Ollama that is not installed: one line naming the install step, nothing started", async () => {
  const fixture = stackFixture();
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, { ...fixture.deps, ollamaExe: () => null });
  assert.match(state.problem ?? "", /install ollama/u);
  assert.deepEqual(fixture.children.spawns, []);
});

test("an Ollama already answering on our port is used as it is and never stopped", async () => {
  const fixture = stackFixture();
  fixture.network.route("GET", `${fixture.ollamaUrl}/api/version`, () => json({ version: "0.35.0" }));
  hostHealth(fixture, 25_575);
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  assert.ok(!fixture.events.includes("spawn ollama"));
  fixture.said.length = 0;
  await stopStack(state, "test");
  assert.ok(!fixture.said.some((line) => line.includes("Ollama")), "it did not stop that Ollama, so it does not say it did");
  assert.ok(!fixture.events.includes("stop ollama"));
  assert.ok(!fixture.network.requests.some((request) => request.body.includes("keep_alive")));
  assert.deepEqual(fixture.killed, []);
});

test("stopStack ends the brains, the hosts, then the server by its stop line, unloads the model, then ends Ollama", async () => {
  const { fixture, state } = await startedFixture((settings) => ({ ...settings, bots: ["ayla", "brea"] }));
  fixture.events.length = 0;
  await stopStack(state, "test");
  assert.deepEqual(
    fixture.events.filter((event) => event.startsWith("stop") || event.includes("/api/generate")),
    ["stop chat commands", "stop brain-ayla", "stop host-ayla", "stop brain-brea", "stop host-brea", "stop server", "fetch POST /api/generate", "stop ollama"],
  );
  assert.equal(fixture.children.stdinText.get("server"), "stop\n");
  assert.equal(fixture.children.stopOptions.get("server")!.timeoutMs, fixture.manifest.waits.serverStopMs);
  const unload = fixture.network.requests.filter((request) => request.url.endsWith("/api/generate")).at(-1)!;
  assert.deepEqual(JSON.parse(unload.body), { model: fixture.manifest.ollama.model, keep_alive: 0 });
});

test("the chat command sources start once the stack runs, before the first bot, and are kept on the state", async () => {
  const { fixture, state } = await startedFixture();
  const at = (event: string): number => fixture.events.indexOf(event);
  assert.ok(at("start chat commands") > at("spawn server"), "after the server is up");
  assert.ok(at("start chat commands") < at("spawn host-ayla"), "before the first bot, so its host is polled from the start");
  assert.equal(fixture.events.filter((event) => event === "start chat commands").length, 1);
  assert.notEqual(state.chatCommands, null);
});

test("no server set: no chat command source starts", async () => {
  const fixture = stackFixture((settings) => ({ ...settings, server: { kind: "none" } }));
  await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  assert.ok(!fixture.events.includes("start chat commands"));
});

test("a start that failed starts no chat command source", async () => {
  const fixture = stackFixture();
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, { ...fixture.deps, ollamaExe: () => null });
  assert.equal(state.phase, "failed");
  assert.ok(!fixture.events.includes("start chat commands"));
});

test("a stop asked while the stack starts keeps the chat command sources from starting", async () => {
  const fixture = stackFixture();
  const state = createStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  fixture.network.route("POST", `${fixture.ollamaUrl}/api/generate`, () => {
    void stopStack(state, "test");
    return json({ done: true });
  });
  await bringUpStack(state);
  await stopStack(state, "test");
  assert.ok(!fixture.events.includes("start chat commands"));
});

test("stopStack twice stops the chat command sources once", async () => {
  const { fixture, state } = await startedFixture();
  await Promise.all([stopStack(state, "test"), stopStack(state, "test")]);
  assert.equal(fixture.events.filter((event) => event === "stop chat commands").length, 1);
});

test("stopStack also ends the llama-server runner our Ollama left, and leaves another program's", async () => {
  const { fixture, state } = await startedFixture();
  const ollamaPid = fixture.children.pidOf("ollama");
  fixture.processes = [
    { pid: 900, parentPid: ollamaPid, image: "llama-server.exe" },
    { pid: 901, parentPid: 77, image: "llama-server.exe" },
    { pid: 902, parentPid: ollamaPid, image: "notepad.exe" },
  ];
  await stopStack(state, "test");
  assert.deepEqual(fixture.killed, [900]);
});

test("stopStack twice stops each child once", async () => {
  const { fixture, state } = await startedFixture();
  await Promise.all([stopStack(state, "test"), stopStack(state, "test")]);
  await stopStack(state, "test");
  assert.equal(fixture.events.filter((event) => event === "stop server").length, 1);
});

test("startBot while running: host port skips the control port and the running hosts; the other-agents file lists those that run", async () => {
  const fixture = stackFixture((settings) => ({ ...settings, bots: ["ayla"], controlPort: 25_576 }));
  hostHealth(fixture, 25_575);
  hostHealth(fixture, 25_577);
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  const outcome = await startBot(state, "brea");
  assert.deepEqual(outcome, { ok: true, message: "Brea is running (host port 25577)." });
  assert.deepEqual(argValues(fixture.children.argsOf("host-brea"), "--listen-port"), ["25577"]);
  assert.deepEqual(argValues(fixture.children.argsOf("brain-brea"), "--other-agents-file"), [join(fixture.root, "run", "other-agents.json")]);
  assert.deepEqual(otherAgents(fixture), ["Ayla", "Brea"]);
});

test("startBot twice for the same bot starts it once, even at the same moment", async () => {
  const fixture = stackFixture((settings) => ({ ...settings, bots: [] }));
  hostHealth(fixture, 25_575);
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  const [first, second] = await Promise.all([startBot(state, "ayla"), startBot(state, "ayla")]);
  assert.equal([first, second].filter((outcome) => outcome.ok).length, 1);
  assert.equal(fixture.children.spawns.filter((call) => call.name === "host-ayla").length, 1);
});

for (const [label, id] of [
  ["a persona without a file", "nobody"],
  ["a persona id that is a path", "..\\settings"],
] as const) {
  test(`startBot for ${label} says where the personas live and starts nothing`, async () => {
    const { fixture, state } = await startedFixture();
    const before = fixture.children.spawns.length;
    const outcome = await startBot(state, id);
    assert.equal(!outcome.ok && outcome.reason, "unknown-persona");
    assert.ok(!outcome.ok && outcome.message.includes("personas"));
    assert.equal(fixture.children.spawns.length, before);
  });
}

test("stopBot ends the brain then the host and frees the bot; a bot that does not run is no error", async () => {
  const { fixture, state } = await startedFixture();
  fixture.events.length = 0;
  assert.deepEqual(await stopBot(state, "ayla"), { ok: true, message: "Ayla stopped." });
  assert.deepEqual(fixture.events, ["stop brain-ayla", "stop host-ayla"]);
  assert.equal(state.bots.size, 0);
  const again = await stopBot(state, "ayla");
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.reason, "not-running");
});

test("a bot's brain that ends by itself is reported and the bot is marked ended", async () => {
  const { fixture, state } = await startedFixture();
  fixture.children.crash("brain-ayla", 1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(state.bots.get("ayla")!.status, "ended");
  assert.ok(fixture.said.some((line) => line.includes("Ayla") && line.includes("brain") && line.includes("code 1")));
});

test("describeStack gives the join address, the settings path and each bot", async () => {
  const { state } = await startedFixture();
  const status = describeStack(state);
  assert.equal(status.phase, "running");
  assert.equal(status.join, "localhost:25565");
  assert.deepEqual(status.bots.map((bot) => [bot.id, bot.username, bot.hostPort, bot.status]), [["ayla", "Ayla", 25_575, "running"]]);
  assert.ok(status.settingsPath.endsWith("settings.json"));
  await stopStack(state, "test");
  assert.equal(describeStack(state).phase, "stopped");
});

test("the phase is starting while the stack comes up, so the control server can answer", async () => {
  const fixture = stackFixture();
  hostHealth(fixture, 25_575);
  const state = createStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  assert.equal(describeStack(state).phase, "starting");
  await bringUpStack(state);
  assert.equal(describeStack(state).phase, "running");
});

test("after a start that failed, a bot start is refused with the problem and starts nothing", async () => {
  const fixture = stackFixture();
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, { ...fixture.deps, ollamaExe: () => null });
  assert.equal(describeStack(state).phase, "failed");
  const outcome = await startBot(state, "ayla");
  assert.equal(!outcome.ok && outcome.reason, "not-ready");
  assert.match(outcome.message, /install ollama/u);
  assert.deepEqual(fixture.children.spawns, []);
});

test("a bot start asked while the services are still starting is refused", async () => {
  const fixture = stackFixture();
  const state = createStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  const outcome = await startBot(state, "ayla");
  assert.equal(!outcome.ok && outcome.reason, "not-ready");
  assert.match(outcome.message, /starting/u);
});

test("a stop asked while the model loads starts no server, host or brain afterwards and is no failed start", async () => {
  const fixture = stackFixture();
  hostHealth(fixture, 25_575);
  const state = createStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  let stopping: Promise<void> = Promise.resolve();
  fixture.network.route("POST", `${fixture.ollamaUrl}/api/generate`, () => {
    stopping = stopStack(state, "mine-ai stop");
    return json({ done: true });
  });
  await bringUpStack(state);
  await stopping;
  assert.ok(!fixture.events.includes("spawn server"));
  assert.ok(!fixture.events.includes("spawn host-ayla"));
  assert.equal(state.problem, null);
  assert.ok(fixture.events.includes("stop ollama"));
  // The start's own cleanup ended Ollama before the stop got to it: the stop says only that it began and ended.
  const stopLines = fixture.said.slice(fixture.said.indexOf("Stopping Mine AI (mine-ai stop)..."));
  assert.equal(stopLines.length, 2, stopLines.join(" | "));
  assert.match(stopLines[1]!, /^Mine AI stopped \(\d+ s\)\.$/u);
});

test("a stop asked while a host is still starting ends the start at once and leaves nothing running", async () => {
  const fixture = stackFixture();
  const state = createStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  let polls = 0;
  let stopping: Promise<void> = Promise.resolve();
  fixture.network.route("GET", "http://127.0.0.1:25575/health", () => {
    if (++polls === 2) stopping = stopStack(state, "test");
    return json({}, 503);
  });
  await bringUpStack(state);
  await stopping;
  assert.equal(describeStack(state).phase, "stopped");
  assert.ok(!fixture.events.includes("spawn brain-ayla"));
  assert.ok(fixture.events.includes("stop host-ayla"));
  assert.ok(fixture.events.includes("stop server"));
  assert.ok(fixture.events.includes("stop ollama"));
  assert.ok(fixture.clock.time < fixture.manifest.waits.hostHealthMs);
});

test("other-agents.json lists starting and running bots: it is written before each brain spawn and holds the bot being started", async () => {
  const fixture = stackFixture((settings) => ({ ...settings, bots: ["ayla", "brea"] }));
  hostHealth(fixture, 25_575);
  hostHealth(fixture, 25_576);
  const seen = new Map<string, string[]>();
  const spawn = fixture.children.spawn.bind(fixture.children);
  fixture.children.spawn = (name, ...rest) => {
    if (name.startsWith("brain-")) seen.set(name, otherAgents(fixture));
    return spawn(name, ...rest);
  };
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  assert.deepEqual(seen.get("brain-ayla"), ["Ayla"]);
  assert.deepEqual(seen.get("brain-brea"), ["Ayla", "Brea"]);
  assert.deepEqual(otherAgents(fixture), ["Ayla", "Brea"]);
  assert.equal(state.listenerJoined, null);
});

test("a stopping bot is still listed while its processes end, and a stopped bot leaves the file", async () => {
  const { fixture, state } = await startedFixture((settings) => ({ ...settings, bots: ["ayla", "brea"] }));
  const seen: string[][] = [];
  const stop = fixture.children.stop.bind(fixture.children);
  fixture.children.stop = (name, options) => {
    if (name === "brain-ayla") seen.push(otherAgents(fixture));
    return stop(name, options);
  };
  await stopBot(state, "ayla");
  assert.deepEqual(seen, [["Ayla", "Brea"]]);
  assert.deepEqual(otherAgents(fixture), ["Brea"]);
});

test("a bot that ends by itself and a bot whose host never turned healthy are not in the file", async () => {
  const fixture = stackFixture((settings) => ({ ...settings, bots: ["ayla", "brea"] }));
  hostHealth(fixture, 25_575);
  hostHealth(fixture, 25_576);
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  fixture.children.crash("brain-ayla", 1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(state.bots.get("ayla")!.status, "ended");
  assert.deepEqual(otherAgents(fixture), ["Brea"]);
  const failing = stackFixture();
  failing.children.script("host-ayla", { exitsWith: 3 });
  hostHealth(failing, 25_575, Number.MAX_SAFE_INTEGER);
  await startStack(failing.settings, failing.manifest, failing.children, failing.root, failing.deps);
  assert.deepEqual(otherAgents(failing), []);
});

test("the listener name is listed only while listenerJoined is set, or when the caller passes it", async () => {
  const { fixture, state } = await startedFixture();
  assert.deepEqual(otherAgents(fixture), ["Ayla"]);
  state.listenerJoined = "MineAI";
  writeOtherAgents(state);
  assert.deepEqual(otherAgents(fixture), ["Ayla", "MineAI"]);
  state.listenerJoined = null;
  writeOtherAgents(state);
  assert.deepEqual(otherAgents(fixture), ["Ayla"]);
  writeOtherAgents(state, "Scout");
  assert.deepEqual(otherAgents(fixture), ["Ayla", "Scout"]);
  assert.throws(() => readFileSync(`${otherAgentsPath(fixture)}.tmp`), /ENOENT/u, "the file is replaced through a temporary file that is gone");
});

test("the host gets --chat-command-prefix with the settings' prefix when commands are enabled, and none when they are off", async () => {
  const on = await startedFixture();
  assert.deepEqual(argValues(on.fixture.children.argsOf("host-ayla"), "--chat-command-prefix"), ["!"]);
  const custom = await startedFixture((settings) => ({ ...settings, commands: { ...settings.commands, prefix: "?" } }));
  assert.deepEqual(argValues(custom.fixture.children.argsOf("host-ayla"), "--chat-command-prefix"), ["?"]);
  const off = await startedFixture((settings) => ({ ...settings, commands: { ...settings.commands, enabled: false } }));
  assert.ok(!off.fixture.children.argsOf("host-ayla").includes("--chat-command-prefix"));
});

test("startBot for a bot that is stopping says it is stopping, not running", async () => {
  const { state } = await startedFixture();
  state.bots.get("ayla")!.status = "stopping";
  const outcome = await startBot(state, "ayla");
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /Ayla is stopping/u);
  assert.doesNotMatch(outcome.message, /running/u);
});

test("stopBot for a bot that does not run names its username, and for a stopping bot says it is already stopping", async () => {
  const { state } = await startedFixture();
  assert.deepEqual(await stopBot(state, "brea"), { ok: false, reason: "not-running", message: "Brea is not running." });
  state.bots.get("ayla")!.status = "stopping";
  const stopping = await stopBot(state, "ayla");
  assert.equal(!stopping.ok && stopping.reason, "not-running");
  assert.equal(stopping.message, "Ayla is already stopping.");
});

test("a bot is found by id or by username without case, and keyed by its persona id", async () => {
  const { state } = await startedFixture((settings) => ({ ...settings, bots: [] }));
  assert.equal((await startBot(state, "BREA")).ok, true);
  assert.deepEqual([...state.bots.keys()], ["brea"]);
  assert.equal((await startBot(state, "Brea")).ok, false);
});

test("a persona file whose id the settings rule refuses (a hidden file) is no bot, though it holds a username", async () => {
  const { fixture, state } = await startedFixture();
  writeFileSync(join(fixture.root, "personas", ".hidden.json"), JSON.stringify({ username: "Hidden" }));
  for (const name of [".hidden", "Hidden"]) {
    const outcome = await startBot(state, name);
    assert.equal(!outcome.ok && outcome.reason, "unknown-persona", name);
  }
  assert.deepEqual([...state.bots.keys()], ["ayla"]);
});

test("a list that cannot be written is said to the player with its path and never stops a bot from starting", async () => {
  const fixture = stackFixture();
  hostHealth(fixture, 25_575);
  writeFileSync(join(fixture.root, "run"), "a file where the folder should be");
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  assert.equal(state.bots.get("ayla")?.status, "running");
  assert.ok(fixture.said.some((line) => line.includes("other-agents.json") && line.includes("may answer")));
});

test("an unwritable list is said once per failed state, says brains started since have no list, and a later success re-arms the line", async () => {
  const fixture = stackFixture((settings) => ({ ...settings, bots: ["ayla", "brea"] }));
  hostHealth(fixture, 25_575);
  hostHealth(fixture, 25_576);
  writeFileSync(join(fixture.root, "run"), "a file where the folder should be");
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  const lines = () => fixture.said.filter((line) => line.includes("other-agents.json"));
  assert.equal(lines().length, 1, "one line, not one per status change");
  assert.match(lines()[0]!, /answer each other/u);
  assert.match(lines()[0]!, /Delete or fix .*run, then stop and start the bots/u);
  rmSync(join(fixture.root, "run"));
  writeOtherAgents(state);
  assert.deepEqual(otherAgents(fixture), ["Ayla", "Brea"]);
  rmSync(join(fixture.root, "run"), { recursive: true });
  writeFileSync(join(fixture.root, "run"), "a file again");
  writeOtherAgents(state);
  assert.equal(lines().length, 2, "a new failure after a success is said again");
});

test("a running bot is stopped by its id although its persona file is gone and another persona's username spells that id", async () => {
  const { fixture, state } = await startedFixture();
  unlinkSync(join(fixture.root, "personas", "ayla.json"));
  writeFileSync(join(fixture.root, "personas", "zed.json"), JSON.stringify({ username: "ayla" }));
  const outcome = await stopBot(state, "ayla");
  assert.equal(outcome.ok, true, outcome.message);
  assert.equal(state.bots.size, 0);
});

test("a persona that exists but is refused says why, and the text never claims the file is missing", async () => {
  const { fixture, state } = await startedFixture();
  writeFileSync(join(fixture.root, "personas", ".hidden.json"), JSON.stringify({ username: "Hidden" }));
  writeFileSync(join(fixture.root, "personas", "dash.json"), JSON.stringify({ username: "Ayla-1" }));
  for (const name of [".hidden", "Ayla-1", "nobody"]) {
    const outcome = await startBot(state, name);
    assert.ok(!outcome.ok && outcome.reason === "unknown-persona", name);
    assert.match(outcome.message, /id or username/u);
    assert.match(outcome.message, /must not start with a dot/u);
    assert.doesNotMatch(outcome.message, /has no .*\.json/u);
  }
});

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { UsageError } from "./cli-context.ts";
import { cliContext } from "./cli-test-support.ts";
import { runConfigureCommand } from "./configure-command.ts";
import { loadManifest } from "./manifest.ts";

function setup() {
  const t = cliContext("configure");
  const settings = (): Record<string, any> => JSON.parse(readFileSync(join(t.root, "settings.json"), "utf8"));
  return { ...t, settings };
}

const GIB = 1024 ** 3;

test("--server-remote then --llm-remote leave both in settings.json and keep unknown keys", async () => {
  const t = setup();
  writeFileSync(join(t.root, "settings.json"), JSON.stringify({ note: "mine", server: { kind: "none", comment: "kept?" } }));
  assert.equal(await runConfigureCommand(["--server-remote", "play.example", "25570"], t.context), 0);
  assert.equal(await runConfigureCommand(["--llm-remote", "https://api.example.test/v1", "sk-1", "big-model"], t.context), 0);
  const saved = t.settings();
  assert.deepEqual(saved.server, { kind: "remote", host: "play.example", port: 25_570 });
  assert.deepEqual(saved.llm, { kind: "remote", baseUrl: "https://api.example.test/v1", apiKey: "sk-1", model: "big-model" });
  assert.equal(saved.note, "mine");
  assert.deepEqual(saved.bots, loadManifest().defaultBots);
});

test("the installer's combined call (the way the .iss builds it) sets the model and the server at once", async () => {
  const t = setup();
  assert.equal(await runConfigureCommand(["--llm-remote", "http://localhost:1234/v1", "", "local-model", "--server-remote", "10.0.0.5", "25565"], t.context), 0);
  assert.equal(t.settings().llm.apiKey, "");
  assert.equal(t.settings().server.host, "10.0.0.5");
});

test("--llm-local sets the manifest's model and drops a remote endpoint", async () => {
  const t = setup();
  await runConfigureCommand(["--llm-remote", "https://x.test/v1", "k", "m"], t.context);
  await runConfigureCommand(["--llm-local"], t.context);
  assert.deepEqual(t.settings().llm, { kind: "local", model: loadManifest().ollama.model });
});

test("--server-local sets the heap from the machine's RAM with the manifest's rule, on the default port", async () => {
  const t = setup();
  assert.equal(await runConfigureCommand(["--server-local"], t.context, { totalRamBytes: () => 32 * GIB }), 0);
  const { min, perRamGb, max } = loadManifest().minecraft.memoryMb;
  assert.deepEqual(t.settings().server, { kind: "local", port: 25_565, memoryMb: Math.min(max, Math.max(min, perRamGb * 32)) });
});

test("--server-local keeps the port an earlier local server already had", async () => {
  const t = setup();
  writeFileSync(join(t.root, "settings.json"), JSON.stringify({ server: { kind: "local", port: 25_570, memoryMb: 2048 } }));
  await runConfigureCommand(["--server-local"], t.context, { totalRamBytes: () => 8 * GIB });
  assert.equal(t.settings().server.port, 25_570);
});

test("--server-none sets no server and prints where the settings were saved", async () => {
  const t = setup();
  await runConfigureCommand(["--server-remote", "h", "1"], t.context);
  t.out.length = 0;
  await runConfigureCommand(["--server-none"], t.context);
  assert.deepEqual(t.settings().server, { kind: "none" });
  assert.match(t.out.join("\n"), /settings\.json/u);
});

test("arguments that make no sense are usage errors and write nothing", async () => {
  const t = setup();
  for (const args of [
    [],
    ["--llm-local", "--llm-remote", "https://x.test/v1", "k", "m"],
    ["--server-none", "--server-local"],
    ["--llm-remote", "https://x.test/v1", "k"],
    ["--llm-remote", "not-a-url", "k", "m"],
    ["--llm-remote", "https://x.test/v1", "k", ""],
    ["--server-remote", "host"],
    ["--server-remote", "host", "70000"],
    ["--server-remote", "host", "abc"],
    ["--server-remote", "", "25565"],
    ["--bogus"],
  ]) {
    await assert.rejects(runConfigureCommand(args, t.context), UsageError, JSON.stringify(args));
  }
  assert.throws(() => readFileSync(join(t.root, "settings.json")), /ENOENT/u);
});

test("a settings file that is invalid is reported with its path and left as it is", async () => {
  const t = setup();
  writeFileSync(join(t.root, "settings.json"), "{ not json");
  assert.equal(await runConfigureCommand(["--server-none"], t.context), 1);
  assert.match(t.out.join("\n"), /settings\.json is invalid/u);
  assert.equal(readFileSync(join(t.root, "settings.json"), "utf8"), "{ not json");
});

test("--command-players writes the names, keeps the rest and unknown keys of commands, and an empty string clears them", async () => {
  const t = setup();
  writeFileSync(join(t.root, "settings.json"), JSON.stringify({ commands: { prefix: "?", note: "kept" } }));
  assert.equal(await runConfigureCommand(["--command-players", "Tom, Dara_2"], t.context), 0);
  assert.deepEqual(t.settings().commands, { enabled: true, prefix: "?", players: ["Tom", "Dara_2"], listenerName: "MineAI", note: "kept" });
  assert.equal(await runConfigureCommand(["--command-players", ""], t.context), 0);
  assert.deepEqual(t.settings().commands.players, []);
  assert.equal(await runConfigureCommand(["--server-remote", "play.example", "25570", "--command-players", "Tom"], t.context), 0);
  assert.equal(t.settings().server.host, "play.example");
  assert.deepEqual(t.settings().commands.players, ["Tom"]);
});

test("--command-players with a bad name, a missing value or given twice is a usage error and writes nothing", async () => {
  const t = setup();
  for (const args of [["--command-players"], ["--command-players", "Tom Dara"], ["--command-players", "ab"], ["--command-players", "a/b"], ["--command-players", "Tom", "--command-players", "Dara"]]) {
    await assert.rejects(runConfigureCommand(args, t.context), UsageError, JSON.stringify(args));
  }
  assert.throws(() => readFileSync(join(t.root, "settings.json")), /ENOENT/u);
});

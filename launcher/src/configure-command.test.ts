import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UsageError } from "./cli-context.ts";
import { cliContext } from "./cli-test-support.ts";
import { runConfigureCommand } from "./configure-command.ts";
import { fakeKeyCipher, unreadingCipher } from "./key-cipher-test-support.ts";
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
  const clearKeys = { totalRamBytes: () => 8 * GIB, settings: { platform: "linux", cipher: null } } as const; // the form on any system the tests run on
  assert.equal(await runConfigureCommand(["--server-remote", "play.example", "25570"], t.context, clearKeys), 0);
  assert.equal(await runConfigureCommand(["--llm-remote", "https://api.example.test/v1", "sk-1", "big-model"], t.context, clearKeys), 0);
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
  assert.deepEqual(t.settings().server, { kind: "local", port: 25_565, memoryMb: Math.min(max, Math.max(min, perRamGb * 32)), program: "paper" });
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

test("--check-updates on and off write settings.checkUpdates", async () => {
  const t = setup();
  assert.equal(await runConfigureCommand(["--check-updates", "off"], t.context), 0);
  assert.equal(t.settings().checkUpdates, false);
  assert.equal(await runConfigureCommand(["--check-updates", "on"], t.context), 0);
  assert.equal(t.settings().checkUpdates, true);
});

test("--check-updates with a missing value, a value other than on or off, or given twice is a usage error naming the problem, and writes nothing", async () => {
  const t = setup();
  const cases: [string[], string][] = [
    [["--check-updates"], "--check-updates needs 1 values. configure takes"],
    [["--check-updates", "maybe"], '--check-updates takes on or off, not "maybe". configure takes'],
    [["--check-updates", "on", "--check-updates", "off"], "Give --check-updates only once. configure takes"],
  ];
  for (const [args, message] of cases) {
    await assert.rejects(runConfigureCommand(args, t.context), (error: Error) => error instanceof UsageError && error.message.startsWith(message), JSON.stringify(args));
  }
  assert.throws(() => readFileSync(join(t.root, "settings.json")), /ENOENT/u);
});

test("--llm-local, --server-none and --check-updates off in one call are all saved", async () => {
  const t = setup();
  assert.equal(await runConfigureCommand(["--llm-local", "--server-none", "--check-updates", "off"], t.context), 0);
  assert.deepEqual(t.settings().llm, { kind: "local", model: loadManifest().ollama.model });
  assert.deepEqual(t.settings().server, { kind: "none" });
  assert.equal(t.settings().checkUpdates, false);
});

test("--check-updates off alone keeps a saved remote endpoint and its key", async () => {
  const t = setup();
  writeFileSync(join(t.root, "settings.json"), JSON.stringify({ llm: { kind: "remote", baseUrl: "https://x.test/v1", apiKey: "sk-keep", model: "m" } }));
  assert.equal(await runConfigureCommand(["--check-updates", "off"], t.context, { totalRamBytes: () => 8 * GIB, settings: { platform: "linux", cipher: null } }), 0);
  assert.deepEqual(t.settings().llm, { kind: "remote", baseUrl: "https://x.test/v1", apiKey: "sk-keep", model: "m" });
  assert.equal(t.settings().checkUpdates, false);
});

// The API key (plan 2026-11-06-installer-improvements T2, spec D3): a fake Windows with a fake cipher.
function onWindows() {
  const t = setup();
  const deps = { totalRamBytes: () => 8 * GIB, settings: { platform: "win32" as const, cipher: fakeKeyCipher() } };
  const run = (...args: string[]) => runConfigureCommand(args, t.context, deps);
  return { ...t, run };
}

test("--llm-remote-saved-key changes the URL and the model and writes the saved blob back as it is", async () => {
  const t = onWindows();
  assert.equal(await t.run("--llm-remote", "https://old.test/v1", "sk-saved", "old-model"), 0);
  const blob = t.settings().llm.apiKeyProtected;
  assert.equal(await t.run("--llm-remote-saved-key", "https://new.test/v1", "new-model", "--server-remote", "h", "25565"), 0);
  assert.deepEqual(t.settings().llm, { kind: "remote", baseUrl: "https://new.test/v1", model: "new-model", apiKeyProtected: blob });
  assert.equal(t.settings().server.host, "h");
});

test("--llm-remote-saved-key with no saved key is a usage error naming --llm-remote, and writes nothing", async () => {
  const t = onWindows();
  await assert.rejects(t.run("--llm-remote-saved-key", "https://x.test/v1", "m"), (error: Error) => error instanceof UsageError && error.message.startsWith("No API key is saved: use --llm-remote <url> <key> <model>."));
  assert.throws(() => readFileSync(join(t.root, "settings.json")), /ENOENT/u);
  assert.equal(await t.run("--llm-remote", "https://x.test/v1", "", "m"), 0);
  const before = readFileSync(join(t.root, "settings.json"), "utf8");
  await assert.rejects(t.run("--llm-remote-saved-key", "https://y.test/v1", "m"), UsageError);
  assert.equal(readFileSync(join(t.root, "settings.json"), "utf8"), before);
});

test("--llm-remote-saved-key on a key this PC cannot read says so and leaves the file as it is", async () => {
  const t = setup();
  const text = JSON.stringify({ llm: { kind: "remote", baseUrl: "https://x.test/v1", model: "m", apiKeyProtected: "QUJD" } });
  writeFileSync(join(t.root, "settings.json"), text);
  const deps = { totalRamBytes: () => 8 * GIB, settings: { platform: "win32" as const, cipher: unreadingCipher } };
  await assert.rejects(runConfigureCommand(["--llm-remote-saved-key", "https://y.test/v1", "m"], t.context, deps), (error: Error) => error instanceof UsageError && /cannot be read here/u.test(error.message) && error.message.includes("--llm-remote <url> <key> <model>"));
  assert.equal(readFileSync(join(t.root, "settings.json"), "utf8"), text);
});

test("--llm-remote-saved-key needs a URL and a model like --llm-remote does", async () => {
  const t = onWindows();
  await t.run("--llm-remote", "https://x.test/v1", "sk-saved", "m");
  for (const args of [["--llm-remote-saved-key", "https://x.test/v1"], ["--llm-remote-saved-key", "not-a-url", "m"], ["--llm-remote-saved-key", "https://x.test/v1", ""], ["--llm-remote-saved-key", "https://x.test/v1", "m", "--llm-local"]]) {
    await assert.rejects(t.run(...args), UsageError, JSON.stringify(args));
  }
});

test("--server-local on a file whose key cannot be read keeps the blob as it was", async () => {
  const t = setup();
  writeFileSync(join(t.root, "settings.json"), JSON.stringify({ llm: { kind: "remote", baseUrl: "https://x.test/v1", model: "m", apiKeyProtected: "QUJD" } }));
  const deps = { totalRamBytes: () => 8 * GIB, settings: { platform: "win32" as const, cipher: unreadingCipher } };
  assert.equal(await runConfigureCommand(["--server-local"], t.context, deps), 0);
  assert.deepEqual(t.settings().llm, { kind: "remote", baseUrl: "https://x.test/v1", model: "m", apiKeyProtected: "QUJD" });
});

test("--llm-remote on a file whose key cannot be read replaces it with the new key", async () => {
  const t = setup();
  writeFileSync(join(t.root, "settings.json"), JSON.stringify({ llm: { kind: "remote", baseUrl: "https://x.test/v1", model: "m", apiKeyProtected: "QUJD" } }));
  const cipher = fakeKeyCipher();
  const deps = { totalRamBytes: () => 8 * GIB, settings: { platform: "win32" as const, cipher: { protect: cipher.protect, unprotect: unreadingCipher.unprotect } } };
  assert.equal(await runConfigureCommand(["--llm-remote", "https://x.test/v1", "sk-new", "m"], t.context, deps), 0);
  assert.notEqual(t.settings().llm.apiKeyProtected, "QUJD");
  assert.equal("keyUnreadable" in t.settings().llm, false);
});

test("a save that encrypts a key found in clear says so once, naming the file and the Windows user", async () => {
  const t = onWindows();
  writeFileSync(join(t.root, "settings.json"), JSON.stringify({ llm: { kind: "remote", baseUrl: "https://x.test/v1", model: "m", apiKey: "sk-old" } }));
  assert.equal(await t.run("--server-none"), 0);
  const said = t.out.filter((line) => line.includes("is now encrypted"));
  assert.deepEqual(said, [`The API key in ${join(t.root, "settings.json")} is now encrypted for the Windows user ${userInfo().username}; it no longer appears in clear in the file.`]);
  assert.equal(readFileSync(join(t.root, "settings.json"), "utf8").includes("sk-old"), false);
  t.out.length = 0;
  assert.equal(await t.run("--server-none"), 0);
  assert.equal(t.out.some((line) => line.includes("encrypted")), false);
});

test("--llm-remote with a new key over a key in clear says nothing about encryption: the player just gave the new one", async () => {
  const t = onWindows();
  writeFileSync(join(t.root, "settings.json"), JSON.stringify({ llm: { kind: "remote", baseUrl: "https://x.test/v1", model: "m", apiKey: "sk-old" } }));
  await t.run("--llm-remote", "https://x.test/v1", "sk-new", "m");
  assert.equal(t.out.some((line) => line.includes("encrypted")), false);
});

const LOCAL_8GB = { totalRamBytes: () => 8 * GIB, settings: { platform: "linux", cipher: null } } as const;

function writeServerSetting(t: ReturnType<typeof setup>, server: Record<string, unknown>): string {
  const text = JSON.stringify({ server });
  writeFileSync(join(t.root, "settings.json"), text);
  return text;
}

test("--server-local on settings without a local server writes paper", async () => {
  const t = setup();
  assert.equal(await runConfigureCommand(["--server-local"], t.context, LOCAL_8GB), 0);
  assert.equal(t.settings().server.program, "paper");
});

test("--server-local keeps the program of an existing local server", async () => {
  const t = setup();
  writeServerSetting(t, { kind: "local", port: 25_565, memoryMb: 2048, program: "vanilla" });
  assert.equal(await runConfigureCommand(["--server-local"], t.context, LOCAL_8GB), 0);
  assert.equal(t.settings().server.program, "vanilla");
  writeServerSetting(t, { kind: "local", port: 25_565, memoryMb: 2048 }); // a file of an earlier launcher: no program is vanilla
  assert.equal(await runConfigureCommand(["--server-local"], t.context, LOCAL_8GB), 0);
  assert.equal(t.settings().server.program, "vanilla");
});

test("--server-program vanilla sets it", async () => {
  const t = setup();
  writeServerSetting(t, { kind: "local", port: 25_570, memoryMb: 2048, program: "paper" });
  assert.equal(await runConfigureCommand(["--server-program", "vanilla"], t.context, LOCAL_8GB), 0);
  assert.deepEqual(t.settings().server, { kind: "local", port: 25_570, memoryMb: 2048, program: "vanilla" });
});

test("--server-local with --server-program in one call sets the chosen program on a new local server", async () => {
  const t = setup();
  assert.equal(await runConfigureCommand(["--server-local", "--server-program", "vanilla"], t.context, LOCAL_8GB), 0);
  assert.equal(t.settings().server.program, "vanilla");
});

test("--server-program without a local server (remote, none, no file, or --server-remote/--server-none in the same call) is refused, names --server-local and writes nothing", async () => {
  const remote = { kind: "remote", host: "play.example", port: 25_565 };
  const rows: { saved: Record<string, unknown> | null; args: string[] }[] = [
    { saved: remote, args: ["--server-program", "paper"] },
    { saved: { kind: "none" }, args: ["--server-program", "paper"] },
    { saved: null, args: ["--server-program", "paper"] },
    { saved: { kind: "none" }, args: ["--server-remote", "play.example", "25565", "--server-program", "paper"] },
    { saved: remote, args: ["--server-none", "--server-program", "paper"] },
  ];
  for (const { saved, args } of rows) {
    const t = setup();
    const before = saved === null ? null : writeServerSetting(t, saved);
    await assert.rejects(runConfigureCommand(args, t.context, LOCAL_8GB), (error: unknown) => error instanceof UsageError && /--server-local/u.test(error.message), JSON.stringify({ saved, args }));
    if (before === null) assert.throws(() => readFileSync(join(t.root, "settings.json")), /ENOENT/u);
    else assert.equal(readFileSync(join(t.root, "settings.json"), "utf8"), before);
  }
});

test("--server-program bogus is refused naming both values; a missing or repeated one is a usage error; nothing is written", async () => {
  const t = setup();
  const before = writeServerSetting(t, { kind: "local", port: 25_565, memoryMb: 2048, program: "paper" });
  await assert.rejects(runConfigureCommand(["--server-program", "bogus"], t.context, LOCAL_8GB), (error: unknown) => error instanceof UsageError && /"bogus"/u.test(error.message) && /paper/u.test(error.message) && /vanilla/u.test(error.message));
  await assert.rejects(runConfigureCommand(["--server-program"], t.context, LOCAL_8GB), UsageError);
  await assert.rejects(runConfigureCommand(["--server-program", "paper", "--server-program", "vanilla"], t.context, LOCAL_8GB), UsageError);
  assert.equal(readFileSync(join(t.root, "settings.json"), "utf8"), before);
});

test("going to vanilla from paper or from no local server on a world that ran on Paper is refused with the Nether and End folders named, settings unchanged", async () => {
  const paper = { kind: "local", port: 25_565, memoryMb: 2048, program: "paper" };
  const rows = [
    { folder: "world_nether", saved: paper, args: ["--server-program", "vanilla"] },
    { folder: "world_the_end", saved: paper, args: ["--server-program", "vanilla"] },
    { folder: "world_nether", saved: { kind: "none" }, args: ["--server-local", "--server-program", "vanilla"] },
  ];
  for (const { folder, saved, args } of rows) {
    const t = setup();
    const before = writeServerSetting(t, saved);
    mkdirSync(join(t.root, "server", folder), { recursive: true });
    assert.equal(await runConfigureCommand(args, t.context, LOCAL_8GB), 1, JSON.stringify({ folder, saved, args }));
    assert.match(t.out.join("\n"), /This world has run on Paper, which keeps the Nether and the End in folders of their own \(world_nether, world_the_end\)\. Going back to vanilla is not offered yet: keep Paper, or move the world folders aside to start a new world on vanilla\./u);
    assert.equal(readFileSync(join(t.root, "settings.json"), "utf8"), before);
  }
});

test("vanilla to paper on any world is allowed", async () => {
  const t = setup();
  writeServerSetting(t, { kind: "local", port: 25_565, memoryMb: 2048, program: "vanilla" });
  mkdirSync(join(t.root, "server", "world_nether"), { recursive: true });
  assert.equal(await runConfigureCommand(["--server-program", "paper"], t.context, LOCAL_8GB), 0);
  assert.equal(t.settings().server.program, "paper");
});

test("paper to vanilla on a world that never ran on Paper is allowed", async () => {
  const t = setup();
  writeServerSetting(t, { kind: "local", port: 25_565, memoryMb: 2048, program: "paper" });
  mkdirSync(join(t.root, "server", "world"), { recursive: true });
  assert.equal(await runConfigureCommand(["--server-program", "vanilla"], t.context, LOCAL_8GB), 0);
  assert.equal(t.settings().server.program, "vanilla");
});

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fakeKeyCipher, unreadingCipher } from "./key-cipher-test-support.ts";
import { loadSettings, saveSettings, settingsFileExists, settingsPath, type ManifestDefaults } from "./settings.ts";

const MANIFEST: ManifestDefaults = { ollama: { model: "gemma4:12b" }, defaultBots: ["ayla"] };

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "launcher-settings-"));
}

function writeSettings(root: string, text: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(settingsPath(root), text);
}

test("a missing file gives the defaults (manifest bots, local model, no server) and writes nothing", () => {
  const root = join(tempRoot(), "absent");
  const settings = loadSettings(root, MANIFEST);
  assert.equal(existsSync(root), false);
  assert.deepEqual(settings.bots, ["ayla"]);
  assert.deepEqual(settings.llm, { kind: "local", model: "gemma4:12b" });
  assert.deepEqual(settings.server, { kind: "none" });
  assert.equal(settings.hostBasePort, 25575);
  assert.equal(settings.controlPort, 25599);
  assert.equal(settings.checkUpdates, true);
});

test("settingsFileExists tells a missing file from a present one, so a console can say which folder it read", () => {
  const root = tempRoot();
  assert.equal(settingsFileExists(root), false);
  writeSettings(root, "{}");
  assert.equal(settingsFileExists(root), true);
});

test("a file with only some keys keeps them and gets the defaults for the rest", () => {
  const root = tempRoot();
  writeSettings(root, JSON.stringify({ bots: ["brea"], server: { kind: "remote", host: "mc.example", port: 25570 } }));
  const settings = loadSettings(root, MANIFEST);
  assert.deepEqual(settings.bots, ["brea"]);
  assert.deepEqual(settings.server, { kind: "remote", host: "mc.example", port: 25570 });
  assert.deepEqual(settings.llm, { kind: "local", model: "gemma4:12b" });
});

test("unknown keys survive a load and save, at the top level and inside llm", () => {
  const root = tempRoot();
  writeSettings(root, JSON.stringify({ myNote: "keep", llm: { kind: "local", model: "m", extra: 1 } }));
  saveSettings(root, loadSettings(root, MANIFEST));
  const saved = JSON.parse(readFileSync(settingsPath(root), "utf8"));
  assert.equal(saved.myNote, "keep");
  assert.equal(saved.llm.extra, 1);
  assert.equal(saved.llm.model, "m");
});

test("a saved file loads back to the same settings, and save creates the data root", () => {
  const root = join(tempRoot(), "new", "MineAI");
  const clearKeys = { platform: "linux", cipher: null } as const; // on Windows it loads back with its blob too: tests below
  const settings = loadSettings(root, MANIFEST, clearKeys);
  settings.llm = { kind: "remote", baseUrl: "https://api.example/v1", apiKey: "k", model: "m" };
  settings.server = { kind: "local", port: 25565, memoryMb: 4096 };
  saveSettings(root, settings, clearKeys);
  assert.deepEqual(loadSettings(root, MANIFEST, clearKeys), settings);
});

test("an invalid file fails with its path and the issue, and is never replaced", () => {
  const root = tempRoot();
  const text = JSON.stringify({ server: { kind: "remote", host: "h", port: 70000 } });
  writeSettings(root, text);
  assert.throws(
    () => loadSettings(root, MANIFEST),
    (error: Error) => {
      assert.ok(error.message.includes(settingsPath(root)), error.message);
      assert.ok(error.message.includes("server.port"), error.message);
      return true;
    },
  );
  assert.equal(readFileSync(settingsPath(root), "utf8"), text);
});

test("a file that is not JSON fails with its path and leaves the file as it is", () => {
  const root = tempRoot();
  writeSettings(root, "{ not json");
  assert.throws(
    () => loadSettings(root, MANIFEST),
    (error: Error) => error.message.includes(settingsPath(root)) && /JSON/u.test(error.message),
  );
  assert.equal(readFileSync(settingsPath(root), "utf8"), "{ not json");
});

test("a persona id that could leave the personas folder is refused", () => {
  const root = tempRoot();
  writeSettings(root, JSON.stringify({ bots: ["../secrets"] }));
  assert.throws(() => loadSettings(root, MANIFEST), /bots/u);
});

test("a settings file holding something other than an object is refused with its path", () => {
  const root = tempRoot();
  writeSettings(root, "[]");
  assert.throws(() => loadSettings(root, MANIFEST), (error: Error) => error.message.includes(settingsPath(root)));
});

const DEFAULT_COMMANDS = { enabled: true, prefix: "!", players: [], listenerName: "MineAI" };

test("a missing file and an old file without commands both give the chat command defaults", () => {
  assert.deepEqual(loadSettings(join(tempRoot(), "absent"), MANIFEST).commands, DEFAULT_COMMANDS);
  const root = tempRoot();
  writeSettings(root, JSON.stringify({ bots: ["brea"] }));
  assert.deepEqual(loadSettings(root, MANIFEST).commands, DEFAULT_COMMANDS);
});

test("a commands object with some keys keeps them, takes the defaults for the rest, and keeps unknown keys on save", () => {
  const root = tempRoot();
  writeSettings(root, JSON.stringify({ commands: { players: ["Tom_1"], note: "keep" } }));
  const settings = loadSettings(root, MANIFEST);
  assert.deepEqual(settings.commands, { ...DEFAULT_COMMANDS, players: ["Tom_1"], note: "keep" });
  saveSettings(root, settings);
  assert.equal(JSON.parse(readFileSync(settingsPath(root), "utf8")).commands.note, "keep");
});

for (const [label, commands, path] of [
  ["a slash prefix (it would run as a console command)", { prefix: "/" }, "commands.prefix"],
  ["an empty prefix", { prefix: "" }, "commands.prefix"],
  ["a prefix of four characters", { prefix: "!!!!" }, "commands.prefix"],
  ["a prefix with a space", { prefix: "! " }, "commands.prefix"],
  ["a prefix with a section sign (a host refuses it in a whisper)", { prefix: "§" }, "commands.prefix"],
  ["a prefix with a control character", { prefix: "\u0007" }, "commands.prefix"],
  ["a prefix with letters (`ro` would hide `Robots` from the brains)", { prefix: "ro" }, "commands.prefix"],
  ["a prefix with a letter after a symbol", { prefix: "!b" }, "commands.prefix"],
  ["a prefix with a digit", { prefix: "1" }, "commands.prefix"],
  ["a prefix with an accented letter", { prefix: "é" }, "commands.prefix"],
  ["a player name with a space", { players: ["Tom Dara"] }, "commands.players"],
  ["a player name of two characters", { players: ["ab"] }, "commands.players"],
  ["a player name of seventeen characters", { players: ["a".repeat(17)] }, "commands.players"],
  ["a listener name that is no player name", { listenerName: "Mine AI" }, "commands.listenerName"],
  ["enabled that is no boolean", { enabled: "yes" }, "commands.enabled"],
] as const) {
  test(`${label} is refused with the path of the key, and the file is never replaced`, () => {
    const root = tempRoot();
    const text = JSON.stringify({ commands });
    writeSettings(root, text);
    assert.throws(() => loadSettings(root, MANIFEST), (error: Error) => error.message.includes(settingsPath(root)) && error.message.includes(path));
    assert.equal(readFileSync(settingsPath(root), "utf8"), text);
  });
}

test("a prefix of one to three symbols other than a slash is accepted", () => {
  for (const prefix of ["!", "?", ".", "$$", "@#~"]) {
    const root = tempRoot();
    writeSettings(root, JSON.stringify({ commands: { prefix } }));
    assert.equal(loadSettings(root, MANIFEST).commands.prefix, prefix);
  }
});

// The API key on disk (plan 2026-11-06-installer-improvements T2, spec D3): a fake Windows with a fake cipher.
const WINDOWS = () => ({ platform: "win32" as const, cipher: fakeKeyCipher() });
const REMOTE = { kind: "remote", baseUrl: "https://api.example/v1", model: "m" };
const fileLlm = (root: string): Record<string, unknown> => JSON.parse(readFileSync(settingsPath(root), "utf8")).llm;

test("on Windows a remote key is saved as a blob only, loads back clear, and a save of other settings leaves the blob byte for byte", () => {
  const root = tempRoot();
  const options = WINDOWS();
  const settings = loadSettings(root, MANIFEST, options);
  settings.llm = { ...REMOTE, apiKey: "sk-or-v1-secret" } as typeof settings.llm;
  saveSettings(root, settings, options);
  assert.equal(readFileSync(settingsPath(root), "utf8").includes("sk-or-v1-secret"), false);
  assert.equal("apiKey" in fileLlm(root), false);
  const blob = fileLlm(root).apiKeyProtected;
  assert.equal(typeof blob, "string");
  const loaded = loadSettings(root, MANIFEST, options);
  assert.equal(loaded.llm.kind === "remote" && loaded.llm.apiKey, "sk-or-v1-secret");
  saveSettings(root, { ...loaded, checkUpdates: false }, options);
  assert.equal(fileLlm(root).apiKeyProtected, blob);
  assert.deepEqual(Object.keys(fileLlm(root)).sort(), ["apiKeyProtected", "baseUrl", "kind", "model"], "no helper field reaches the file");
});

test("an old clear key loads on Windows with clearKeyInFile, and the next save encrypts it for good and keeps the llm's unknown keys", () => {
  const root = tempRoot();
  const options = WINDOWS();
  writeSettings(root, JSON.stringify({ llm: { ...REMOTE, apiKey: "sk-old", note: "mine" } }));
  const settings = loadSettings(root, MANIFEST, options);
  assert.equal(settings.llm.kind === "remote" && settings.llm.clearKeyInFile, true);
  saveSettings(root, settings, options);
  assert.equal(readFileSync(settingsPath(root), "utf8").includes("sk-old"), false);
  assert.equal("clearKeyInFile" in fileLlm(root), false);
  assert.equal(fileLlm(root).note, "mine");
  const again = loadSettings(root, MANIFEST, options);
  assert.equal(again.llm.kind === "remote" && again.llm.clearKeyInFile, undefined);
  assert.equal(again.llm.kind === "remote" && again.llm.apiKey, "sk-old");
});

test("a blob that cannot be decrypted loads without throwing, as keyUnreadable, and a save of other settings keeps it", () => {
  const root = tempRoot();
  writeSettings(root, JSON.stringify({ llm: { ...REMOTE, apiKeyProtected: "QUJD" } }));
  const options = { platform: "win32" as const, cipher: unreadingCipher };
  const settings = loadSettings(root, MANIFEST, options);
  assert.equal(settings.llm.kind === "remote" && settings.llm.keyUnreadable, true);
  assert.equal(settings.llm.kind === "remote" && settings.llm.apiKey, "");
  saveSettings(root, { ...settings, bots: ["brea"] }, options);
  assert.equal(fileLlm(root).apiKeyProtected, "QUJD");
  assert.equal("keyUnreadable" in fileLlm(root), false);
  assert.equal("apiKey" in fileLlm(root), false);
});

// File modes mean nothing on a Windows drive: this one runs in WSL.
test("on Linux the key stays in clear and a file that was wider before is narrowed to its owner only", { skip: process.platform === "win32" }, () => {
  const root = tempRoot();
  const options = { platform: "linux" as const, cipher: null };
  writeSettings(root, "{}");
  chmodSync(settingsPath(root), 0o644);
  const settings = loadSettings(root, MANIFEST, options);
  settings.llm = { ...REMOTE, apiKey: "sk-linux" } as typeof settings.llm;
  saveSettings(root, settings, options);
  assert.equal(fileLlm(root).apiKey, "sk-linux");
  assert.equal(statSync(settingsPath(root)).mode & 0o777, 0o600);
});

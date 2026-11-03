import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadManifest } from "./manifest.ts";
import { loadSettings, saveSettings, settingsPath, type Settings } from "./settings.ts";
import { realDoctorDeps, runDoctor, type DoctorDeps } from "./doctor.ts";
import { saveInstallState } from "./install/state.ts";

function fixture(change: (settings: Settings) => Settings = (settings) => settings) {
  const root = mkdtempSync(join(tmpdir(), "mine-ai-doctor-"));
  mkdirSync(join(root, "logs"), { recursive: true });
  const manifest = loadManifest();
  const settings = change(loadSettings(root, manifest));
  const deps: DoctorDeps = {
    bunVersion: "1.4.2",
    platform: "win32",
    ollamaVersion: async () => "0.35.0",
    javaInstalled: () => true,
    gpuSummary: async () => ["Adapter 1: 24.0 GiB", "Local model gemma4:12b can run here."],
    portOwner: async () => "free",
  };
  return { root, manifest, settings, deps };
}

const stamp = (n: number): string => `2026-10-30T10:${String(n).padStart(2, "0")}:00.000Z`;

test("lists the versions, the GPU answer and the settings path", async () => {
  const { root, manifest, settings, deps } = fixture();
  const text = (await runDoctor(root, manifest, settings, deps)).join("\n");
  assert.match(text, new RegExp(`Mine AI ${manifest.version.replaceAll(".", "\\.")}`, "u"));
  assert.match(text, /Bun 1\.4\.2/u);
  assert.match(text, /Ollama 0\.35\.0/u);
  assert.match(text, /Adapter 1: 24\.0 GiB/u);
  assert.match(text, /settings\.json/u);
});

test("says when Ollama or Java is missing, with the step that installs it", async () => {
  const { root, manifest, settings, deps } = fixture();
  const text = (await runDoctor(root, manifest, settings, { ...deps, ollamaVersion: async () => null, javaInstalled: () => false })).join("\n");
  assert.match(text, /Ollama: not installed/u);
  assert.match(text, /Java: not installed/u);
});

test("lists each port the stack uses and whether another program holds it", async () => {
  const { root, manifest, settings, deps } = fixture((s) => ({ ...s, server: { kind: "local", port: 25_565, memoryMb: 4096 } }));
  const owners = { 25_565: "other", [settings.controlPort]: "mine-ai" } as const;
  const text = (await runDoctor(root, manifest, settings, { ...deps, portOwner: async (port) => (owners as Record<number, "other" | "mine-ai">)[port] ?? "free" })).join("\n");
  assert.match(text, /25565.*another program/u);
  assert.match(text, new RegExp(`${settings.controlPort}.*in use by Mine AI`, "u"));
  assert.match(text, new RegExp(`${manifest.ollama.port}.*free`, "u"));
});

test("shows the settings without the endpoint's key", async () => {
  const { root, manifest, settings, deps } = fixture((s) => ({ ...s, llm: { kind: "remote", baseUrl: "https://api.example.test/v1", apiKey: "sk-secret", model: "big" } }));
  const text = (await runDoctor(root, manifest, settings, deps)).join("\n");
  assert.match(text, /https:\/\/api\.example\.test\/v1/u);
  assert.ok(!text.includes("sk-secret"));
});

test("the last 20 error lines of all logs, oldest first, each with its log file", async () => {
  const { root, manifest, settings, deps } = fixture();
  const lines = (name: string, from: number) => Array.from({ length: 15 }, (_, i) => `${stamp(from + i)} error number ${from + i} in ${name}`).join("\n");
  writeFileSync(join(root, "logs", "host-ayla.log"), `${lines("host", 0)}\n${stamp(40)} all fine here\n`);
  writeFileSync(join(root, "logs", "brain-ayla.log"), `${lines("brain", 20)}\n`);
  const out = await runDoctor(root, manifest, settings, deps);
  const errors = out.filter((line) => line.includes("error number"));
  assert.equal(errors.length, 20);
  assert.match(errors[0]!, /error number 10 in host/u);
  assert.match(errors.at(-1)!, /error number 34 in brain/u);
  assert.match(errors.at(-1)!, /brain-ayla\.log/u);
  assert.ok(!out.some((line) => line.includes("all fine here")));
});

test("no log folder or no errors: a line saying so", async () => {
  const { root, manifest, settings, deps } = fixture();
  assert.match((await runDoctor(root, manifest, settings, deps)).join("\n"), /No errors in the logs/u);
});

test("a log that is huge is read from its end only", async () => {
  const { root, manifest, settings, deps } = fixture();
  const filler = `${stamp(0)} old line\n`.repeat(100_000);
  writeFileSync(join(root, "logs", "ollama.log"), `${stamp(1)} error at the very start\n${filler}${stamp(2)} error at the end\n`);
  const text = (await runDoctor(root, manifest, settings, deps)).join("\n");
  assert.match(text, /error at the end/u);
  assert.ok(!text.includes("error at the very start"));
});

test("the real doctor finds the Ollama our install recorded in a folder the player chose", async () => {
  const { root, manifest } = fixture();
  // any program stands for ollama.exe: the doctor runs it with --version and reads no version from Bun's answer
  saveInstallState(root, { ollama: "installed", ollamaPath: process.execPath });
  assert.equal(await realDoctorDeps(root, manifest).ollamaVersion(), "(version not readable)");
});

test("no settings file: the Settings line says the file is not found and the values are the defaults; with the file, it does not", async () => {
  const { root, manifest, settings, deps } = fixture();
  const missing = (await runDoctor(root, manifest, settings, deps)).find((line) => line.startsWith("Settings:"));
  assert.equal(missing, `Settings: ${settingsPath(root)} (not found: the values below are the defaults)`);
  saveSettings(root, settings);
  const present = (await runDoctor(root, manifest, settings, deps)).find((line) => line.startsWith("Settings:"));
  assert.equal(present, `Settings: ${settingsPath(root)}`);
});

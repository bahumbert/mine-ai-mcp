// Builders the install steps' tests share: a manifest with the plan's values, a context, a temp data root.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Manifest } from "../../manifest.ts";
import type { Settings } from "../../settings.ts";
import type { DxgiAdapter } from "../dxgi.ts";
import type { InstallContext } from "../step.ts";

export function testManifest(ollama: Partial<Manifest["ollama"]> = {}, waits: Partial<Manifest["waits"]> = {}): Manifest {
  return {
    version: "0.0.0-test",
    minecraft: {
      version: "1.21.4",
      jar: { url: "https://example.test/server.jar", sha1: "0".repeat(40) },
      memoryMb: { min: 2048, perRamGb: 256, max: 6144 },
    },
    java: { url: "https://example.test/java.zip", sha256: "0".repeat(64) },
    ollama: {
      url: "https://example.test/OllamaSetup.exe",
      sha256: "1".repeat(64),
      minVersion: "0.30.0",
      port: 11435,
      env: { OLLAMA_NUM_PARALLEL: "3" },
      model: "gemma4:12b",
      minVramGiB: 10,
      minRamGiB: 32,
      ...ollama,
    },
    brainEnv: {},
    brainModelSlots: 3,
    bun: { url: "https://example.test/bun.zip", sha256: "2".repeat(64) },
    defaultBots: ["ayla"],
    waits: { ollamaUpMs: 400, warmUpMs: 1000, serverDoneMs: 1000, hostHealthMs: 1000, serverStopMs: 1000, modelPullIdleMs: 5000, ...waits },
    release: { latestUrl: "https://example.test/latest.json" },
    commands: { cooldownMs: 2000, refusalEveryMs: 600000, pollMs: 1000, maxAgeMs: 60000, listenerAfterMs: 10000, answerWaitMs: 20000 },
  };
}

export function testContext(root: string, manifest: Manifest = testManifest()): InstallContext & { progress: [number, string][] } {
  const settings: Settings = {
    llm: { kind: "local", model: manifest.ollama.model },
    server: { kind: "none" },
    bots: manifest.defaultBots,
    hostBasePort: 25575,
    controlPort: 25599,
    checkUpdates: true,
    commands: { enabled: true, prefix: "!", players: [], listenerName: "MineAI" },
  };
  const progress: [number, string][] = [];
  return { manifest, settings, root, progress, onProgress: (fraction, label) => progress.push([fraction, label]) };
}

/** The four adapters DXGI listed on the owner's PC, 2026-11-06 (probe `dxgi-adapters.ts`), in its order. */
export const MEASURED_DXGI_ADAPTERS: DxgiAdapter[] = [
  { name: "AMD Radeon RX 7900 XTX", dedicatedBytes: 25708240896, software: false },
  { name: "AMD Radeon(TM) Graphics", dedicatedBytes: 509374464, software: false },
  { name: "AMD Radeon RX 7900 XTX", dedicatedBytes: 25708240896, software: false },
  { name: "Microsoft Basic Render Driver", dedicatedBytes: 0, software: true },
];

/** A fresh data root in the OS temp folder; call the returned `remove` in `after`. */
export function tempDataRoot(): { root: string; remove(): void } {
  const root = mkdtempSync(join(tmpdir(), "mine-ai-install-"));
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

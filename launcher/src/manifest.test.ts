import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadManifest, manifestSchema } from "./manifest.ts";

test("the shipped manifest parses", () => {
  const manifest = loadManifest();
  assert.equal(manifest.minecraft.version, "1.21.4");
  assert.equal(manifest.ollama.model, "gemma4:12b");
  assert.deepEqual(manifest.defaultBots, ["ayla"]);
});

test("every download URL of the shipped manifest is https and carries a hash", () => {
  const manifest = loadManifest();
  const downloads = [
    { name: "minecraft jar", url: manifest.minecraft.jar.url, hash: manifest.minecraft.jar.sha1, length: 40 },
    { name: "java", url: manifest.java.url, hash: manifest.java.sha256, length: 64 },
    { name: "ollama", url: manifest.ollama.url, hash: manifest.ollama.sha256, length: 64 },
    { name: "bun", url: manifest.bun.url, hash: manifest.bun.sha256, length: 64 },
  ];
  for (const download of downloads) {
    assert.ok(download.url.startsWith("https:"), `${download.name} URL is not https: ${download.url}`);
    assert.match(download.hash, new RegExp(`^[0-9a-f]{${download.length}}$`), `${download.name} hash`);
  }
  assert.ok(manifest.release.latestUrl.startsWith("https:"));
});

test("a manifest with a download without a hash, or with an http URL, is refused", () => {
  const withoutHash = JSON.parse(JSON.stringify(loadManifest())) as Record<string, any>;
  delete withoutHash.java.sha256;
  assert.equal(manifestSchema.safeParse(withoutHash).success, false);
  const http = JSON.parse(JSON.stringify(loadManifest())) as Record<string, any>;
  http.bun.url = http.bun.url.replace("https:", "http:");
  assert.equal(manifestSchema.safeParse(http).success, false);
});

test("an unreadable or invalid file fails with its path", () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-"));
  const path = join(dir, "manifest.json");
  writeFileSync(path, "{ not json");
  assert.throws(() => loadManifest(path), (error: Error) => error.message.includes(path));
  writeFileSync(path, JSON.stringify({ version: "1" }));
  assert.throws(() => loadManifest(path), (error: Error) => error.message.includes(path) && error.message.includes("minecraft"));
  assert.throws(() => loadManifest(join(dir, "missing.json")), (error: Error) => error.message.includes("missing.json"));
});

test("the shipped manifest holds the chat command numbers, and a misspelled or missing one is refused", () => {
  assert.deepEqual(loadManifest().commands, { cooldownMs: 2000, refusalEveryMs: 600000, pollMs: 1000, maxAgeMs: 60000, listenerAfterMs: 10000, answerWaitMs: 20000 });
  const misspelled = JSON.parse(JSON.stringify(loadManifest())) as Record<string, any>;
  misspelled.commands.cooldown = misspelled.commands.cooldownMs;
  delete misspelled.commands.cooldownMs;
  assert.equal(manifestSchema.safeParse(misspelled).success, false);
  const zero = JSON.parse(JSON.stringify(loadManifest())) as Record<string, any>;
  zero.commands.pollMs = 0;
  assert.equal(manifestSchema.safeParse(zero).success, false);
});

test("the shipped manifest bounds a silent model pull at 300 s, and a missing or zero bound is refused", () => {
  assert.equal(loadManifest().waits.modelPullIdleMs, 300000);
  const missing = JSON.parse(JSON.stringify(loadManifest())) as Record<string, any>;
  delete missing.waits.modelPullIdleMs;
  assert.equal(manifestSchema.safeParse(missing).success, false);
  const zero = JSON.parse(JSON.stringify(loadManifest())) as Record<string, any>;
  zero.waits.modelPullIdleMs = 0;
  assert.equal(manifestSchema.safeParse(zero).success, false);
});

test("the install sizes and the space kept free per drive are required positive numbers: a manifest without `disk` fails naming it, a missing or zero one fails", () => {
  const manifest = loadManifest();
  const withoutDisk = JSON.parse(JSON.stringify(manifest)) as Record<string, any>;
  delete withoutDisk.disk;
  const dir = mkdtempSync(join(tmpdir(), "manifest-"));
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify(withoutDisk));
  assert.throws(() => loadManifest(path), (error: Error) => error.message.includes("disk"));
  for (const [section, key] of [["ollama", "installedBytes"], ["java", "installedBytes"], ["disk", "reserveBytes"]] as const) {
    const missing = JSON.parse(JSON.stringify(manifest)) as Record<string, any>;
    delete missing[section][key];
    assert.equal(manifestSchema.safeParse(missing).success, false, `${section}.${key} missing`);
    const zero = JSON.parse(JSON.stringify(manifest)) as Record<string, any>;
    zero[section][key] = 0;
    assert.equal(manifestSchema.safeParse(zero).success, false, `${section}.${key} zero`);
  }
});

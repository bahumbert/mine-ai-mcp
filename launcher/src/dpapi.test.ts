import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dpapiCipher, packDataBlob } from "./dpapi.ts";
import { loadSettings, realSettingsOptions, saveSettings, settingsPath } from "./settings.ts";

const onWindows = process.platform === "win32";

test("packDataBlob lays out a Windows DATA_BLOB on x64: u32 length, 4 bytes of padding, u64 pointer (a bigint or a number)", () => {
  const blob = packDataBlob(246, 0x0000_7ff6_1234_5678n);
  assert.equal(blob.length, 16);
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  assert.equal(view.getUint32(0, true), 246);
  assert.equal(view.getUint32(4, true), 0);
  assert.equal(view.getBigUint64(8, true), 0x0000_7ff6_1234_5678n);
  assert.equal(new DataView(packDataBlob(7, 4096).buffer).getBigUint64(8, true), 4096n);
});

// DPAPI answers on Windows only; run these with Windows Bun (plan T2, facts "Testing the installer on this PC").
const roundTripKeys: Record<string, string> = {
  "an OpenRouter-shaped key": `sk-or-v1-${"0123456789abcdef".repeat(4)}`,
  "a key with accents and an emoji": "é ü 🔑 key",
  "a 300-character key": "x".repeat(300),
};
for (const [name, key] of Object.entries(roundTripKeys)) {
  test(`DPAPI round-trips ${name}`, { skip: !onWindows }, () => {
    const cipher = dpapiCipher();
    const blob = cipher.protect(new TextEncoder().encode(key));
    assert.notDeepEqual(blob, new TextEncoder().encode(key));
    assert.equal(new TextDecoder().decode(cipher.unprotect(blob)), key);
  });
}

test("settings.json written with the real DPAPI holds no key text and loads back the same key", { skip: !onWindows }, () => {
  const root = mkdtempSync(join(tmpdir(), "launcher-dpapi-"));
  const options = realSettingsOptions();
  const settings = loadSettings(root, { ollama: { model: "m" }, defaultBots: ["ayla"] }, options);
  settings.llm = { kind: "remote", baseUrl: "https://api.example/v1", model: "m", apiKey: "sk-or-v1-é🔑-real" };
  saveSettings(root, settings, options);
  const text = readFileSync(settingsPath(root), "utf8");
  assert.equal(text.includes("sk-or-v1"), false);
  assert.match(text, /"apiKeyProtected": "[A-Za-z0-9+/=]{100,}"/u);
  const loaded = loadSettings(root, { ollama: { model: "m" }, defaultBots: ["ayla"] }, options);
  assert.equal(loaded.llm.kind === "remote" && loaded.llm.apiKey, "sk-or-v1-é🔑-real");
});

test("DPAPI refuses an empty input (error 87, measured 2026-11-06): that is why an empty key is never encrypted", { skip: !onWindows }, () => {
  assert.throws(() => dpapiCipher().protect(new Uint8Array(0)), /^Error: CryptProtectData failed \(error 87\)$/u);
});

test("DPAPI refuses a blob with one changed byte, and says which call failed", { skip: !onWindows }, () => {
  const cipher = dpapiCipher();
  const blob = cipher.protect(new TextEncoder().encode("secret"));
  blob[blob.length - 5]! ^= 0xff;
  assert.throws(() => cipher.unprotect(blob), /^Error: CryptUnprotectData failed \(error \d+\)$/u);
});

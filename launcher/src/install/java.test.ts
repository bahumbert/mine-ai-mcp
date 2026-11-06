import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadManifest } from "../manifest.ts";
import type { Settings } from "../settings.ts";
import { extractZipCommand, java, javaPath } from "./java.ts";
import type { InstallContext } from "./step.ts";

const zipBytes = Buffer.from("pretend this is the Temurin JRE zip");
const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function context(sha256: string = sha256Of(zipBytes)): InstallContext & { progress: string[] } {
  const manifest = loadManifest();
  const progress: string[] = [];
  return {
    manifest: { ...manifest, java: { ...manifest.java, url: "https://example.invalid/jre.zip", sha256 } },
    settings: {} as Settings,
    root: mkdtempSync(join(tmpdir(), "java-step-")),
    onProgress: (_fraction, label) => progress.push(label),
    progress,
  };
}

/** The same context pinned to another zip: what a new manifest does on an update. */
function pinnedTo(ctx: InstallContext, bytes: Buffer): InstallContext {
  return { ...ctx, manifest: { ...ctx.manifest, java: { ...ctx.manifest.java, url: "https://example.invalid/jre2.zip", sha256: sha256Of(bytes) } } };
}

/** A fetch serving `bytes`, counting the requests. */
function serving(bytes: Buffer = zipBytes) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-length": String(bytes.length) } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Extractor writing what the Temurin zip holds: one top folder with `bin/java.exe`. */
function extractsTopFolder(extracted: string[] = []) {
  return async (zip: string, destDir: string) => {
    extracted.push(readFileSync(zip).toString());
    mkdirSync(join(destDir, "jdk-21.0.13+9-jre", "bin"), { recursive: true });
    writeFileSync(join(destDir, "jdk-21.0.13+9-jre", "bin", "java.exe"), "java");
  };
}

test("the step downloads the JRE and leaves java.exe at javaPath(root)", async () => {
  const ctx = context();
  const { fetchImpl, calls } = serving();
  const result = await java(ctx, { fetchImpl, extractZip: extractsTopFolder() });
  assert.equal(result.ok, true);
  assert.equal(readFileSync(javaPath(ctx.root), "utf8"), "java");
  assert.deepEqual(calls, ["https://example.invalid/jre.zip"]);
  assert.ok(ctx.progress.length > 0);
  // The downloaded zip and the staging folder are gone afterwards.
  assert.deepEqual(readdirSync(join(ctx.root, "runtime")), ["java"]);
});

test("a second run with the same pin makes no request and no extraction", async () => {
  const ctx = context();
  await java(ctx, { fetchImpl: serving().fetchImpl, extractZip: extractsTopFolder() });
  const again = serving();
  const extracted: string[] = [];
  const result = await java(ctx, { fetchImpl: again.fetchImpl, extractZip: extractsTopFolder(extracted) });
  assert.equal(result.ok, true);
  assert.equal(again.calls.length, 0);
  assert.equal(extracted.length, 0);
});

test("a new pin in the manifest replaces the installed JRE", async () => {
  const ctx = context();
  await java(ctx, { fetchImpl: serving().fetchImpl, extractZip: extractsTopFolder() });
  writeFileSync(join(ctx.root, "runtime", "java", "old-only-file"), "x");
  const newer = Buffer.from("a newer JRE zip");
  const result = await java(pinnedTo(ctx, newer), { fetchImpl: serving(newer).fetchImpl, extractZip: extractsTopFolder() });
  assert.equal(result.ok, true);
  assert.equal(existsSync(join(ctx.root, "runtime", "java", "old-only-file")), false);
  assert.equal(existsSync(javaPath(ctx.root)), true);
});

test("a zip with the wrong hash fails the step with a hint and installs nothing", async () => {
  const ctx = context("0".repeat(64));
  const result = await java(ctx, { fetchImpl: serving().fetchImpl, extractZip: extractsTopFolder() });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /expected sha256 0{64}/u);
    assert.match(result.hint, /checksum/u);
  }
  assert.equal(existsSync(javaPath(ctx.root)), false);
});

test("a pinned URL answering 404 says so, not 'check the internet connection'", async () => {
  const ctx = context();
  const missing = (async () => new Response("gone", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
  const result = await java(ctx, { fetchImpl: missing, extractZip: extractsTopFolder() });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.hint, /answered with an error/u);
});

test("files held by another program during the swap tell the user to stop Mine AI, keeping the old JRE", async () => {
  const ctx = context();
  await java(ctx, { fetchImpl: serving().fetchImpl, extractZip: extractsTopFolder() });
  const newer = Buffer.from("a newer JRE zip");
  const locked = async () => {
    throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
  };
  const result = await java(pinnedTo(ctx, newer), { fetchImpl: serving(newer).fetchImpl, extractZip: locked });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.hint, /mine-ai stop/u);
  assert.equal(existsSync(javaPath(ctx.root)), true);
});

test("an archive tar cannot read fails with the unpack hint (the real tar, a garbage zip)", async () => {
  const garbage = Buffer.from("not a zip at all");
  const ctx = context(sha256Of(garbage));
  const result = await java(ctx, { fetchImpl: serving(garbage).fetchImpl });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /Cannot unpack/u);
    assert.match(result.hint, /1803|tar\.exe/u);
  }
});

test("a failed extraction keeps the JRE that was installed before", async () => {
  const ctx = context();
  await java(ctx, { fetchImpl: serving().fetchImpl, extractZip: extractsTopFolder() });
  const newer = Buffer.from("a newer JRE zip");
  const broken = async (_zip: string, destDir: string) => {
    mkdirSync(join(destDir, "half"), { recursive: true });
    throw new Error("tar: Unexpected end of archive");
  };
  const result = await java(pinnedTo(ctx, newer), { fetchImpl: serving(newer).fetchImpl, extractZip: broken });
  assert.equal(result.ok, false);
  assert.equal(readFileSync(javaPath(ctx.root), "utf8"), "java");
  assert.deepEqual(readdirSync(join(ctx.root, "runtime")), ["java"]);
});

test("an archive without bin/java.exe fails the step", async () => {
  const ctx = context();
  const empty = async (_zip: string, destDir: string) => void mkdirSync(join(destDir, "docs"), { recursive: true });
  const result = await java(ctx, { fetchImpl: serving().fetchImpl, extractZip: empty });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /java\.exe/u);
    assert.match(result.hint, /Java download/u);
  }
  assert.equal(existsSync(javaPath(ctx.root)), false);
});

test("the zip is extracted with the system tar on Windows, never a tar from PATH", () => {
  const windows = extractZipCommand("C:\\a\\jre.zip", "C:\\a\\out", "win32", { SystemRoot: "C:\\Windows" });
  assert.equal(windows.command, "C:\\Windows\\System32\\tar.exe");
  assert.deepEqual(windows.args, ["-xf", "C:\\a\\jre.zip", "-C", "C:\\a\\out"]);
  assert.equal(extractZipCommand("/a.zip", "/o", "linux", {}).command, "tar");
});

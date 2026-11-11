import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadManifest } from "../manifest.ts";
import type { Settings } from "../settings.ts";
import { diskWithRoomForAnything, twoDrives } from "./fixtures/fake-disk.ts";
import { server as serverStep, serverMemoryMb, type ServerDeps } from "./server.ts";
import type { InstallContext } from "./step.ts";

/** The step over a disk with room for anything unless a test gives its own: only the free-space tests depend on the disk. */
const server = (ctx: InstallContext, acceptEula: boolean, deps: ServerDeps = {}) => serverStep(ctx, acceptEula, { disk: diskWithRoomForAnything(), ...deps });

const jarBytes = Buffer.from("pretend server.jar");
const jarSha1 = createHash("sha1").update(jarBytes).digest("hex");
const GIB = 1024 ** 3;

function context(port = 25565): InstallContext {
  const manifest = loadManifest();
  return {
    manifest: { ...manifest, minecraft: { ...manifest.minecraft, jar: { url: "https://example.invalid/server.jar", sha1: jarSha1 } } },
    settings: { server: { kind: "local", port, memoryMb: 4096 } } as Settings,
    root: mkdtempSync(join(tmpdir(), "server-step-")),
    onProgress: () => {},
  };
}

function serving() {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    return new Response(new Uint8Array(jarBytes), { status: 200, headers: { "content-length": String(jarBytes.length) } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const serverFile = (ctx: InstallContext, name: string) => join(ctx.root, "server", name);
/** A `key=value` line of the written server.properties: the file's text is the contract, not a parser of ours. */
const hasLine = (ctx: InstallContext, line: string) => readFileSync(serverFile(ctx, "server.properties"), "utf8").split("\n").includes(line);

test("without acceptance there is no eula.txt, no download and the step says EULA not accepted; an eula.txt saying false does not count", async () => {
  const ctx = context();
  const { fetchImpl, calls } = serving();
  const result = await server(ctx, false, { fetchImpl });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /EULA not accepted/u);
    assert.match(result.hint, /--accept-eula/u);
  }
  assert.equal(existsSync(serverFile(ctx, "eula.txt")), false);
  assert.equal(calls.length, 0);
  mkdirSync(join(ctx.root, "server"), { recursive: true });
  writeFileSync(serverFile(ctx, "eula.txt"), "eula=false\n");
  assert.equal((await server(ctx, false, { fetchImpl })).ok, false);
});

test("with acceptance the jar, eula.txt and server.properties are written", async () => {
  const ctx = context(25570);
  const result = await server(ctx, true, { fetchImpl: serving().fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(readFileSync(serverFile(ctx, "server.jar")), jarBytes);
  assert.match(readFileSync(serverFile(ctx, "eula.txt"), "utf8"), /^eula=true$/mu);
  for (const line of ["online-mode=false", "server-ip=127.0.0.1", "server-port=25570", "difficulty=normal"]) assert.ok(hasLine(ctx, line), line);
});

test("a user's motd and other keys survive, the managed keys are set", async () => {
  const ctx = context();
  mkdirSync(join(ctx.root, "server"), { recursive: true });
  writeFileSync(serverFile(ctx, "server.properties"), "#Minecraft server properties\nmotd=My own world\nonline-mode=true\nserver-ip=\ndifficulty=hard\nview-distance=12\n");
  await server(ctx, true, { fetchImpl: serving().fetchImpl });
  for (const line of ["#Minecraft server properties", "motd=My own world", "view-distance=12", "online-mode=false", "server-ip=127.0.0.1", "difficulty=normal"]) assert.ok(hasLine(ctx, line), line);
  assert.equal(hasLine(ctx, "online-mode=true"), false);
});

test("a second run, with or without --accept-eula once eula.txt says true, keeps the jar without a request", async () => {
  const ctx = context();
  await server(ctx, true, { fetchImpl: serving().fetchImpl });
  const again = serving();
  for (const acceptEula of [true, false]) assert.equal((await server(ctx, acceptEula, { fetchImpl: again.fetchImpl })).ok, true);
  assert.equal(again.calls.length, 0);
});

test("settings with a server that is not local fail the step with the configure command", async () => {
  const ctx = { ...context(), settings: { server: { kind: "none" } } as Settings };
  const result = await server(ctx, true, { fetchImpl: serving().fetchImpl });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.hint, /configure --server-local/u);
});

// Free-space guard (plan T1b): the jar is 56880250 bytes (its Content-Length, measured 2026-11-06); Mine AI keeps 1 GiB free.
const JAR_BYTES = 56880250;

function onDiskWith(ctx: InstallContext, free: number) {
  const { disk } = twoDrives(ctx.root, { data: free, other: 0 });
  return { ctx: { ...ctx, manifest: { ...ctx.manifest, disk: { reserveBytes: GIB } } }, disk };
}

test("a drive too small for the jar and the reserve fails once the size is announced, before a byte is written, and writes no eula or properties", async () => {
  const { ctx, disk } = onDiskWith(context(), 1.0 * GIB);
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    return new Response(new Uint8Array(jarBytes), { status: 200, headers: { "content-length": String(JAR_BYTES) } });
  }) as unknown as typeof fetch;
  const result = await server(ctx, true, { fetchImpl, disk });
  assert.ok(!result.ok);
  assert.match(result.error, /^Not enough free space on \S+ for the Minecraft server: it needs 1\.1 GB \(including the 1\.0 GB Mine AI keeps free\) and \S+ has 1\.0 GB free\.$/u);
  assert.match(result.hint, /^Free some space on \S+, then run the step again\.$/u);
  assert.equal(calls.length, 1, "the size comes from the download's own answer: no extra request");
  assert.equal(existsSync(serverFile(ctx, "server.jar.part")), false);
  assert.equal(existsSync(serverFile(ctx, "eula.txt")), false);
  assert.equal(existsSync(serverFile(ctx, "server.properties")), false);
});

test("a jar already there is never checked (it needs no more room): the disk is not read", async () => {
  const first = context();
  await server(first, true, { fetchImpl: serving().fetchImpl });
  const { ctx, disk } = onDiskWith(first, 0);
  const again = serving();
  assert.ok((await server(ctx, true, { fetchImpl: again.fetchImpl, disk })).ok);
  assert.equal(again.calls.length, 0);
  assert.deepEqual(disk.statfsCalls, []);
});

test("server memory is perRamGb per GiB of RAM, clamped to min and max", () => {
  const manifest = loadManifest();
  const { min, perRamGb, max } = manifest.minecraft.memoryMb;
  assert.equal(serverMemoryMb(manifest, 1 * GIB), min);
  assert.equal(serverMemoryMb(manifest, 1000 * GIB), max);
  const between = Math.floor(min / perRamGb) + 1;
  assert.ok(perRamGb * between > min && perRamGb * between < max, "the shipped numbers leave room between min and max");
  assert.equal(serverMemoryMb(manifest, between * GIB), perRamGb * between);
});

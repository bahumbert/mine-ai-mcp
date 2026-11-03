import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadManifest } from "../manifest.ts";
import type { Settings } from "../settings.ts";
import { server, serverMemoryMb } from "./server.ts";
import type { InstallContext } from "./step.ts";

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

test("server memory is perRamGb per GiB of RAM, clamped to min and max", () => {
  const manifest = loadManifest();
  const { min, perRamGb, max } = manifest.minecraft.memoryMb;
  assert.equal(serverMemoryMb(manifest, 1 * GIB), min);
  assert.equal(serverMemoryMb(manifest, 1000 * GIB), max);
  const between = Math.floor(min / perRamGb) + 1;
  assert.ok(perRamGb * between > min && perRamGb * between < max, "the shipped numbers leave room between min and max");
  assert.equal(serverMemoryMb(manifest, between * GIB), perRamGb * between);
});

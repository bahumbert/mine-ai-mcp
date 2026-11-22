import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadManifest } from "../manifest.ts";
import type { Settings } from "../settings.ts";
import { diskWithRoomForAnything, twoDrives } from "./fixtures/fake-disk.ts";
import { server as serverStep, serverJarName, serverMemoryMb, type JavaRun, type ServerDeps } from "./server.ts";
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

// Paper (plan 2026-11-14-p4-31-paper-server T7a): `settings.server.program` picks the jar; Paper's jar comes beside vanilla's.
const paperBytes = Buffer.from("pretend paper-1.21.4-232.jar");
const paperSha256 = createHash("sha256").update(paperBytes).digest("hex");
const PAPER_URL = "https://example.invalid/paper-1.21.4-232.jar";
const PAPER_JAR = "paper-1.21.4-232.jar";
/** The pin's measured first-start size (manifest `minecraft.paper.installedBytes`); the download's own size comes from its Content-Length. */
const PAPER_INSTALLED_BYTES = 161120324;

function paperContext(program: "paper" | "vanilla" = "paper"): InstallContext {
  const base = context();
  const paper = { build: 232, url: PAPER_URL, sha256: paperSha256, bytes: paperBytes.length, installedBytes: PAPER_INSTALLED_BYTES };
  return {
    ...base,
    manifest: { ...base.manifest, minecraft: { ...base.manifest.minecraft, paper } },
    settings: { server: { kind: "local", port: 25565, memoryMb: 4096, program } } as Settings,
  };
}

/** A fetch that answers each URL with its own bytes (vanilla's jar, Paper's jar); `paper` is what Paper's URL serves, announced as `announced` bytes. */
function servingBoth(paper: Buffer = paperBytes, announced: number = paper.length) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    const isPaper = String(url) === PAPER_URL;
    const body = isPaper ? paper : jarBytes;
    return new Response(new Uint8Array(body), { status: 200, headers: { "content-length": String(isPaper ? announced : body.length) } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A settings file of our own: the step must read the file it is given, not a table in its code. */
function paperSettingsFile(ctx: InstallContext): string {
  const path = join(ctx.root, "paper-settings.json");
  writeFileSync(path, JSON.stringify({ "spigot.yml": { "world-settings": { default: { "entity-activation-range": { monsters: 24 } } } }, "config/paper-world-defaults.yml": { entities: { spawning: { "per-player-mob-spawns": false } } } }));
  return path;
}

/** A `runJava` that records its calls and answers `exitCode`; `during` runs inside the call (the folder as Java would see it). */
function recordingJava(exitCode = 0, during: (run: JavaRun) => void = () => {}) {
  const runs: JavaRun[] = [];
  const runJava = async (run: JavaRun) => {
    runs.push(run);
    during(run);
    return exitCode;
  };
  return { runs, runJava };
}

/** The usual Paper deps: both jars served, our settings file, a Java that succeeds; `extra` overrides any of them. */
function paperDeps(ctx: InstallContext, extra: ServerDeps = {}): ServerDeps & { runs: JavaRun[]; calls: string[] } {
  const { fetchImpl, calls } = servingBoth();
  const { runs, runJava } = recordingJava();
  return { fetchImpl, calls, runs, runJava, paperSettingsPath: paperSettingsFile(ctx), ...extra };
}

test("serverJarName is server.jar for vanilla and paper-<version>-<build>.jar for Paper", () => {
  const { manifest } = paperContext();
  assert.equal(serverJarName(manifest, "vanilla"), "server.jar");
  assert.equal(serverJarName(manifest, "paper"), PAPER_JAR);
});

test("paper: downloads both jars and checks the paper sha256", async () => {
  const ctx = paperContext();
  const deps = paperDeps(ctx);
  const result = await server(ctx, true, deps);
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(deps.calls, [ctx.manifest.minecraft.jar.url, PAPER_URL]);
  assert.deepEqual(readFileSync(serverFile(ctx, "server.jar")), jarBytes);
  assert.deepEqual(readFileSync(serverFile(ctx, PAPER_JAR)), paperBytes);
  assert.match(result.detail, /Paper/u);
});

test("paper: a download with the wrong sha256 fails the step, is deleted and leaves no eula or properties", async () => {
  const ctx = paperContext();
  const result = await server(ctx, true, paperDeps(ctx, { fetchImpl: servingBoth(Buffer.from("not paper")).fetchImpl }));
  assert.ok(!result.ok);
  assert.match(result.error, /Checksum mismatch/u);
  assert.equal(existsSync(serverFile(ctx, PAPER_JAR)), false);
  assert.equal(existsSync(serverFile(ctx, "server.properties")), false);
});

test("vanilla (chosen, or no program in the settings): no paper download, no paper jar, no paper settings, Java never run", async () => {
  const noProgram = { ...paperContext(), settings: { server: { kind: "local", port: 25565, memoryMb: 4096 } } as Settings };
  for (const ctx of [paperContext("vanilla"), noProgram]) {
    const deps = paperDeps(ctx);
    assert.ok((await server(ctx, true, deps)).ok);
    assert.deepEqual(deps.calls, [ctx.manifest.minecraft.jar.url]);
    assert.deepEqual(readdirSync(join(ctx.root, "server")).filter((name) => name.startsWith("paper") || name === "spigot.yml" || name === "config" || name === "cache"), []);
    assert.deepEqual(deps.runs, []);
  }
});

test("a bumped build replaces the old jar, removed only after the new one passes its hash", async () => {
  const ctx = paperContext();
  mkdirSync(join(ctx.root, "server"), { recursive: true });
  const old = serverFile(ctx, "paper-1.21.4-231.jar");
  writeFileSync(old, "the old build");
  const bad = await server(ctx, true, paperDeps(ctx, { fetchImpl: servingBoth(Buffer.from("not paper")).fetchImpl }));
  assert.ok(!bad.ok);
  assert.ok(existsSync(old), "a hash failure leaves the old build in place");
  const good = await server(ctx, true, paperDeps(ctx));
  assert.ok(good.ok);
  assert.equal(existsSync(old), false);
  assert.ok(existsSync(serverFile(ctx, PAPER_JAR)));
  assert.ok(existsSync(serverFile(ctx, "server.jar")), "vanilla's jar is never taken for an old Paper build");
});

test("a locked old jar is no step failure: the detail names the file left behind", async () => {
  const ctx = paperContext();
  mkdirSync(join(ctx.root, "server"), { recursive: true });
  writeFileSync(serverFile(ctx, "paper-1.21.4-231.jar"), "the old build");
  const removeFile = async (path: string) => {
    throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path}'`), { code: "EBUSY" });
  };
  const result = await server(ctx, true, paperDeps(ctx, { removeFile }));
  assert.ok(result.ok, JSON.stringify(result));
  assert.match(result.detail, /paper-1\.21\.4-231\.jar/u);
  assert.ok(existsSync(serverFile(ctx, PAPER_JAR)));
});

test("an old jar that cannot be removed for another reason fails the step with the folder to clean by hand", async () => {
  const ctx = paperContext();
  mkdirSync(join(ctx.root, "server"), { recursive: true });
  writeFileSync(serverFile(ctx, "paper-1.21.4-231.jar"), "the old build");
  const removeFile = async () => {
    throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
  };
  const result = await server(ctx, true, paperDeps(ctx, { removeFile }));
  assert.ok(!result.ok);
  assert.match(result.hint, /Remove the old Paper jars in .*server/u);
});

test("paper download stops when the drive is short: the guard needs the jar plus its first-start files", async () => {
  const run = (extra: number) => {
    const { ctx, disk } = onDiskWith(paperContext(), GIB + paperBytes.length + PAPER_INSTALLED_BYTES + extra);
    return { ctx, result: server(ctx, true, { ...paperDeps(ctx), disk }) };
  };
  const short = run(-1);
  const refused = await short.result;
  assert.ok(!refused.ok);
  assert.match(refused.error, /^Not enough free space on \S+ for the Paper server/u);
  assert.equal(existsSync(serverFile(short.ctx, `${PAPER_JAR}.part`)), false);
  assert.equal(existsSync(serverFile(short.ctx, "eula.txt")), false);
  assert.ok((await run(0).result).ok, "exactly enough room is enough");
});

test("paper: settings applied from the settings file, keys we do not name kept", async () => {
  const ctx = paperContext();
  mkdirSync(join(ctx.root, "server", "config"), { recursive: true });
  writeFileSync(serverFile(ctx, "config/paper-world-defaults.yml"), "_version: 31\nentities:\n  spawning:\n    per-player-mob-spawns: true\n    despawn-ranges: 1\n");
  assert.ok((await server(ctx, true, paperDeps(ctx))).ok);
  const spigot = Bun.YAML.parse(readFileSync(serverFile(ctx, "spigot.yml"), "utf8")) as any;
  assert.equal(spigot["world-settings"].default["entity-activation-range"].monsters, 24);
  const world = Bun.YAML.parse(readFileSync(serverFile(ctx, "config/paper-world-defaults.yml"), "utf8")) as any;
  assert.equal(world.entities.spawning["per-player-mob-spawns"], false);
  assert.equal(world.entities.spawning["despawn-ranges"], 1);
  assert.equal(world._version, 31);
});

test("paper: the shipped settings file is the default and applies", async () => {
  const ctx = paperContext();
  const { paperSettingsPath: _own, ...deps } = paperDeps(ctx);
  assert.ok((await server(ctx, true, deps)).ok);
  assert.ok(existsSync(serverFile(ctx, "spigot.yml")));
});

test("paper: a config file Paper's settings cannot be merged into fails the step, naming the file and what to do", async () => {
  const ctx = paperContext();
  mkdirSync(join(ctx.root, "server"), { recursive: true });
  writeFileSync(serverFile(ctx, "spigot.yml"), "[unclosed");
  const result = await server(ctx, true, paperDeps(ctx));
  assert.ok(!result.ok);
  assert.match(result.error, /spigot\.yml/u);
  assert.match(result.hint, /Fix or delete the config file/u);
});

test("paper: Paperclip is prepared as measured, from vanilla's jar placed in its cache and a patch-only start", async () => {
  const ctx = paperContext();
  const seen: { cache?: Buffer } = {};
  const { runs, runJava } = recordingJava(0, () => {
    seen.cache = readFileSync(serverFile(ctx, "cache/mojang_1.21.4.jar"));
  });
  const labels: string[] = [];
  const result = await server({ ...ctx, onProgress: (_fraction, label) => void labels.push(label) }, true, paperDeps(ctx, { runJava }));
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(runs.length, 1);
  assert.match(runs[0].command, /java/u);
  assert.deepEqual(runs[0].args, ["-Dpaperclip.patchonly=true", "-jar", PAPER_JAR]);
  assert.equal(runs[0].cwd, join(ctx.root, "server"));
  assert.deepEqual(seen.cache, jarBytes, "Paperclip finds Mojang's jar in its cache and downloads nothing");
  assert.ok(labels.some((label) => /Paper/u.test(label) && /prepar/iu.test(label)), labels.join(" | "));
});

test("paper: a cache jar already there is not overwritten", async () => {
  const ctx = paperContext();
  mkdirSync(join(ctx.root, "server", "cache"), { recursive: true });
  writeFileSync(serverFile(ctx, "cache/mojang_1.21.4.jar"), "kept");
  assert.ok((await server(ctx, true, paperDeps(ctx))).ok);
  assert.equal(readFileSync(serverFile(ctx, "cache/mojang_1.21.4.jar"), "utf8"), "kept");
});

test("paper: a failed preparation is no step failure: the detail says the first play downloads", async () => {
  const noJava = async (): Promise<number> => {
    throw Object.assign(new Error("spawn java ENOENT"), { code: "ENOENT" });
  };
  const timedOut = async (): Promise<number> => {
    throw Object.assign(new Error("Command failed: java (timed out)"), { code: null, killed: true });
  };
  for (const runJava of [recordingJava(1).runJava, noJava, timedOut]) {
    const ctx = paperContext();
    const result = await server(ctx, true, paperDeps(ctx, { runJava }));
    assert.ok(result.ok, JSON.stringify(result));
    assert.match(result.detail, /first play/u);
    assert.ok(existsSync(serverFile(ctx, PAPER_JAR)));
  }
});

test("paper: a second run makes no request; once versions holds the patched jar it needs no room for the first-start files and still prepares again (a bump re-patches)", async () => {
  const ctx = paperContext();
  await server(ctx, true, paperDeps(ctx));
  const { ctx: tight, disk } = onDiskWith(ctx, GIB);
  const unprepared = paperDeps(tight, { disk });
  assert.match((await server(tight, false, unprepared) as { error?: string }).error ?? "", /^Not enough free space on \S+ for its first-start files/u);
  mkdirSync(serverFile(ctx, "versions/1.21.4"), { recursive: true });
  writeFileSync(serverFile(ctx, "versions/1.21.4/paper-1.21.4.jar"), "patched");
  const again = paperDeps(tight, { disk });
  assert.ok((await server(tight, false, again)).ok);
  assert.deepEqual(again.calls, []);
  assert.equal(again.runs.length, 1);
});

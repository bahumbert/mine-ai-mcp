import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import {
  buildWindows,
  findInnoCompiler,
  isStagedPath,
  listPersonaFiles,
  listStagedFiles,
  parseBuildArgs,
  toInnoSignTool,
  type BuildDeps,
} from "./build-windows.ts";

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "mine-ai-build-"));
}

function touch(root: string, relativePath: string, content = "x"): void {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** The shape of the real patch name: `bun install` reads it from `package.json` and `bun.lock`, and exits 1 when it is missing. */
const PATCH_FILE = "patches/dep@github%3Aowner%2Fdep#abc1234.patch";

/** The keys of `packaging/manifest.json` that the build reads, in its order, as the file writes them (2-space indent, final newline). */
const FIXTURE_MANIFEST = {
  version: "0.1.0",
  minecraft: { version: "1.21.4" },
  bun: { url: "https://example.test/bun.zip", sha256: "ab".repeat(32) },
  defaultBots: ["ayla"],
};
const FIXTURE_MANIFEST_TEXT = `${JSON.stringify(FIXTURE_MANIFEST, null, 2)}\n`;

/** A repository as the build sees it: the public app, the private links and developer folders that must stay out. */
function fakeRepository(): string {
  const root = scratchDir();
  for (const file of [
    "src/server/host.ts", "src/server/host.test.ts", "src/navigation/search/fixtures/staircase-region.ts",
    "brain/src/main.ts", "brain/src/main.test.ts", "brain/building-styles/rustic.json",
    "launcher/src/main.ts", "launcher/src/main.test.ts", "launcher/src/install/java.ts",
    "launcher/src/install/fixtures/status.bin", "launcher/src/build/build-windows.ts",
    "packaging/windows/mine-ai.iss",
    PATCH_FILE, "bun.lock", "LICENSE",
    ".agent/specs/secret.md", "monitor/src/main.ts", "personas/real-world/someone.json", "personas/ayla.json",
  ]) touch(root, file);
  touch(root, "packaging/manifest.json", FIXTURE_MANIFEST_TEXT);
  touch(root, "package.json", JSON.stringify({ name: "app", patchedDependencies: { "dep@1.0.0": PATCH_FILE } }));
  return root;
}

function stagedOf(root: string): string[] {
  return listStagedFiles(root).sort();
}

test("the staged list has the public app and none of the private or test files", () => {
  const root = fakeRepository();
  try {
    assert.deepEqual(stagedOf(root), [
      "LICENSE", "brain/building-styles/rustic.json", "brain/src/main.ts", "bun.lock", "launcher/src/install/java.ts",
      "launcher/src/main.ts", "package.json", "packaging/manifest.json", PATCH_FILE, "src/server/host.ts",
    ].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a patch the package.json names but the repository lacks fails naming it, before any install", () => {
  const root = fakeRepository();
  try {
    rmSync(join(root, PATCH_FILE));
    assert.throws(() => listStagedFiles(root), /BUILD_PATCH_MISSING.*dep@1\.0\.0.*patch/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real repository's package.json names only patches the staged list holds", () => {
  const repoRoot = join(import.meta.dirname, "..", "..", "..");
  const patched = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { patchedDependencies?: Record<string, string> }).patchedDependencies ?? {};
  assert.notEqual(Object.keys(patched).length, 0);
  for (const patch of Object.values(patched)) assert.equal(listStagedFiles(repoRoot).includes(patch), true, patch);
});

test("a path under a private, test or fixture folder is never staged, wherever it sits", () => {
  for (const excluded of [
    ".agent/x.ts", "brain/src/.agent/x.ts", "monitor/src/main.ts", "src/monitor/x.ts",
    "src/a.test.ts", "brain/src/nested/b.test.ts", "launcher/src/install/fixtures/login.bin", "launcher/src/build/x.ts",
    "packaging/windows/mine-ai.iss",
  ]) assert.equal(isStagedPath(excluded), false, excluded);
  for (const included of ["src/server/host.ts", "brain/src/main.ts", "packaging/manifest.json", "launcher/src/main.ts"]) {
    assert.equal(isStagedPath(included), true, included);
  }
});

test("a link inside a staged folder is not followed, so a link into the private repository ships nothing", () => {
  const root = fakeRepository();
  const outside = scratchDir();
  try {
    touch(outside, "private.ts", "secret");
    // "junction" because a Windows user without the symlink privilege (no Developer Mode) gets EPERM for a "dir" link, and
    // Bun 1.4.2 lists a junction as a symbolic link (probe 2026-11-06), so it tests the same skip; off Windows the type is ignored.
    symlinkSync(outside, join(root, "src", "private-link"), "junction");
    assert.equal(stagedOf(root).some((file) => file.includes("private")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a missing staged entry fails naming it, so no installer ships without its LICENSE or lockfile", () => {
  const root = fakeRepository();
  try {
    rmSync(join(root, "LICENSE"));
    assert.throws(() => listStagedFiles(root), /LICENSE/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("personas are the json files of the top level only", () => {
  const personas = scratchDir();
  try {
    for (const file of ["ayla.json", "brea.json", "notes.txt", "real-world/x.json", "sub/y.json"]) touch(personas, file);
    assert.deepEqual(listPersonaFiles(personas).sort(), ["ayla.json", "brea.json"]);
  } finally {
    rmSync(personas, { recursive: true, force: true });
  }
});

test("the committed public personas hold every default bot, each a persona file with its own id", () => {
  const repoRoot = join(import.meta.dirname, "..", "..", "..");
  const manifest = JSON.parse(readFileSync(join(repoRoot, "packaging", "manifest.json"), "utf8")) as { defaultBots: string[] };
  const publicPersonas = join(repoRoot, "packaging", "personas");
  const files = listPersonaFiles(publicPersonas);
  for (const id of manifest.defaultBots) {
    assert.ok(files.includes(`${id}.json`), `packaging/personas has no ${id}.json for the manifest's defaultBots`);
  }
  for (const file of files) {
    const persona = JSON.parse(readFileSync(join(publicPersonas, file), "utf8")) as { id?: unknown; username?: unknown };
    assert.equal(typeof persona.username, "string", `${file} has no string username`);
    assert.equal(persona.id, file.slice(0, -".json".length), `${file} id does not match its file name`);
  }
});

test("the sign command becomes an Inno Setup SignTool command with its file placeholder", () => {
  assert.equal(
    toInnoSignTool('signtool sign /f "my cert.pfx" /p $ecret {file}'),
    "signtool sign /f $qmy cert.pfx$q /p $$ecret $f",
  );
  assert.throws(() => toInnoSignTool("signtool sign /f cert.pfx"), /\{file\}/u);
});

test("the arguments need --personas and --out, and keep the sign command", () => {
  assert.deepEqual(parseBuildArgs(["--personas", "p", "--out", "o", "--sign-command", "s {file}"]), {
    personasDir: "p", outDir: "o", signCommand: "s {file}", version: undefined,
  });
  assert.deepEqual(parseBuildArgs(["--personas", "p", "--out", "o"]), { personasDir: "p", outDir: "o", signCommand: undefined, version: undefined });
  assert.throws(() => parseBuildArgs(["--out", "o"]), /--personas/u);
  assert.throws(() => parseBuildArgs(["--personas", "p"]), /--out/u);
});

test("--version takes x.y.z only: a v prefix or a short number is refused", () => {
  const base = ["--personas", "p", "--out", "o"];
  assert.equal(parseBuildArgs([...base, "--version", "0.2.0"]).version, "0.2.0");
  for (const bad of ["v0.2.0", "0.2", "0.2.0.1", "0.2.x", ""]) {
    assert.throws(() => parseBuildArgs([...base, "--version", bad]), /\[BUILD_ARGS\].*--version/u, bad);
  }
});

test("Inno Setup is found from INNO_SETUP, else the default folders, else the error says how to set it", () => {
  const present = new Set(["D:\\Inno\\ISCC.exe", "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe"]);
  const exists = (file: string): boolean => present.has(file);
  assert.equal(findInnoCompiler({ INNO_SETUP: "D:\\Inno" }, exists), "D:\\Inno\\ISCC.exe");
  assert.equal(findInnoCompiler({}, exists), "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe");
  const perUser = (file: string): boolean => file === "C:\\Users\\Rémi\\AppData\\Local\\Programs\\Inno Setup 6\\ISCC.exe";
  assert.equal(findInnoCompiler({ LOCALAPPDATA: "C:\\Users\\Rémi\\AppData\\Local" }, perUser), "C:\\Users\\Rémi\\AppData\\Local\\Programs\\Inno Setup 6\\ISCC.exe");
  assert.throws(() => findInnoCompiler({ INNO_SETUP: "E:\\none" }, () => false), /INNO_SETUP/u);
});

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

function fakeDeps(options: { readonly defaultBots?: readonly string[]; readonly failOn?: string } = {}) {
  const calls: Call[] = [];
  const downloads: { url: string; dest: string; hash: unknown }[] = [];
  const deps: BuildDeps = {
    manifest: { version: "0.1.0", minecraft: { version: "1.21.4" }, bun: { url: "https://example.test/bun.zip", sha256: "ab".repeat(32) }, defaultBots: options.defaultBots ?? ["ayla"] },
    env: { SystemRoot: "C:\\Windows" },
    innoCompiler: "C:\\ISCC.exe",
    bunProgram: "C:\\bun.exe",
    async packageApp(stageDir, appDir) {
      calls.push({ command: "packageApp", args: [stageDir, appDir], cwd: "" });
      if (options.failOn === "packageApp") throw new Error("packageApp failed");
      touch(appDir, "launcher/src/main.js");
    },
    async downloadVerified(url, dest, hash) {
      downloads.push({ url, dest, hash });
      writeFileSync(dest, "zip");
    },
    async run(command, args, cwd) {
      calls.push({ command, args, cwd });
      if (command === options.failOn) throw new Error(`${command} failed`);
      const extractTo = command.endsWith("tar.exe") ? args[args.indexOf("-C") + 1] : undefined;
      if (extractTo !== undefined) touch(extractTo, "bun-windows-x64/bun.exe", "bunexe");
    },
  };
  return { deps, calls, downloads };
}

function buildInputs(root: string): { personasDir: string; outDir: string } {
  const personasDir = join(root, "personas-in");
  touch(personasDir, "ayla.json", '{"username":"Ayla"}');
  touch(personasDir, "real-world/x.json");
  return { personasDir, outDir: join(root, "out") };
}

test("the build stages app, personas and Bun, installs production packages, bundles the app, then compiles it with the signature", async () => {
  const root = fakeRepository();
  const { personasDir, outDir } = buildInputs(root);
  const { deps, calls, downloads } = fakeDeps();
  try {
    await buildWindows({ repoRoot: root, personasDir, outDir, signCommand: "sign {file}" }, deps);
    const stage = join(outDir, "stage");
    assert.equal(existsSync(join(stage, "src/server/host.ts")), true);
    assert.equal(existsSync(join(stage, ".agent")), false);
    assert.equal(readFileSync(join(stage, "personas/ayla.json"), "utf8"), '{"username":"Ayla"}');
    assert.equal(existsSync(join(stage, "personas/real-world")), false);
    assert.equal(readFileSync(join(stage, "bun.exe"), "utf8"), "bunexe");
    assert.deepEqual(downloads.map((download) => [download.url, download.hash]), [["https://example.test/bun.zip", { sha256: "ab".repeat(32) }]]);
    assert.deepEqual(calls.map((call) => call.command), ["C:\\bun.exe", "C:\\Windows\\System32\\tar.exe", "packageApp", "C:\\ISCC.exe"]);
    assert.deepEqual(calls[0], { command: "C:\\bun.exe", args: ["install", "--frozen-lockfile", "--production"], cwd: stage });
    const app = join(outDir, "app");
    assert.deepEqual(calls[2]!.args, [stage, app]);
    const compile = calls[3]!;
    // The installer packs the built app folder, not the stage (the stage still holds the sources and every node_modules).
    assert.deepEqual(compile.args.slice(0, 5), [`/DStageDir=${app}`, `/DOutputDir=${outDir}`, "/DAppVersion=0.1.0", "/DSign=1", "/SMineAiSign=sign $f"]);
    assert.equal(compile.args.at(-1)!.endsWith("mine-ai.iss"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--version is the version: a manifest saying another one does not stop the build; the compile and the staged manifest take the given one, the checkout's file stays", async () => {
  const root = fakeRepository();
  const { personasDir, outDir } = buildInputs(root);
  const { deps, calls } = fakeDeps();
  try {
    await buildWindows({ repoRoot: root, personasDir, outDir, version: "0.3.0" }, deps);
    assert.equal(calls.at(-1)!.args.includes("/DAppVersion=0.3.0"), true);
    const source = readFileSync(join(root, "packaging/manifest.json"), "utf8");
    assert.equal(source, FIXTURE_MANIFEST_TEXT, "the repository's manifest is never written");
    // Same keys in the same order, same 2-space layout and final newline: only the "version" value differs.
    assert.equal(readFileSync(join(outDir, "stage/packaging/manifest.json"), "utf8"), source.replace('"version": "0.1.0"', '"version": "0.3.0"'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without --version a local build keeps the manifest's version in the compile and in the staged manifest", async () => {
  const root = fakeRepository();
  const { personasDir, outDir } = buildInputs(root);
  const { deps, calls } = fakeDeps();
  try {
    await buildWindows({ repoRoot: root, personasDir, outDir }, deps);
    assert.equal(calls.at(-1)!.args.includes("/DAppVersion=0.1.0"), true);
    assert.equal(readFileSync(join(outDir, "stage/packaging/manifest.json"), "utf8"), FIXTURE_MANIFEST_TEXT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the staged manifest carries the given version when the app is packed, not only afterwards", async () => {
  const root = fakeRepository();
  const { personasDir, outDir } = buildInputs(root);
  const { deps } = fakeDeps();
  const packed: string[] = [];
  const packApp = deps.packageApp;
  try {
    await buildWindows({ repoRoot: root, personasDir, outDir, version: "0.3.0" }, {
      ...deps,
      async packageApp(stageDir, appDir) {
        packed.push((JSON.parse(readFileSync(join(stageDir, "packaging/manifest.json"), "utf8")) as { version: string }).version);
        await packApp(stageDir, appDir);
      },
    });
    assert.deepEqual(packed, ["0.3.0"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a relative --out becomes absolute, since ISCC resolves relative defines from the script's folder", async () => {
  const root = fakeRepository();
  const { personasDir } = buildInputs(root);
  const { deps, calls } = fakeDeps();
  const relativeOut = relative(process.cwd(), join(root, "out"));
  try {
    await buildWindows({ repoRoot: root, personasDir, outDir: relativeOut }, deps);
    assert.deepEqual(calls.at(-1)!.args.slice(0, 2), [`/DStageDir=${join(root, "out", "app")}`, `/DOutputDir=${join(root, "out")}`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without a sign command the compile has no SignTool define", async () => {
  const root = fakeRepository();
  const { personasDir, outDir } = buildInputs(root);
  const { deps, calls } = fakeDeps();
  try {
    await buildWindows({ repoRoot: root, personasDir, outDir }, deps);
    assert.equal(calls.at(-1)!.args.some((arg) => arg.startsWith("/DSign") || arg.startsWith("/S")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a default bot without a persona file fails before anything is staged", async () => {
  const root = fakeRepository();
  const { personasDir, outDir } = buildInputs(root);
  const { deps, calls } = fakeDeps({ defaultBots: ["ayla", "brea"] });
  try {
    await assert.rejects(buildWindows({ repoRoot: root, personasDir, outDir }, deps), /brea/u);
    assert.equal(calls.length, 0);
    assert.equal(existsSync(join(outDir, "stage")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed package install stops the build before Bun is downloaded or Inno Setup runs", async () => {
  const root = fakeRepository();
  const { personasDir, outDir } = buildInputs(root);
  const { deps, calls, downloads } = fakeDeps({ failOn: "C:\\bun.exe" });
  try {
    await assert.rejects(buildWindows({ repoRoot: root, personasDir, outDir }, deps), /failed/u);
    assert.equal(downloads.length, 0);
    assert.deepEqual(calls.map((call) => call.command), ["C:\\bun.exe"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed bundle stops the build before Inno Setup runs", async () => {
  const root = fakeRepository();
  const { personasDir, outDir } = buildInputs(root);
  const { deps, calls } = fakeDeps({ failOn: "packageApp" });
  try {
    await assert.rejects(buildWindows({ repoRoot: root, personasDir, outDir }, deps), /packageApp failed/u);
    assert.equal(calls.some((call) => call.command === "C:\\ISCC.exe"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stage and an app folder left by an earlier build are emptied first", async () => {
  const root = fakeRepository();
  const { personasDir, outDir } = buildInputs(root);
  const { deps } = fakeDeps();
  try {
    touch(outDir, "stage/src/removed-since.ts");
    touch(outDir, "app/src/removed-since.js");
    await buildWindows({ repoRoot: root, personasDir, outDir }, deps);
    assert.equal(existsSync(join(outDir, "stage/src/removed-since.ts")), false);
    assert.equal(existsSync(join(outDir, "app/src/removed-since.js")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

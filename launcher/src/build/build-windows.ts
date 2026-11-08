/**
 * The Windows release build, run by the master on Windows Bun: stages the public app, the personas and Bun, then
 * compiles `packaging/windows/mine-ai.iss` with Inno Setup (signing it when a sign command is given).
 *   bun launcher/src/build/build-windows.ts --personas <dir> --out <dir> [--sign-command "<cmd with {file}>"] [--version <x.y.z>]
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { packageApp } from "./bundle.ts";

/** Folders of the repository that ship, relative to its root (the `brain/` and `launcher/` tests and the rest stay out). */
const STAGED_FOLDERS = ["src", "brain/src", "brain/building-styles", "launcher/src", "packaging", "patches"] as const;
const STAGED_FILES = ["package.json", "bun.lock", "LICENSE"] as const;
/** A path with one of these segments is never shipped: private repository, monitor, recorded test packets. */
const EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set([".agent", "monitor", "fixtures"]);
/** Build-only folders: the build script and the Inno Setup script run on the build machine, never on the player's. */
const EXCLUDED_PREFIXES = ["launcher/src/build", "packaging/windows"] as const;
const INNO_SIGN_TOOL_NAME = "MineAiSign";
const INNO_DEFAULT_FOLDERS = ["C:\\Program Files (x86)\\Inno Setup 6", "C:\\Program Files\\Inno Setup 6"] as const;
const VERSION_SHAPE = /^\d+\.\d+\.\d+$/u;
const USAGE = 'usage: bun launcher/src/build/build-windows.ts --personas <dir> --out <dir> [--sign-command "<command with {file}>"] [--version <x.y.z>]';

export interface BuildOptions {
  readonly repoRoot: string;
  readonly personasDir: string;
  readonly outDir: string;
  readonly signCommand?: string;
  /** The version of the setup and of the shipped manifest when given (the tag's, passed by the release script and the workflow); else the manifest's. */
  readonly version?: string;
}

/** What the build needs from the outside, so the staging logic runs in tests without a download or Inno Setup. */
export interface BuildDeps {
  readonly manifest: {
    readonly version: string;
    readonly minecraft: { readonly version: string };
    readonly bun: { readonly url: string; readonly sha256: string };
    readonly defaultBots: readonly string[];
  };
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly innoCompiler: string;
  /** The Windows Bun that runs this script; it installs the production packages. */
  readonly bunProgram: string;
  downloadVerified(url: string, dest: string, hash: { sha256: string }): Promise<void>;
  /** Turns the staged package (sources, production `node_modules`, Bun, personas) into the app folder the installer packs. */
  packageApp(stageDir: string, appDir: string): Promise<void>;
  run(command: string, args: readonly string[], cwd: string): Promise<void>;
}

/** True when a repository-relative path (forward slashes) may ship. */
export function isStagedPath(relativePath: string): boolean {
  if (relativePath.endsWith(".test.ts")) return false;
  if (relativePath.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false;
  return !EXCLUDED_PREFIXES.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`));
}

/** Files under `directory` that may ship, as paths relative to `base`; links are skipped: one into the private repository must ship nothing. */
function walkStagedFiles(base: string, directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(base, directory), { withFileTypes: true })) {
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink() || !isStagedPath(relativePath)) continue;
    if (entry.isDirectory()) files.push(...walkStagedFiles(base, relativePath));
    else files.push(relativePath);
  }
  return files;
}

/** Every file the package holds from the repository; a missing folder or file fails, so nothing ships half-built. */
export function listStagedFiles(repoRoot: string): string[] {
  const files: string[] = [];
  for (const folder of STAGED_FOLDERS) {
    if (!existsSync(join(repoRoot, folder))) throw new Error(`[BUILD_MISSING] ${folder} is not in ${repoRoot}.`);
    files.push(...walkStagedFiles(repoRoot, folder));
  }
  for (const file of STAGED_FILES) {
    if (!existsSync(join(repoRoot, file))) throw new Error(`[BUILD_MISSING] ${file} is not in ${repoRoot}.`);
    files.push(file);
  }
  requirePatchFiles(repoRoot, files);
  return files;
}

/** `bun install` exits 1 on a patch file `package.json` names but the stage lacks, even for a dev dependency it skips: fail here, naming it. */
function requirePatchFiles(repoRoot: string, staged: readonly string[]): void {
  const { patchedDependencies = {} } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { patchedDependencies?: Record<string, string> };
  for (const [dependency, patch] of Object.entries(patchedDependencies)) {
    if (!staged.includes(patch)) throw new Error(`[BUILD_PATCH_MISSING] package.json patches ${dependency} with ${patch}, which is not in ${repoRoot} or not staged.`);
  }
}

/** The persona files (`*.json`, top level only) of the folder the build was given. */
export function listPersonaFiles(personasDir: string): string[] {
  return readdirSync(personasDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name);
}

/** `--sign-command` with `{file}` as Inno Setup's `/S` command: `$f` for the file, `$q` for a quote, `$$` for a dollar. */
export function toInnoSignTool(command: string): string {
  const parts = command.split("{file}");
  if (parts.length < 2) throw new Error(`[BUILD_SIGN_COMMAND] The sign command has no {file} placeholder, so it would sign nothing: ${command}`);
  return parts.map((part) => part.replaceAll("$", "$$$$").replaceAll('"', "$q")).join("$f");
}

/** `ISCC.exe` from the `INNO_SETUP` folder, else the default install folders. */
export function findInnoCompiler(env: Readonly<Record<string, string | undefined>>, exists: (file: string) => boolean): string {
  const userFolder = env.LOCALAPPDATA === undefined ? [] : [win32.join(env.LOCALAPPDATA, "Programs", "Inno Setup 6")];
  const folders = env.INNO_SETUP === undefined ? [...INNO_DEFAULT_FOLDERS, ...userFolder] : [env.INNO_SETUP];
  const found = folders.map((folder) => win32.join(folder, "ISCC.exe")).find(exists);
  if (found === undefined) {
    throw new Error(`[BUILD_NO_INNO_SETUP] ISCC.exe not found in ${folders.join(", ")}. Install Inno Setup 6, or set INNO_SETUP to its folder.`);
  }
  return found;
}

export function parseBuildArgs(argv: readonly string[]): { personasDir: string; outDir: string; signCommand: string | undefined; version: string | undefined } {
  const { values } = parseArgs({
    args: [...argv],
    options: { personas: { type: "string" }, out: { type: "string" }, "sign-command": { type: "string" }, version: { type: "string" } },
  });
  if (values.personas === undefined) throw new Error(`[BUILD_ARGS] --personas is missing. ${USAGE}`);
  if (values.out === undefined) throw new Error(`[BUILD_ARGS] --out is missing. ${USAGE}`);
  if (values.version !== undefined && !VERSION_SHAPE.test(values.version)) {
    throw new Error(`[BUILD_ARGS] --version must look like 0.2.0 (no leading v), not "${values.version}". ${USAGE}`);
  }
  return { personasDir: values.personas, outDir: values.out, signCommand: values["sign-command"], version: values.version };
}

/**
 * The tag is the version (owner 2026-11-07): the installed launcher reads its own version from the shipped manifest (update
 * check, `doctor`), so the staged copy takes the given version, and only that key changes (same order, 2-space layout, final
 * newline). The repository's own `packaging/manifest.json` is never written.
 */
function setStagedManifestVersion(stageDir: string, version: string): void {
  const file = join(stageDir, "packaging", "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  manifest.version = version;
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function copyInto(fromRoot: string, toRoot: string, relativePaths: readonly string[]): void {
  for (const relativePath of relativePaths) {
    mkdirSync(dirname(join(toRoot, relativePath)), { recursive: true });
    copyFileSync(join(fromRoot, relativePath), join(toRoot, relativePath));
  }
}

/** The first file called `name` under `directory`, looking in sub-folders (the zip holds `bun-windows-x64/bun.exe`). */
function findFileNamed(directory: string, name: string): string | undefined {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    const nested = entry.isDirectory() ? findFileNamed(path, name) : undefined;
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** Downloads the pinned Bun zip (hash checked) and puts its `bun.exe` at the root of the stage, where the Start-menu entry runs it. */
async function stageBun(deps: BuildDeps, outDir: string, stageDir: string): Promise<void> {
  const cacheDir = join(outDir, "cache");
  const zip = join(cacheDir, "bun.zip");
  const extracted = join(cacheDir, "bun-extracted");
  rmSync(extracted, { recursive: true, force: true });
  mkdirSync(extracted, { recursive: true });
  await deps.downloadVerified(deps.manifest.bun.url, zip, { sha256: deps.manifest.bun.sha256 });
  // Windows' own bsdtar reads zip; a `tar` found on the PATH from Git Bash is GNU tar, which does not (review 2026-10-30).
  const windowsTar = win32.join(deps.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  await deps.run(windowsTar, ["-xf", zip, "-C", extracted], cacheDir);
  const bunExe = findFileNamed(extracted, "bun.exe");
  if (bunExe === undefined) throw new Error(`[BUILD_BUN_ZIP] ${deps.manifest.bun.url} holds no bun.exe.`);
  copyFileSync(bunExe, join(stageDir, "bun.exe"));
}

/** Fails before anything is staged when a bot the package starts by default has no persona file. */
function requireDefaultPersonas(deps: BuildDeps, personaFiles: readonly string[]): void {
  const missing = deps.manifest.defaultBots.filter((id) => !personaFiles.includes(`${id}.json`));
  if (missing.length > 0) {
    throw new Error(`[BUILD_PERSONA_MISSING] The manifest's defaultBots name ${missing.join(", ")} but the personas folder has no ${missing.map((id) => `${id}.json`).join(", ")}.`);
  }
}

function compilerArguments(options: BuildOptions, deps: BuildDeps, appDir: string): string[] {
  const signing = options.signCommand === undefined ? [] : ["/DSign=1", `/S${INNO_SIGN_TOOL_NAME}=${toInnoSignTool(options.signCommand)}`];
  return [
    `/DStageDir=${appDir}`,
    `/DOutputDir=${options.outDir}`,
    `/DAppVersion=${options.version ?? deps.manifest.version}`,
    ...signing,
    join(options.repoRoot, "packaging", "windows", "mine-ai.iss"),
  ];
}

/** Stages the package under `<out>/stage`, builds the app folder `<out>/app` from it, then compiles the installer of that folder into `<out>`. */
export async function buildWindows(given: BuildOptions, deps: BuildDeps): Promise<void> {
  // Absolute: ISCC resolves a relative define from the script's folder, not from where the build was started.
  const options = { ...given, outDir: resolve(given.outDir) };
  const personaFiles = listPersonaFiles(options.personasDir);
  requireDefaultPersonas(deps, personaFiles);
  const stageDir = join(options.outDir, "stage");
  const appDir = join(options.outDir, "app");
  rmSync(stageDir, { recursive: true, force: true });
  rmSync(appDir, { recursive: true, force: true });
  copyInto(options.repoRoot, stageDir, listStagedFiles(options.repoRoot));
  if (options.version !== undefined) setStagedManifestVersion(stageDir, options.version);
  copyInto(options.personasDir, join(stageDir, "personas"), personaFiles);
  await deps.run(deps.bunProgram, ["install", "--frozen-lockfile", "--production"], stageDir);
  await stageBun(deps, options.outDir, stageDir);
  await deps.packageApp(stageDir, appDir);
  await deps.run(deps.innoCompiler, compilerArguments(options, deps, appDir), options.repoRoot);
}

function runProgram(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`[BUILD_COMMAND] ${command} ${args.join(" ")} exited with ${code}`))));
  });
}

/** The real manifest and downloader (loaded here so the staging logic above tests alone). */
async function releaseDeps(repoRoot: string): Promise<BuildDeps> {
  const { loadManifest } = await import("../manifest.ts");
  const { downloadVerified } = await import("../install/download.ts");
  const manifest = loadManifest(join(repoRoot, "packaging", "manifest.json"));
  return {
    manifest,
    env: process.env,
    innoCompiler: findInnoCompiler(process.env, existsSync),
    bunProgram: process.execPath,
    downloadVerified,
    packageApp: (stageDir, appDir) => packageApp(stageDir, appDir, manifest.minecraft.version, process.execPath),
    run: runProgram,
  };
}

if (import.meta.main) {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const { personasDir, outDir, signCommand, version } = parseBuildArgs(process.argv.slice(2));
  await buildWindows({ repoRoot, personasDir, outDir, signCommand, version }, await releaseDeps(repoRoot));
  console.log(`Installer built in ${outDir}`);
}

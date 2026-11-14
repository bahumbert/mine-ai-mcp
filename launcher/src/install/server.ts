/**
 * Install step `server`: the pinned vanilla server jar (always: Paper starts from it), the Paper jar and its settings when
 * `settings.server.program` is `paper`, `server.properties` for bots, and `eula.txt` only when accepted.
 */
import { execFile } from "node:child_process";
import { totalmem } from "node:os";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Manifest } from "../manifest.ts";
import { appRoot } from "../paths.ts";
import type { ServerProgram } from "../settings.ts";
import type { DiskDeps } from "./disk.ts";
import { downloadFailureHint, downloadVerified } from "./download.ts";
import { javaPath } from "./java.ts";
import { applyPaperSettings, loadPaperSettings } from "./paper-settings.ts";
import { freeSpaceHint, guardDownload, spaceGuardFor } from "./space-guard.ts";
import { failure, FILE_LOCKED_HINT, isFileLockError, stepFailure, type InstallContext, type StepFailure, type StepResult } from "./step.ts";

const EULA_URL = "https://aka.ms/MinecraftEULA";
const GIB = 1024 ** 3;
const execFileAsync = promisify(execFile);

/**
 * The longest Paper's patch-only start may run before it is killed and the first play prepares instead. Measured 2.7 s with
 * Mojang's jar in `cache/`, 11-17 s for a whole first start (facts `paper-server.md` part C); 180 s is the Windows server-ready
 * budget of the same start, so a slow disk or a scanning antivirus has room and a hung start still ends.
 */
const PAPERCLIP_PREPARE_TIMEOUT_MS = 180_000;

/** The jar the chosen program starts from, in `<root>/server`: vanilla's `server.jar`, or Paper's `paper-<version>-<build>.jar`. */
export function serverJarName(manifest: Manifest, program: ServerProgram): string {
  return program === "paper" ? `paper-${manifest.minecraft.version}-${manifest.minecraft.paper.build}.jar` : "server.jar";
}

/** A Paper jar of any build: what a bumped build leaves behind (`paper-<version>-<build>.jar`; the pin's own name is kept). */
const PAPER_JAR_PATTERN = /^paper-.+\.jar$/u;

/** The text of an existing `server.properties` with `managed` keys set in place (others, comments and order kept), missing ones appended. */
function withManagedProperties(existing: string, managed: ReadonlyMap<string, string>): string {
  const pending = new Map(managed);
  const lines = existing === "" ? [] : existing.replace(/\r?\n$/u, "").split(/\r?\n/u);
  const updated = lines.map((line) => {
    const key = line.startsWith("#") ? "" : line.slice(0, Math.max(line.indexOf("="), 0));
    if (key === "" || !pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of pending) updated.push(`${key}=${value}`);
  return `${updated.join("\n")}\n`;
}

/** Server heap in MB: the manifest's MB per GiB of RAM, clamped between its min and max. */
export function serverMemoryMb(manifest: Manifest, totalRamBytes: number = totalmem()): number {
  const { min, perRamGb, max } = manifest.minecraft.memoryMb;
  return Math.min(max, Math.max(min, Math.floor((perRamGb * totalRamBytes) / GIB)));
}

async function isEulaAccepted(eulaPath: string): Promise<boolean> {
  if (!existsSync(eulaPath)) return false;
  return /^eula=true\s*$/mu.test(await readFile(eulaPath, "utf8"));
}

/** One Java start: the program, its arguments and the folder it runs in. */
export interface JavaRun {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface ServerDeps {
  readonly fetchImpl?: typeof fetch;
  /** The free-space reads of the guard; the real disk when absent. */
  readonly disk?: DiskDeps;
  /** The Paper settings file to apply; `packaging/paper-settings.json` of the app when absent. */
  readonly paperSettingsPath?: string;
  /** Runs Java and resolves with its exit code (rejects when it cannot start); the real `execFile` when absent. */
  readonly runJava?: (run: JavaRun) => Promise<number>;
  /** Deletes a file (an old Paper build); `rm` when absent. */
  readonly removeFile?: (path: string) => Promise<void>;
}

async function runJavaProcess(run: JavaRun): Promise<number> {
  try {
    await execFileAsync(run.command, [...run.args], { cwd: run.cwd, windowsHide: true, timeout: PAPERCLIP_PREPARE_TIMEOUT_MS });
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number") return code;
    throw error;
  }
}

/** Downloads `url` to `dest` under the guard; `needs` says what that puts on the drive. Null when the jar is there, else the step's failure. */
async function downloadJar(ctx: InstallContext, deps: ServerDeps, dest: string, what: string, source: { url: string; hash: Parameters<typeof downloadVerified>[2] }, needs: (downloadBytes: number) => { what: string; bytes: number }[], progress: [number, number]): Promise<StepFailure | null> {
  const dir = dirname(dest);
  const guard = spaceGuardFor(ctx, deps.disk, freeSpaceHint(), (downloadBytes) => needs(downloadBytes).map((need) => ({ ...need, folder: dir })));
  try {
    return await guardDownload(guard, existsSync(dest), (beforeBody) =>
      downloadVerified(source.url, dest, source.hash, (fraction) => ctx.onProgress(progress[0] + fraction * (progress[1] - progress[0]), `Downloading ${what}`), deps.fetchImpl, undefined, { beforeBody }),
    );
  } catch (error) {
    return stepFailure(error, downloadFailureHint(error));
  }
}

/**
 * Removes the jars of other Paper builds from `dir` (a bumped pin); called only once the pinned jar passed its hash. A jar
 * another program holds open (`EBUSY`, `EPERM`) is no failure: its name is returned so the step's detail says it stays.
 */
async function removeOldPaperJars(dir: string, keep: string, deps: ServerDeps): Promise<string[]> {
  const remove = deps.removeFile ?? ((path: string) => rm(path, { force: true }));
  const left: string[] = [];
  for (const name of (await readdir(dir)).filter((entry) => PAPER_JAR_PATTERN.test(entry) && entry !== keep)) {
    try {
      await remove(join(dir, name));
    } catch (error) {
      if (!isFileLockError(error)) throw error;
      left.push(name);
    }
  }
  return left;
}

/**
 * Paperclip's own first start does what we can do now: with Mojang's jar in `cache/` it downloads nothing, and
 * `-Dpaperclip.patchonly=true` builds `libraries/` and `versions/` and exits (measured, facts `paper-server.md` part C).
 * Returns a sentence for the detail when it did not work: the first play then does it, so it is no step failure.
 */
async function preparePaperclip(ctx: InstallContext, deps: ServerDeps, dir: string, paperJar: string): Promise<string | null> {
  ctx.onProgress(0.96, "Preparing the Paper server");
  const cached = join(dir, "cache", `mojang_${ctx.manifest.minecraft.version}.jar`);
  if (!existsSync(cached)) {
    await mkdir(join(dir, "cache"), { recursive: true });
    // copied under a temporary name: a cut copy must not stay as the file Paperclip trusts
    await copyFile(join(dir, serverJarName(ctx.manifest, "vanilla")), `${cached}.part`);
    await rename(`${cached}.part`, cached);
  }
  try {
    const exitCode = await (deps.runJava ?? runJavaProcess)({ command: javaPath(ctx.root), args: ["-Dpaperclip.patchonly=true", "-jar", paperJar], cwd: dir });
    return exitCode === 0 ? null : `Paper's preparation ended with code ${exitCode}: the first play downloads and prepares what is left.`;
  } catch (error) {
    return `Paper could not be prepared now (${error instanceof Error ? error.message : String(error)}): the first play downloads and prepares what is left.`;
  }
}

/** The installed Paper's first-start files are all there: the patched jar is in `versions/`. */
const isPaperPrepared = (dir: string, manifest: Manifest) => existsSync(join(dir, "versions", manifest.minecraft.version, `paper-${manifest.minecraft.version}.jar`));

/** Paper's part of the step: its jar, the old builds out, its settings merged, Paperclip prepared. Returns the detail's extra sentences or the failure. */
async function installPaper(ctx: InstallContext, deps: ServerDeps, dir: string): Promise<string[] | StepFailure> {
  const { paper } = ctx.manifest.minecraft;
  const jarName = serverJarName(ctx.manifest, "paper");
  const jar = join(dir, jarName);
  const installedBytes = existsSync(jar) && isPaperPrepared(dir, ctx.manifest) ? 0 : paper.installedBytes;
  const needs = (downloadBytes: number) => [
    { what: "the Paper server", bytes: downloadBytes },
    { what: "its first-start files", bytes: installedBytes },
  ];
  const failed = await downloadJar(ctx, deps, jar, "the Paper server", { url: paper.url, hash: { sha256: paper.sha256 } }, needs, [0.4, 0.9]);
  if (failed !== null) return failed;
  const notes: string[] = [];
  try {
    const left = await removeOldPaperJars(dir, jarName, deps);
    if (left.length > 0) notes.push(`${left.join(", ")} could not be removed (${FILE_LOCKED_HINT}) and stays beside ${jarName}.`);
  } catch (error) {
    return stepFailure(error, `Remove the old Paper jars in ${dir} by hand, then run the step again.`);
  }
  try {
    await applyPaperSettings(dir, loadPaperSettings(deps.paperSettingsPath ?? join(appRoot(), "packaging", "paper-settings.json")));
  } catch (error) {
    return stepFailure(error, `Fix or delete the config file the error names (Paper writes a new one at its first start), then run the step again. Server folder: ${dir}.`);
  }
  const unprepared = await preparePaperclip(ctx, deps, dir, jarName);
  if (unprepared !== null) notes.push(unprepared);
  return notes;
}

/**
 * Downloads the jar and writes `server.properties` (`online-mode=false`, `server-ip=127.0.0.1`, the settings' port,
 * `difficulty=normal`; other keys of an existing file kept). `eula.txt` is written only with `acceptEula`; an
 * `eula.txt` already saying true (an earlier acceptance) lets an update run without the flag.
 */
export async function server(ctx: InstallContext, acceptEula: boolean, deps: ServerDeps = {}): Promise<StepResult> {
  const { server: serverSettings } = ctx.settings;
  if (serverSettings.kind !== "local") {
    return failure(`The settings choose a ${serverSettings.kind} server, not a local one.`, "Run `mine-ai configure --server-local` first, then this step again.");
  }
  const dir = join(ctx.root, "server");
  const eulaPath = join(dir, "eula.txt");
  if (!acceptEula && !(await isEulaAccepted(eulaPath))) {
    return failure("EULA not accepted.", `Read the Minecraft EULA (${EULA_URL}) and run this step with --accept-eula; the installer asks for it on its server page.`);
  }
  await mkdir(dir, { recursive: true });
  const { jar } = ctx.manifest.minecraft;
  const paper = serverSettings.program === "paper";
  const noVanilla = await downloadJar(ctx, deps, join(dir, serverJarName(ctx.manifest, "vanilla")),"the Minecraft server", { url: jar.url, hash: { sha1: jar.sha1 } }, (bytes) => [{ what: "the Minecraft server", bytes }], [0, paper ? 0.4 : 0.95]);
  if (noVanilla !== null) return noVanilla;
  const paperNotes = paper ? await installPaper(ctx, deps, dir) : [];
  if (!Array.isArray(paperNotes)) return paperNotes;
  const propertiesPath = join(dir, "server.properties");
  const existing = existsSync(propertiesPath) ? await readFile(propertiesPath, "utf8") : "";
  const managed = new Map([
    ["online-mode", "false"],
    ["server-ip", "127.0.0.1"],
    ["server-port", String(serverSettings.port)],
    ["difficulty", "normal"],
  ]);
  await writeFile(propertiesPath, withManagedProperties(existing, managed));
  if (acceptEula) await writeFile(eulaPath, `#By changing the setting below to TRUE you are indicating your agreement to our EULA (${EULA_URL}).\neula=true\n`);
  ctx.onProgress(1, "Minecraft server ready");
  const program = paper ? "Paper Minecraft" : "Minecraft";
  return { ok: true, detail: [`${program} ${ctx.manifest.minecraft.version} server ready in ${dir} (port ${serverSettings.port}, online-mode off).`, ...paperNotes].join(" ") };
}

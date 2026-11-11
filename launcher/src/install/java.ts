/** Install step `java`: the pinned Temurin JRE 21 zip unpacked to `<root>/runtime/java` (the local server's Java). */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DiskDeps } from "./disk.ts";
import { downloadFailureHint, downloadVerified } from "./download.ts";
import { freeSpaceHint, guardDownload, spaceGuardFor, type SpaceGuard } from "./space-guard.ts";
import { FILE_LOCKED_HINT, isFileLockError, stepFailure, type InstallContext, type StepResult } from "./step.ts";

const execFileAsync = promisify(execFile);

/** Records which zip the unpacked JRE came from, so a new manifest pin is told from an installed one without hashing. */
const PINNED_HASH_FILE = ".pinned-sha256";

/** The Windows JRE's launcher; the zip is the only JRE this ticket installs (Linux and macOS come with their own tickets). */
export function javaPath(root: string): string {
  return join(root, "runtime", "java", "bin", "java.exe");
}

/** `tar -xf`; on Windows the system `tar.exe` (bsdtar reads zips), never a GNU tar that Git for Windows may put on PATH. */
export function extractZipCommand(zip: string, destDir: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const command = platform === "win32" ? `${env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe` : "tar";
  return { command, args: ["-xf", zip, "-C", destDir] };
}

/** The archive could not be unpacked (`tar`) or is not the expected JRE (`layout`): the two have different next actions. */
class UnpackError extends Error {
  constructor(message: string, readonly reason: "tar" | "layout", options?: ErrorOptions) {
    super(message, options);
  }
}

async function extractZipWithTar(zip: string, destDir: string): Promise<void> {
  const { command, args } = extractZipCommand(zip, destDir);
  try {
    await execFileAsync(command, args, { windowsHide: true });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new UnpackError(`Cannot unpack ${zip} with ${command}: ${stderr || (error instanceof Error ? error.message : String(error))}`, "tar", { cause: error });
  }
}

/** The next action for a failed unpack or swap, by cause. */
function unpackFailureHint(error: unknown): string {
  if (isFileLockError(error)) return FILE_LOCKED_HINT;
  if (error instanceof UnpackError && error.reason === "layout") return "The Java download is not the expected JRE. Install the newest Mine AI release, whose pinned download may have changed.";
  if (error instanceof UnpackError) return "Windows 10 version 1803 or later is needed to unpack the download (tar.exe). If Windows is recent enough, run this step again.";
  return "Run this step again; if it repeats, report the error line above.";
}

export interface JavaDeps {
  readonly fetchImpl?: typeof fetch;
  readonly extractZip?: (zip: string, destDir: string) => Promise<void>;
  /** The free-space reads of the guard; the real disk when absent. */
  readonly disk?: DiskDeps;
}

/** The zip and the JRE it unpacks to sit in `<root>\runtime` together (the zip folder is removed after the unpack). */
function javaSpaceGuard(ctx: InstallContext, deps: JavaDeps, runtimeDir: string): SpaceGuard {
  return spaceGuardFor(ctx, deps.disk, freeSpaceHint(), (downloadBytes) => [
    { what: "Java's download", folder: runtimeDir, bytes: downloadBytes },
    { what: "Java", folder: runtimeDir, bytes: ctx.manifest.java.installedBytes },
  ]);
}

/** The folder holding `bin/java.exe` in an unpacked archive: the staging folder itself or its single top-level folder. */
async function findJreFolder(staging: string): Promise<string> {
  const candidates = [staging];
  const entries = await readdir(staging, { withFileTypes: true });
  if (entries.length === 1 && entries[0]!.isDirectory()) candidates.push(join(staging, entries[0]!.name));
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "bin", "java.exe"))) return candidate;
  }
  throw new UnpackError("The unpacked archive holds no bin/java.exe, so it is not the expected Temurin JRE zip.", "layout");
}

/** Puts `fresh` at `target`; the folder it replaces is kept until the move worked, and put back when it did not. */
async function replaceFolder(fresh: string, target: string): Promise<void> {
  const previous = `${target}.previous`;
  await rm(previous, { recursive: true, force: true });
  const hadPrevious = existsSync(target);
  if (hadPrevious) await rename(target, previous);
  try {
    await rename(fresh, target);
  } catch (error) {
    if (hadPrevious) await rename(previous, target);
    throw error;
  }
  await rm(previous, { recursive: true, force: true });
}

/** Whether the JRE under `<root>/runtime/java` was unpacked from the zip pinned by `sha256` (a step that would download it has nothing to do). */
export async function isPinnedJreInstalled(root: string, sha256: string): Promise<boolean> {
  if (!existsSync(javaPath(root))) return false;
  const pinned = await readFile(join(root, "runtime", "java", PINNED_HASH_FILE), "utf8").catch(() => "");
  return pinned.trim() === sha256;
}

/** Unpacks `zip` beside the target and swaps it in; the staging folder never outlives the call. */
async function unpackAndSwapIn(zip: string, runtimeDir: string, sha256: string, extractZip: NonNullable<JavaDeps["extractZip"]>): Promise<void> {
  const staging = join(runtimeDir, "java.staging");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await extractZip(zip, staging);
    const jre = await findJreFolder(staging);
    await writeFile(join(jre, PINNED_HASH_FILE), sha256);
    await replaceFolder(jre, join(runtimeDir, "java"));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Downloads (resumable, hashed) and unpacks the manifest's JRE; a JRE of the same pin already there is kept. */
export async function java(ctx: InstallContext, deps: JavaDeps = {}): Promise<StepResult> {
  const { url, sha256 } = ctx.manifest.java;
  if (await isPinnedJreInstalled(ctx.root, sha256)) return { ok: true, detail: `Java is already installed at ${javaPath(ctx.root)}.` };
  const runtimeDir = join(ctx.root, "runtime");
  const downloads = join(runtimeDir, "downloads");
  const zip = join(downloads, "java.zip");
  await mkdir(downloads, { recursive: true });
  try {
    const noRoom = await guardDownload(javaSpaceGuard(ctx, deps, runtimeDir), existsSync(zip), (beforeBody) =>
      downloadVerified(url, zip, { sha256 }, (fraction) => ctx.onProgress(fraction * 0.9, "Downloading Java"), deps.fetchImpl, undefined, { beforeBody }),
    );
    if (noRoom !== null) return noRoom;
  } catch (error) {
    return stepFailure(error, downloadFailureHint(error));
  }
  try {
    ctx.onProgress(0.9, "Unpacking Java");
    await unpackAndSwapIn(zip, runtimeDir, sha256, deps.extractZip ?? extractZipWithTar);
  } catch (error) {
    return stepFailure(error, unpackFailureHint(error));
  } finally {
    await rm(downloads, { recursive: true, force: true });
  }
  ctx.onProgress(1, "Java installed");
  return { ok: true, detail: `Java installed at ${javaPath(ctx.root)}.` };
}

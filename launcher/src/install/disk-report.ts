/**
 * What `mine-ai install disk` and `mine-ai doctor` say about disk space (spec 2026-11-06 "Installer improvements" D1,
 * D2): per drive, the free space and what the local AI model and a local Minecraft server would put there. It changes
 * nothing and downloads nothing; the sizes come from `HEAD` requests, the registry's manifest and `packaging/manifest.json`.
 * The step guards of each download (`checkSpace` in each step) stay the real stop: this report only tells the player early.
 */
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { checkSpace, DiskError, driveOf, freeBytes, gb, headSize, modelBytesToPull, realDiskDeps, realModelStoreDeps, type DiskDeps, type ModelStoreDeps, type SpaceNeed } from "./disk.ts";
import { isPinnedJreInstalled } from "./java.ts";
import { manifestFileParts, modelOnDisk, modelStore } from "./model.ts";
import { ollamaExeFor } from "./ollama.ts";
import { loadInstallState } from "./state.ts";
import { failure, type InstallContext, type StepFailure } from "./step.ts";

/** What the report needs from the machine and the network; the real ones are `realDiskReportDeps`, tests give their own. */
export interface DiskReportDeps {
  disk: DiskDeps;
  /** The `HEAD` requests for the download sizes. */
  fetchImpl: typeof fetch;
  /** The registry read and the model store's blobs. */
  modelStoreDeps: ModelStoreDeps;
  /** The `ollama.exe` found on this PC, null when there is none. May throw (a corrupt install state): that counts as none. */
  ollamaExe(): string | null;
  modelOnDisk(): boolean;
  /** The models folder the pull would use: the existing Ollama's, or the one a first install of ours would create. */
  modelStore(ollamaFound: boolean): string;
  pinnedJreInstalled(): Promise<boolean>;
  /** Where Ollama's own setup installs when `--dir` is not given. */
  defaultOllamaFolder: string;
}

export type DriveReport = { drive: string; freeBytes: number | null; needs: { what: string; bytes: number | null }[] };
export type DiskReport = { readonly ok: true; readonly detail: string; readonly short: boolean; readonly drives: DriveReport[] };

type Group = "model" | "server";
/** `choosable`: the player picks this folder (the Ollama folder row of the model page); the other folders are not theirs to move here. */
type GroupedNeed = SpaceNeed & { group: Group; choosable?: true };

const SUBJECT: Record<Group, string> = { model: "the local AI model", server: "a local Minecraft server" };
const UNREADABLE_HINT = "Check that the folders you chose are on drives that exist, then try again. Each install step checks the space itself before it downloads.";

/** Ollama's per-user install folder (`%LOCALAPPDATA%\Programs\Ollama`, where its own setup puts it without `/DIR=`); off Windows there is no such folder, so the data root stands in. */
export function defaultOllamaFolder(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string, root: string): string {
  if (platform !== "win32") return root;
  return win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "Programs", "Ollama");
}

/** The models folder a first install of ours uses: the recorded one of an earlier attempt, else `<root>\models` (`ollama.ts` `installOurOllama`). */
function firstInstallModelStore(root: string): string {
  try {
    return loadInstallState(root).ollamaModels ?? join(root, "models");
  } catch {
    return join(root, "models");
  }
}

export function realDiskReportDeps(ctx: InstallContext): DiskReportDeps {
  return {
    disk: realDiskDeps,
    fetchImpl: fetch,
    modelStoreDeps: realModelStoreDeps,
    ollamaExe: () => ollamaExeFor(ctx.root),
    modelOnDisk: () => modelOnDisk(ctx.root, ctx.manifest),
    modelStore: (ollamaFound) => (ollamaFound ? modelStore(ctx.root, ctx.manifest) : firstInstallModelStore(ctx.root)),
    pinnedJreInstalled: () => isPinnedJreInstalled(ctx.root, ctx.manifest.java.sha256),
    defaultOllamaFolder: defaultOllamaFolder(process.env, process.platform, homedir(), ctx.root),
  };
}

/** A lookup that fails must not stop a report: the `install gpu` step treats a throw as "none" the same way. */
export function orFallback<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * The needs of the local AI model and of a local server, with a size or null (unknown). An item that is already there
 * is a need of 0 bytes, so the drive still shows and the line can say "nothing to download". The requests go out together.
 */
async function collectNeeds(ctx: InstallContext, options: { dir: string | undefined; noModel: boolean }, deps: DiskReportDeps): Promise<GroupedNeed[]> {
  const { manifest, root } = ctx;
  const ollamaFound = orFallback(() => deps.ollamaExe(), null) !== null;
  const installOllama = !options.noModel && !ollamaFound;
  const pullModel = !options.noModel && !(ollamaFound && orFallback(() => deps.modelOnDisk(), false));
  const store = options.noModel ? "" : deps.modelStore(ollamaFound);
  const jar = join(root, "server", "server.jar");
  const javaInstalled = deps.pinnedJreInstalled();
  const [ollamaSetup, modelBytes, javaZip, jarBytes, isJavaInstalled] = await Promise.all([
    installOllama ? headSize(manifest.ollama.url, deps.fetchImpl) : 0,
    pullModel ? modelBytesToPull(manifestFileParts(manifest.ollama.model), store, deps.modelStoreDeps) : 0,
    javaInstalled.then((installed) => (installed ? 0 : headSize(manifest.java.url, deps.fetchImpl))),
    deps.disk.exists(jar) ? 0 : headSize(manifest.minecraft.jar.url, deps.fetchImpl),
    javaInstalled,
  ]);
  const runtime = join(root, "runtime");
  const ollama: GroupedNeed[] = installOllama
    ? [
        { group: "model", what: "Ollama", folder: runtime, bytes: ollamaSetup },
        { group: "model", what: "Ollama", folder: options.dir ?? deps.defaultOllamaFolder, bytes: manifest.ollama.installedBytes, choosable: true },
      ]
    : [];
  const model: GroupedNeed[] = options.noModel ? [] : [...ollama, { group: "model", what: "model", folder: store, bytes: modelBytes }];
  const java: GroupedNeed[] = isJavaInstalled
    ? [{ group: "server", what: "Java", folder: runtime, bytes: 0 }]
    : [{ group: "server", what: "Java", folder: runtime, bytes: javaZip }, { group: "server", what: "Java", folder: runtime, bytes: manifest.java.installedBytes }];
  return [...model, ...java, { group: "server", what: "server jar", folder: join(root, "server"), bytes: jarBytes }];
}

/** `driveOf` that never throws: a folder whose drive cannot be named is its own group (its free space then fails with the reason). */
function safeDriveOf(folder: string, deps: DiskDeps): string {
  try {
    return driveOf(folder, deps);
  } catch {
    return folder;
  }
}

function groupByDrive<T extends { folder: string }>(items: readonly T[], deps: DiskDeps): Map<string, T[]> {
  const byDrive = new Map<string, T[]>();
  for (const item of items) {
    const drive = safeDriveOf(item.folder, deps);
    byDrive.set(drive, [...(byDrive.get(drive) ?? []), item]);
  }
  return byDrive;
}

/** Free bytes of a drive, or the reason it cannot be read, in words for the player. */
async function readFree(folder: string, deps: DiskDeps): Promise<{ free: number } | { reason: string; driveMissing: boolean }> {
  try {
    return { free: await freeBytes(folder, deps) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return error instanceof DiskError ? { reason: message, driveMissing: true } : { reason: `The free space of ${folder} could not be read (${message}).`, driveMissing: false };
  }
}

type Part = { what: string; bytes: number; unknown: boolean };

/** The needs of one group on one drive, same-named parts added up (Ollama's setup file and its install are both "Ollama"). */
function partsOf(needs: readonly GroupedNeed[]): Part[] {
  const parts: Part[] = [];
  for (const need of needs) {
    const part = parts.find((candidate) => candidate.what === need.what) ?? parts[parts.push({ what: need.what, bytes: 0, unknown: false }) - 1]!;
    part.bytes += need.bytes ?? 0;
    part.unknown ||= need.bytes === null;
  }
  return parts;
}

const sizeText = (bytes: number, unknown: boolean): string => (!unknown ? gb(bytes) : bytes > 0 ? `at least ${gb(bytes)}` : "size unknown");
const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** One sentence for a group on a drive: what it needs there, with the parts when there are several, or that there is nothing to download. */
function groupSentence(group: Group, needs: readonly GroupedNeed[]): string {
  const parts = partsOf(needs);
  const total = parts.reduce((sum, part) => sum + part.bytes, 0);
  const unknown = parts.some((part) => part.unknown);
  if (total === 0 && !unknown) return `Nothing to download for ${SUBJECT[group]}.`;
  const shown = parts.filter((part) => part.bytes > 0 || part.unknown);
  const breakdown = shown.length > 1 ? ` (${shown.map((part) => `${part.what} ${sizeText(part.bytes, part.unknown)}`).join(", ")})` : "";
  if (total === 0) return `${capitalized(SUBJECT[group])}: size unknown${breakdown}.`;
  return `${capitalized(SUBJECT[group])} needs ${sizeText(total, unknown)} here${breakdown}.`;
}

type DriveRead = { drive: string; needs: GroupedNeed[]; free: Awaited<ReturnType<typeof readFree>>; short: boolean };

/**
 * One line for a drive. The next step is the one the player can take: "choose another Ollama folder" only when the drive
 * holds the folder of the Ollama row; the model store, the data folder and the server folder are not moved from here.
 * The sums count Ollama's setup file and Java's zip, which the steps delete after use, so a warning is "may not be enough";
 * the step guards (each download's own check) decide exactly.
 */
function driveLine({ drive, needs, free, short }: DriveRead, reserveBytes: number): string {
  const groups = (["model", "server"] as const).filter((group) => needs.some((need) => need.group === group));
  const chooseOllamaFolder = needs.some((need) => need.choosable) ? " or choose another Ollama folder" : "";
  if ("reason" in free) return `${free.reason} It is needed for ${groups.map((group) => SUBJECT[group]).join(" and ")}.${chooseOllamaFolder ? " Choose another Ollama folder." : ""}`;
  const sentences = groups.map((group) => groupSentence(group, needs.filter((need) => need.group === group)));
  const warning = short ? [`That may not be enough (Mine AI keeps ${gb(reserveBytes)} free): free some space on ${drive}${chooseOllamaFolder}.`] : [];
  return [`${drive} ${gb(free.free)} free.`, ...sentences, ...warning].join(" ");
}

/**
 * `install disk [--dir <ollama folder>] [--no-model]`: per drive the free space and the needs of the local AI model
 * (Ollama's setup and install when no Ollama is found, the model unless it is on disk) and of a local server (Java
 * unless the pinned one is installed, the jar unless it is there). `ok:true` with `short:true` when a drive is short
 * (the setup shows the text either way); `ok:false` only when no drive could be read. `noModel`: the GPU verdict is
 * remote, so no model and no Ollama line, and no registry or Ollama request.
 */
export async function diskReport(ctx: InstallContext, options: { dir: string | undefined; noModel: boolean }, deps: DiskReportDeps = realDiskReportDeps(ctx)): Promise<DiskReport | StepFailure> {
  const needs = await collectNeeds(ctx, options, deps);
  const reserve = ctx.manifest.disk.reserveBytes;
  const reads: DriveRead[] = [];
  for (const [drive, driveNeeds] of groupByDrive(needs, deps.disk)) {
    const free = await readFree(driveNeeds[0]!.folder, deps.disk);
    reads.push({ drive, needs: driveNeeds, free, short: "free" in free && (await checkSpace(driveNeeds, reserve, deps.disk)) !== null });
  }
  if (reads.every((read) => "reason" in read.free)) {
    return failure(`The free space of no drive could be read: ${reads.map((read) => ("reason" in read.free ? read.free.reason : "")).join(" ")}`, UNREADABLE_HINT);
  }
  return {
    ok: true,
    detail: reads.map((read) => driveLine(read, reserve)).join("\n"),
    short: reads.some((read) => read.short),
    drives: reads.map((read) => ({ drive: read.drive, freeBytes: "free" in read.free ? read.free.free : null, needs: read.needs.map(({ what, bytes }) => ({ what, bytes })) })),
  };
}

/** A folder Mine AI uses and what it is, for the doctor's list. */
export type NamedFolder = { what: string; folder: string };

/** The doctor's lines: `C: 115.1 GB free (app folder, data folder)`, one per drive, or `X: not found (Ollama models)`. No network. */
export async function driveLines(folders: readonly NamedFolder[], deps: DiskDeps): Promise<string[]> {
  return await Promise.all(
    [...groupByDrive(folders, deps)].map(async ([drive, group]) => {
      const labels = [...new Set(group.map((entry) => entry.what))].join(", ");
      const read = await readFree(group[0]!.folder, deps);
      if ("free" in read) return `${drive} ${gb(read.free)} free (${labels})`;
      return `${drive} ${read.driveMissing ? "not found" : "free space could not be read"} (${labels})`;
    }),
  );
}

/**
 * Free disk space for the install steps: what a drive has free, what a step will put on it (summed per drive, one reserve
 * per drive), and the size of each download read from its own answer (spec 2026-11-06 "Installer improvements" D1).
 * Sizes come from data (a response header, the registry's manifest, `packaging/manifest.json`), never from a table here.
 */
import { existsSync, statSync } from "node:fs";
import { readdir, stat, statfs } from "node:fs/promises";
import path, { join } from "node:path";
import { z } from "zod";
import { failure, type StepFailure } from "./step.ts";

/** The longest the registry's manifest read may take: a model's size is a hint, so the pull goes on without it. */
const REGISTRY_TIMEOUT_MS = 15_000;
/** The longest a `HEAD` for a download's size may take. */
const HEAD_TIMEOUT_MS = 10_000;

/** What the disk calls need from the machine; the real ones are `realDiskDeps`, tests give their own. */
export interface DiskDeps {
  /** Space available to this user: `bavail` blocks of `bsize` bytes (what `GetDiskFreeSpaceExW` calls `FreeBytesAvailableToCaller`). */
  statfs(path: string): Promise<{ bavail: bigint; bsize: bigint }>;
  exists(path: string): boolean;
  platform: NodeJS.Platform;
  /** The device number of an existing folder, used as the drive off Windows. */
  dev(path: string): string;
}

export const realDiskDeps: DiskDeps = {
  statfs: (folder) => statfs(folder, { bigint: true }),
  exists: existsSync,
  platform: process.platform,
  dev: (folder) => String(statSync(folder).dev),
};

/** A folder whose drive is not there: the step fails with this message and its own next action. */
export class DiskError extends Error {}

/** One thing a step will put on a drive; an unknown size (`bytes` null) counts 0. */
export type SpaceNeed = { what: string; folder: string; bytes: number | null };

/** A drive that cannot hold its needs plus the reserve; `needed` includes `reserve`. */
export type Shortfall = { drive: string; needed: number; free: number; reserve: number; whats: string[] };

/** Thrown by a download's `beforeBody` hook to stop it before the first byte, carrying what was short. */
export class DiskSpaceError extends Error {
  constructor(readonly shortfall: Shortfall) {
    super(spaceMessage(shortfall));
  }
}

/** `path.win32` for a Windows machine (also under a test's fake platform), `path.posix` otherwise. */
const pathFor = (deps: DiskDeps): typeof path.win32 => (deps.platform === "win32" ? path.win32 : path.posix);

/** The folder itself or its nearest parent that exists (a data root or an Ollama folder not created yet); null when no part of it does. */
export function nearestExisting(folder: string, deps: DiskDeps): string | null {
  const api = pathFor(deps);
  for (let current = api.resolve(folder); ; current = api.dirname(current)) {
    if (deps.exists(current)) return current;
    if (api.dirname(current) === current) return null;
  }
}

/** Bytes available to this user on the drive of `folder`, read from its nearest existing parent. */
export async function freeBytes(folder: string, deps: DiskDeps): Promise<number> {
  const existing = nearestExisting(folder, deps);
  if (existing === null) throw new DiskError(`The drive of ${folder} does not exist.`);
  const { bavail, bsize } = await deps.statfs(existing);
  return Number(bavail * bsize);
}

/**
 * The drive `folder` is on, as the texts name it: `C:` (upper-cased) or `\\SERVER\SHARE` on Windows, the device number
 * elsewhere. A volume mounted in a folder counts as its parent drive (rare; not handled).
 */
export function driveOf(folder: string, deps: DiskDeps): string {
  if (deps.platform === "win32") return path.win32.parse(path.win32.resolve(folder)).root.replace(/\\$/u, "").toUpperCase();
  const existing = nearestExisting(folder, deps);
  if (existing === null) throw new DiskError(`The drive of ${folder} does not exist.`);
  return deps.dev(existing);
}

/**
 * The first drive that cannot hold the needs put on it plus `reserveBytes` (counted once per drive), else null. Needs of
 * unknown or zero size are left out: with no size known nothing is checked and the step's own error stays the guard.
 * Throws `DiskError` when a drive that has a need does not exist; the step turns it into its failure.
 */
export async function checkSpace(needs: readonly SpaceNeed[], reserveBytes: number, deps: DiskDeps): Promise<Shortfall | null> {
  const byDrive = new Map<string, SpaceNeed[]>();
  for (const need of needs.filter((candidate) => (candidate.bytes ?? 0) > 0)) {
    const drive = driveOf(need.folder, deps);
    byDrive.set(drive, [...(byDrive.get(drive) ?? []), need]);
  }
  for (const [drive, group] of byDrive) {
    const needed = group.reduce((sum, need) => sum + (need.bytes ?? 0), 0) + reserveBytes;
    const free = await freeBytes(group[0].folder, deps);
    if (free < needed) return { drive, needed, free, reserve: reserveBytes, whats: group.map((need) => need.what) };
  }
  return null;
}

/** Bytes over 1024^3 with one decimal and "GB": what Windows Explorer shows for the same number. */
export function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function spaceMessage(short: Shortfall): string {
  return `Not enough free space on ${short.drive} for ${short.whats.join(" and ")}: it needs ${gb(short.needed)} (including the ${gb(short.reserve)} Mine AI keeps free) and ${short.drive} has ${gb(short.free)} free.`;
}

/** The step failure for a short drive; `hint` is the step's next action. */
export function spaceFailure(short: Shortfall, hint: string): StepFailure {
  return failure(spaceMessage(short), hint);
}

/** What the model-size read needs: the registry, and the model store's blobs folder. */
export interface ModelStoreDeps {
  fetchImpl: typeof fetch;
  exists(path: string): boolean;
  sizeOf(path: string): Promise<number>;
  /** The names in a folder; empty when it is missing. */
  listDir(path: string): Promise<string[]>;
  /** The bound of the registry read (default 15 s); tests shorten it. */
  timeoutMs?: number;
}

export const realModelStoreDeps: ModelStoreDeps = {
  fetchImpl: fetch,
  exists: existsSync,
  sizeOf: async (file) => (await stat(file)).size,
  listDir: (folder) => readdir(folder).catch(() => []),
};

const blobSchema = z.object({ digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u), size: z.number().int().nonnegative() });
const registryManifestSchema = z.object({ config: blobSchema, layers: z.array(blobSchema) });

/** Bytes of `blob` the store lacks: 0 for a complete `blobs/sha256-<hex>`, else its size minus its `-partial*` files (a resumed pull). */
async function missingBytes(blob: z.infer<typeof blobSchema>, blobsDir: string, names: readonly string[], deps: ModelStoreDeps): Promise<number> {
  const file = blob.digest.replace(":", "-");
  if (deps.exists(join(blobsDir, file))) return 0;
  let partial = 0;
  for (const name of names.filter((candidate) => candidate.startsWith(`${file}-partial`))) partial += await deps.sizeOf(join(blobsDir, name));
  return Math.max(0, blob.size - partial);
}

/**
 * Bytes a pull of the model would still download: the registry's manifest of the tag (`fileParts` as `manifestFileParts`
 * gives them: host, namespace, name, tag), the config and every layer, minus what `store` holds. Null on any failure
 * (registry down, not JSON, a store that cannot be read): the pull goes on and Ollama's own error remains the guard.
 */
export async function modelBytesToPull(fileParts: readonly string[], store: string, deps: ModelStoreDeps = realModelStoreDeps): Promise<number | null> {
  const [host, ...rest] = fileParts;
  const tag = rest.pop();
  try {
    const response = await deps.fetchImpl(`https://${host}/v2/${rest.join("/")}/manifests/${tag}`, {
      headers: { accept: "application/vnd.docker.distribution.manifest.v2+json" },
      signal: AbortSignal.timeout(deps.timeoutMs ?? REGISTRY_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const manifest = registryManifestSchema.parse(JSON.parse(await response.text()));
    const blobsDir = join(store, "blobs");
    const names = await deps.listDir(blobsDir);
    let total = 0;
    for (const blob of [manifest.config, ...manifest.layers]) total += await missingBytes(blob, blobsDir, names, deps);
    return total;
  } catch {
    return null;
  }
}

/** The `content-length` of `url` by `HEAD` (redirects followed), or null when it gives none or cannot be reached in time. */
export async function headSize(url: string, fetchImpl: typeof fetch, timeoutMs: number = HEAD_TIMEOUT_MS): Promise<number | null> {
  try {
    const response = await fetchImpl(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const length = Number(response.headers.get("content-length"));
    return Number.isFinite(length) && length > 0 ? length : null;
  } catch {
    return null;
  }
}

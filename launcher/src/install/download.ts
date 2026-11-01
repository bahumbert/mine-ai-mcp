/** Pinned downloads: written to `<dest>.part`, resumed with `Range`, hashed, then renamed to `<dest>`. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rename, rm, stat } from "node:fs/promises";
import { basename } from "node:path";
import { fetchErrorText } from "../fetch-error.ts";
import { idleWatch, type IdleWatch } from "./idle-watch.ts";
import { FILE_LOCKED_HINT, isFileLockError } from "./step.ts";

export type DownloadHash = { readonly sha256: string } | { readonly sha1: string };

/**
 * A connection with no data for this long is cut (the `.part` stays for the next call). Bun has no idle timeout of its
 * own: a server that stops mid-body left `downloadVerified` pending for 353 s and more (measured in the W3a review).
 */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

/** Why a download failed, so a step can tell the user the right next action (`downloadFailureHint`). */
export type DownloadFailureKind = "checksum" | "http" | "incomplete" | "stalled" | "network";

export class DownloadError extends Error {
  constructor(message: string, readonly kind: DownloadFailureKind, options?: ErrorOptions) {
    super(message, options);
  }
}

/** The next action for the user after a failed download: one per cause, true whether or not a `.part` was kept. */
export function downloadFailureHint(error: unknown): string {
  if (isFileLockError(error)) return FILE_LOCKED_HINT;
  const kind = error instanceof DownloadError ? error.kind : null;
  if (kind === "checksum") {
    return "The file did not match its pinned checksum and was deleted. Run this step again; if it repeats, install the newest Mine AI release, since the download may have moved.";
  }
  if (kind === "http") return "The download address answered with an error. Run this step again later; if it repeats, install the newest Mine AI release.";
  return "Check the internet connection and run this step again: a cut download continues where it stopped.";
}

/** Hash of the file at `path`, streamed (the Ollama installer is over 1 GB). */
async function hashFile(path: string, algorithm: "sha256" | "sha1"): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function expectedHash(hash: DownloadHash): { algorithm: "sha256" | "sha1"; expected: string } {
  return "sha256" in hash ? { algorithm: "sha256", expected: hash.sha256 } : { algorithm: "sha1", expected: hash.sha1 };
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/** Total size of the whole file from a 200 (`Content-Length`) or a 206 (`Content-Range: bytes a-b/total`), else null. */
function totalBytesOf(response: Response, resumedFrom: number): number | null {
  const range = /\/(\d+)$/u.exec(response.headers.get("content-range") ?? "");
  if (range !== null) return Number(range[1]);
  const length = Number(response.headers.get("content-length"));
  return Number.isFinite(length) && length > 0 ? resumedFrom + length : null;
}

class RangeNotSatisfiable extends Error {}

/** "server.jar from piston-data.mojang.com": what is downloading and from where; no path, query string or credentials of the URL. */
function describeSource(url: string, partPath: string): string {
  return `${basename(partPath).replace(/\.part$/u, "")} from ${new URL(url).host}`;
}

/** Bun's own connection errors ("Unable to connect. Is the computer able to access the url?") name neither file nor host. */
function networkFailure(source: string, error: unknown): DownloadError {
  return new DownloadError(`Cannot download ${source}: ${fetchErrorText(error)}`, "network", { cause: error });
}

/** The chunks of a body; a read that fails on the network (not a write to disk) is a `network` failure naming `source`. */
async function* bodyChunks(response: Response, source: string): AsyncGenerator<Uint8Array> {
  try {
    yield* response.body as unknown as AsyncIterable<Uint8Array>;
  } catch (error) {
    throw networkFailure(source, error);
  }
}

/** GET `url`, continuing a `.part` of `partSize` bytes when the server honours `Range`; returns the byte offset the body starts at. */
async function requestBody(url: string, partSize: number, fetchImpl: typeof fetch, idle: IdleWatch, source: string): Promise<{ response: Response; startsAt: number }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: idle.signal, ...(partSize > 0 ? { headers: { range: `bytes=${partSize}-` } } : {}) });
  } catch (error) {
    throw networkFailure(source, error);
  }
  if (response.status === 206) return { response, startsAt: partSize };
  if (response.status === 416) {
    // The .part is longer than the file (a changed pin): nothing to continue.
    await response.body?.cancel();
    throw new RangeNotSatisfiable();
  }
  if (!response.ok) throw new DownloadError(`GET ${url}: HTTP ${response.status} ${response.statusText}`.trimEnd(), "http");
  return { response, startsAt: 0 };
}

/** Appends the body to the .part. A body that ends before the announced size keeps the .part and fails, so the next call resumes. */
async function writeBody(url: string, response: Response, partPath: string, startsAt: number, onProgress: ((fraction: number) => void) | undefined, idle: IdleWatch, source: string): Promise<void> {
  const total = totalBytesOf(response, startsAt);
  const file = await open(partPath, startsAt > 0 ? "a" : "w");
  let written = startsAt;
  try {
    for await (const chunk of bodyChunks(response, source)) {
      idle.arm();
      await file.write(chunk);
      written += chunk.length;
      if (total !== null) onProgress?.(Math.min(written / total, 1));
    }
  } finally {
    await file.close();
  }
  if (total !== null && written < total) {
    throw new DownloadError(`Download of ${url} ended early (${written} of ${total} bytes). Run the step again: it continues from the part already downloaded.`, "incomplete");
  }
}

/** Fetches `url` into `partPath`, resuming it when possible; a stall ends it with a `stalled` error and keeps the part. */
async function fetchToPart(url: string, partPath: string, fetchImpl: typeof fetch, onProgress: ((fraction: number) => void) | undefined, idleTimeoutMs: number): Promise<void> {
  const idle = idleWatch(idleTimeoutMs);
  idle.arm();
  const source = describeSource(url, partPath);
  try {
    let request: { response: Response; startsAt: number };
    try {
      request = await requestBody(url, (await sizeOf(partPath)) ?? 0, fetchImpl, idle, source);
    } catch (error) {
      if (!(error instanceof RangeNotSatisfiable)) throw error;
      await rm(partPath, { force: true });
      request = await requestBody(url, 0, fetchImpl, idle, source);
    }
    await writeBody(url, request.response, partPath, request.startsAt, onProgress, idle, source);
  } catch (error) {
    if (!idle.fired()) throw error;
    throw new DownloadError(`Download of ${url} stalled: no data for ${idleTimeoutMs} ms. Run the step again: it continues from the part already downloaded.`, "stalled", { cause: error });
  } finally {
    idle.stop();
  }
}

/**
 * Makes `dest` a file with the pinned hash. A `dest` already right makes no request. A cut or stalled download leaves
 * its `.part` for the next call to continue; a wrong hash deletes the `.part` and fails with the URL and both hashes.
 * `onProgress` gets 0..1 while the size is known.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  hash: DownloadHash,
  onProgress?: (fraction: number) => void,
  fetchImpl: typeof fetch = fetch,
  idleTimeoutMs: number = DOWNLOAD_IDLE_TIMEOUT_MS,
): Promise<void> {
  const { algorithm, expected } = expectedHash(hash);
  const partPath = `${dest}.part`;
  if ((await sizeOf(dest)) !== null) {
    if ((await hashFile(dest, algorithm)) === expected) return;
    await rm(dest, { force: true });
  }
  await fetchToPart(url, partPath, fetchImpl, onProgress, idleTimeoutMs);
  const actual = await hashFile(partPath, algorithm);
  if (actual !== expected) {
    await rm(partPath, { force: true });
    throw new DownloadError(`Checksum mismatch for ${url}: expected ${algorithm} ${expected}, got ${actual}. The file was deleted.`, "checksum");
  }
  await rename(partPath, dest);
  onProgress?.(1);
}

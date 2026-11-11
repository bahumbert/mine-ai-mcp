/**
 * The free-space guard of a download step (spec 2026-11-06 "Installer improvements" D1, "Step guards"): the step says what a
 * download of N bytes puts on which folder; the guard checks it through the download's `beforeBody` hook, or at once when the
 * file is already there (`downloadVerified` then makes no request, so the hook would never run).
 */
import { checkSpace, DiskError, DiskSpaceError, realDiskDeps, spaceFailure, type DiskDeps, type Shortfall, type SpaceNeed } from "./disk.ts";
import type { DownloadOptions } from "./download.ts";
import { failure, type InstallContext, type StepFailure } from "./step.ts";

/** What a download step checks; `needs` is asked again for each size (the hook's, or 0 for a file already there). */
export interface SpaceGuard {
  disk: DiskDeps;
  reserveBytes: number;
  /** Everything the step puts on a drive when the download is `downloadBytes` long: the download and what it becomes. */
  needs(downloadBytes: number): SpaceNeed[];
  /** The next action after a short drive (it names the drive): see `freeSpaceHint`. */
  hint(short: Shortfall): string;
}

/** The guard of a step: the manifest's reserve, the step's disk reads (the real disk when a test gives none), and its needs and hint. */
export function spaceGuardFor(ctx: InstallContext, disk: DiskDeps | undefined, hint: SpaceGuard["hint"], needs: SpaceGuard["needs"]): SpaceGuard {
  return { disk: disk ?? realDiskDeps, reserveBytes: ctx.manifest.disk.reserveBytes, hint, needs };
}

/** The hint of most steps: free space on the drive named, optionally with another way out ("choose another Ollama folder"). */
export function freeSpaceHint(alternative?: string): SpaceGuard["hint"] {
  return (short) => `Free some space on ${short.drive}${alternative === undefined ? "" : `, or ${alternative}`}, then run the step again.`;
}

/** The hook `downloadVerified` awaits once the size is known and before the first byte. */
export type BeforeBody = NonNullable<DownloadOptions["beforeBody"]>;

/** The next action for a drive that is not there (a short drive's hint would send the player to free space on nothing). */
const MISSING_DRIVE_HINT = "Connect that drive or choose a folder on a drive that exists, then run the step again.";

/**
 * Throws `DiskSpaceError` for a short drive and `DiskError` for a missing one. A drive that cannot be read at all (EIO, no
 * right to ask a network share) throws nothing: the size check cannot run, and with no size known the download's own error
 * stays the guard.
 */
async function assertFits(guard: SpaceGuard, downloadBytes: number): Promise<void> {
  let short: Shortfall | null;
  try {
    short = await checkSpace(guard.needs(downloadBytes), guard.reserveBytes, guard.disk);
  } catch (error) {
    if (error instanceof DiskError) throw error;
    return;
  }
  if (short !== null) throw new DiskSpaceError(short);
}

/** The step failure for an error `assertFits` threw (a short drive, a missing drive); any other error is not about space and is thrown again. */
function failureOfSpaceError(guard: SpaceGuard, error: unknown): StepFailure {
  if (error instanceof DiskSpaceError) return spaceFailure(error.shortfall, guard.hint(error.shortfall));
  if (error instanceof DiskError) return failure(error.message, MISSING_DRIVE_HINT);
  throw error;
}

/** Checks the guard's needs for a download of `downloadBytes`: the step's failure when a drive is short or missing, else null. */
export async function failureIfNoRoom(guard: SpaceGuard, downloadBytes: number): Promise<StepFailure | null> {
  try {
    await assertFits(guard, downloadBytes);
    return null;
  } catch (error) {
    return failureOfSpaceError(guard, error);
  }
}

/**
 * Runs `download` with a `beforeBody` hook that stops it when the drive cannot hold the rest of the file and what it becomes.
 * A file already there (`fileIsThere`) is checked first with 0 download bytes. Returns the step's failure for a short or
 * missing drive, null when the download ran; any other error is the download's own and is thrown.
 */
export async function guardDownload(guard: SpaceGuard, fileIsThere: boolean, download: (beforeBody: BeforeBody) => Promise<void>): Promise<StepFailure | null> {
  if (fileIsThere) {
    const failed = await failureIfNoRoom(guard, 0);
    if (failed !== null) return failed;
  }
  try {
    await download((totalBytes, startsAt) => assertFits(guard, totalBytes - startsAt));
    return null;
  } catch (error) {
    return failureOfSpaceError(guard, error);
  }
}
